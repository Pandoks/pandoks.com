package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	// NOTE: a rollout overlaps up to 4 pods, and 4×5 fits the 25 Postgres connections PgDog leaves free
	databaseConnections = 5
	// NOTE: one connection holds LISTEN and one always stays free for the API
	jobWorkers       = databaseConnections - 2
	databaseTimeout  = 5 * time.Second
	recipientsPerJob = 500
	sendConcurrency  = 1000
	pollInterval     = time.Second
	maxAttempts      = 5
)

type notification struct {
	App      string          `json:"app"`
	UserIDs  []string        `json:"user_ids,omitempty"`
	Tokens   []string        `json:"tokens,omitempty"`
	PushType string          `json:"push_type"`
	APNs     json.RawMessage `json:"apns,omitempty"`
	FCM      json.RawMessage `json:"fcm,omitempty"`
	SendAt   time.Time       `json:"send_at,omitzero"`
	Attempt  int             `json:"attempt,omitempty"`
}

type device struct{ Token, Platform, APNsEnvironment string }

// sender delivers a notification to one device through its platform's provider.
type sender interface {
	send(ctx context.Context, device device, job notification) result
}

type outcome int

const (
	delivered outcome = iota
	unregistered
	invalidArgument
	retryable
	failed
)

type result struct {
	outcome    outcome
	reason     string
	retryAfter time.Duration
}

// claimedJob is a job whose row lock a worker holds, with the results of its sends.
type claimedJob struct {
	notification
	id, notificationID int64
	devices            int

	mutex              sync.Mutex
	delivered          int
	fcmDelivered       bool
	unregisteredTokens []string
	invalidFCMTokens   []string
	retryTokens        []string
	unsentTokens       []string
	retryAfter         time.Duration
	failures           map[string]int
}

// enqueue stores the notification as jobs of at most recipientsPerJob recipients, so a fan-out
// spreads across every worker, and wakes a worker of this replica.
func (service *service) enqueue(ctx context.Context, request notification) (int64, error) {
	var jobs []notification
	for userIDs := range slices.Chunk(request.UserIDs, recipientsPerJob) {
		job := request
		job.UserIDs, job.Tokens = userIDs, nil
		jobs = append(jobs, job)
	}
	for tokens := range slices.Chunk(request.Tokens, recipientsPerJob) {
		job := request
		job.UserIDs, job.Tokens = nil, tokens
		jobs = append(jobs, job)
	}
	var sendAt *time.Time
	if !request.SendAt.IsZero() {
		sendAt = &request.SendAt
	}

	var id int64
	err := service.database.QueryRow(ctx, `
		WITH notification AS MATERIALIZED (SELECT nextval('push_notification_ids') AS id),
		inserted AS (
		  INSERT INTO push_jobs (notification_id, send_at, job)
		  SELECT notification.id, coalesce($1, now()), job FROM notification, unnest($2::jsonb[]) AS job
		)
		SELECT notification.id, CASE WHEN $3 THEN pg_notify('push_jobs', '') END FROM notification`,
		// NOTE: NOTIFY serializes every notifying commit, so only a fan-out wakes the other replicas
		sendAt, jobs, len(jobs) > 1,
	).Scan(&id, nil)
	if err == nil {
		service.wakeWorker()
	}
	return id, err
}

// listen wakes a worker for every fan-out, and every pollInterval for jobs coming due.
func (service *service) listen(ctx context.Context) {
	for ctx.Err() == nil {
		err := service.waitForJobs(ctx)
		if ctx.Err() == nil {
			slog.Error("listen for jobs", "error", err)
			time.Sleep(pollInterval)
		}
	}
}

func (service *service) waitForJobs(ctx context.Context) error {
	listenContext, cancel := context.WithTimeout(ctx, databaseTimeout)
	defer cancel()
	connection, err := service.database.Acquire(listenContext)
	if err != nil {
		return err
	}
	// NOTE: closed before release, so the pool replaces it instead of handing out a listening connection
	defer func() {
		_ = connection.Conn().Close(context.WithoutCancel(ctx))
		connection.Release()
	}()
	if _, err := connection.Exec(listenContext, "LISTEN push_jobs"); err != nil {
		return err
	}
	for {
		service.wakeWorker()
		waitContext, cancel := context.WithTimeout(ctx, pollInterval)
		_, err := connection.Conn().WaitForNotification(waitContext)
		cancel()
		if err != nil && (ctx.Err() != nil || waitContext.Err() == nil) {
			return err
		}
	}
}

func (service *service) wakeWorker() {
	select {
	case service.wake <- struct{}{}:
	default:
	}
}

// work delivers due jobs until none are left, then waits to be woken.
func (service *service) work(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-service.wake:
		}
		for ctx.Err() == nil && service.deliverDueJobs(ctx) {
		}
	}
}

// deliverDueJobs claims due jobs until it holds recipientsPerJob recipients, starting each job's
// sends as soon as it's claimed, and deletes them in the same transaction, so a crash before the
// commit leaves them to another worker.
func (service *service) deliverDueJobs(shutdown context.Context) bool {
	startedAt := time.Now()
	ctx := context.WithoutCancel(shutdown)
	beginContext, cancel := context.WithTimeout(ctx, databaseTimeout)
	transaction, err := service.database.Begin(beginContext)
	cancel()
	if err != nil {
		slog.Error("claim job", "error", err)
		return false
	}
	defer func() {
		rollbackContext, cancel := context.WithTimeout(ctx, databaseTimeout)
		defer cancel()
		_ = transaction.Rollback(rollbackContext)
	}()

	var (
		jobs []*claimedJob
		// NOTE: empty, not nil: pgx sends nil as NULL, and id <> ALL(NULL) matches nothing
		jobIDs     = []int64{}
		sends      sync.WaitGroup
		recipients int
		claimError error
	)
	for recipients < recipientsPerJob && shutdown.Err() == nil {
		var (
			job     *claimedJob
			devices []device
		)
		job, devices, claimError = claimJob(ctx, transaction, jobIDs, recipientsPerJob-recipients)
		if claimError != nil {
			break
		}
		if len(jobs) == 0 {
			service.wakeWorker()
		}
		jobs, jobIDs = append(jobs, job), append(jobIDs, job.id)
		recipients += len(job.UserIDs) + len(job.Tokens)
		service.send(shutdown, &sends, job, devices)
	}
	sends.Wait()
	if claimError != nil && !errors.Is(claimError, pgx.ErrNoRows) {
		slog.Error("claim job", "error", claimError)
		return false
	}
	if len(jobs) == 0 {
		return false
	}

	if err := commitJobs(ctx, transaction, startedAt, jobIDs, jobs); err != nil {
		slog.Error("deliver jobs", "error", err)
		return false
	}
	for _, job := range jobs {
		slog.Info("delivered job",
			"app", job.App, "push_type", job.PushType, "attempt", job.Attempt, "devices", job.devices,
			"delivered", job.delivered, "unregistered", len(job.unregisteredTokens), "retrying", len(job.retryTokens),
			"requeued", len(job.unsentTokens), "failures", job.failures, "duration", time.Since(startedAt).String(),
		)
	}
	return true
}

// claimJob locks the next due job of at most maxRecipients recipients and finds its devices.
func claimJob(ctx context.Context, transaction pgx.Tx, claimedIDs []int64, maxRecipients int) (*claimedJob, []device, error) {
	ctx, cancel := context.WithTimeout(ctx, databaseTimeout)
	defer cancel()
	job := &claimedJob{failures: map[string]int{}}
	err := transaction.QueryRow(ctx, `
		SELECT id, notification_id, job FROM push_jobs
		WHERE send_at <= now() AND id <> ALL($1) AND coalesce(jsonb_array_length(job->'user_ids'), 0) + coalesce(jsonb_array_length(job->'tokens'), 0) <= $2
		ORDER BY send_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
		// NOTE: SKIP LOCKED skips only other transactions' locks
		claimedIDs, maxRecipients,
	).Scan(&job.id, &job.notificationID, &job.notification)
	if err != nil {
		return nil, nil, err
	}
	kind := "device"
	if job.PushType == "liveactivity" {
		kind = "liveactivity"
	}
	rows, _ := transaction.Query(ctx,
		`SELECT token, platform, apns_environment FROM push_devices WHERE app = $1 AND kind = $2 AND (user_id = ANY($3) OR token = ANY($4))`,
		job.App, kind, job.UserIDs, job.Tokens,
	)
	devices, err := pgx.CollectRows(rows, pgx.RowToStructByPos[device])
	return job, devices, err
}

// send starts a send to every device the job has a payload for. Once shutdown is done it starts no
// more and leaves the rest to be requeued, so a stopping replica commits before it's killed instead
// of leaving the whole job to be sent again.
func (service *service) send(shutdown context.Context, sends *sync.WaitGroup, job *claimedJob, devices []device) {
	job.devices = len(devices)
	for index, device := range devices {
		if (device.Platform == "ios" && job.APNs == nil) || (device.Platform == "android" && job.FCM == nil) {
			continue
		}
		select {
		case service.sends <- struct{}{}:
		case <-shutdown.Done():
			for _, unsent := range devices[index:] {
				job.unsentTokens = append(job.unsentTokens, unsent.Token)
			}
			return
		}
		sends.Go(func() {
			defer func() { <-service.sends }()
			job.record(device, service.senders[device.Platform].send(context.WithoutCancel(shutdown), device, job.notification))
		})
	}
}

func (job *claimedJob) record(device device, result result) {
	job.mutex.Lock()
	defer job.mutex.Unlock()
	switch result.outcome {
	case delivered:
		job.delivered++
		job.fcmDelivered = job.fcmDelivered || device.Platform == "android"
	case unregistered:
		job.unregisteredTokens = append(job.unregisteredTokens, device.Token)
	case invalidArgument:
		job.invalidFCMTokens = append(job.invalidFCMTokens, device.Token)
	case retryable:
		job.retryTokens = append(job.retryTokens, device.Token)
		job.retryAfter = max(job.retryAfter, result.retryAfter)
	case failed:
	}
	if result.outcome != delivered {
		job.failures[result.reason]++
	}
}

// commitJobs removes unregistered tokens, requeues unsent and retryable sends, and deletes the jobs.
func commitJobs(ctx context.Context, transaction pgx.Tx, startedAt time.Time, jobIDs []int64, jobs []*claimedJob) error {
	ctx, cancel := context.WithTimeout(ctx, databaseTimeout)
	defer cancel()
	var (
		unregisteredTokens []string
		notificationIDs    []int64
		sendAts            []time.Time
		requeued           []notification
	)
	requeue := func(job *claimedJob, sendAt time.Time, attempt int, tokens []string) {
		next := job.notification
		next.UserIDs, next.Tokens, next.Attempt = nil, tokens, attempt
		notificationIDs = append(notificationIDs, job.notificationID)
		sendAts = append(sendAts, sendAt)
		requeued = append(requeued, next)
	}
	for _, job := range jobs {
		// NOTE: another token taking the same FCM message proves the message valid, so the token is not
		if job.fcmDelivered {
			job.unregisteredTokens = append(job.unregisteredTokens, job.invalidFCMTokens...)
		}
		unregisteredTokens = append(unregisteredTokens, job.unregisteredTokens...)
		if len(job.unsentTokens) > 0 {
			requeue(job, time.Now(), job.Attempt, job.unsentTokens)
		}
		if len(job.retryTokens) > 0 && job.Attempt+1 < maxAttempts {
			requeue(job, time.Now().Add(max(job.retryAfter, time.Second)<<job.Attempt), job.Attempt+1, job.retryTokens)
		}
	}

	// NOTE: a bookkeeping error is logged instead of rolling back the jobs and repeating their sends
	if len(unregisteredTokens)+len(requeued) > 0 {
		err := pgx.BeginFunc(ctx, transaction, func(savepoint pgx.Tx) error {
			batch := &pgx.Batch{}
			// NOTE: a device that registered again after its job started keeps its token
			batch.Queue(`DELETE FROM push_devices WHERE token = ANY($1) AND updated_at < $2`, unregisteredTokens, startedAt)
			batch.Queue(`INSERT INTO push_jobs (notification_id, send_at, job) SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::jsonb[])`,
				notificationIDs, sendAts, requeued)
			return savepoint.SendBatch(ctx, batch).Close()
		})
		if err != nil {
			slog.Error("record job results", "error", err)
		}
	}
	if _, err := transaction.Exec(ctx, `DELETE FROM push_jobs WHERE id = ANY($1)`, jobIDs); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}
