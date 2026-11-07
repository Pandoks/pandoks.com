package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"queue"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	// NOTE: a rollout runs up to 4 pods, 2 draining beside 2 new, and 4×5 fits the 25 connections PgDog leaves free
	databaseConnections = 5
	// NOTE: two full jobs fill the send slots, so more workers only speed up small jobs. A job uses a
	// connection only briefly to claim, read its devices, heartbeat, and finish, never across its sends, so
	// the workers can far outnumber the connections LISTEN leaves them and the API
	jobWorkers       = 32
	databaseTimeout  = 5 * time.Second
	pushQueue        = "push"
	recipientsPerJob = 500
	sendConcurrency  = 1000
	maxAttempts      = 5
	// NOTE: a later retry would deliver a stale alert, so the send fails instead
	maxRetryDelay = 8 * time.Minute
	// NOTE: a failed connection retries over 2.5 minutes, so a short network outage doesn't drop the send
	transportBackoff = 10 * time.Second
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
	outcome outcome
	reason  string
	// backoff is the first retry's delay, doubled on each later one; retryAfter is the provider's own delay
	backoff, retryAfter time.Duration
}

// claimedJob is a job whose lease a worker holds, with the results of its sends.
type claimedJob struct {
	notification
	notificationID string
	// claimedAt is the database's clock before the sends, so a device that registers again during them keeps its token
	claimedAt time.Time
	devices   int

	mutex              sync.Mutex
	delivered          int
	fcmDelivered       bool
	unregisteredTokens []string
	invalidFCMTokens   []string
	retryTokens        []string
	unsentTokens       []string
	retryDelay         time.Duration
	failures           map[string]int
}

// enqueue stores the notification as jobs of at most recipientsPerJob recipients, so a fan-out
// spreads across every worker.
func (service *service) enqueue(ctx context.Context, request notification) (int64, error) {
	var jobs []notification
	// NOTE: a recipient repeated in two jobs would get it twice
	slices.Sort(request.UserIDs)
	slices.Sort(request.Tokens)
	for userIDs := range slices.Chunk(slices.Compact(request.UserIDs), recipientsPerJob) {
		job := request
		job.UserIDs, job.Tokens = userIDs, nil
		jobs = append(jobs, job)
	}
	for tokens := range slices.Chunk(slices.Compact(request.Tokens), recipientsPerJob) {
		job := request
		job.UserIDs, job.Tokens = nil, tokens
		jobs = append(jobs, job)
	}

	transaction, err := service.database.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var id int64
	if err := transaction.QueryRow(ctx, `SELECT nextval('push_notification_ids')`).Scan(&id); err != nil {
		return 0, err
	}
	for _, job := range jobs {
		options := queue.EnqueueOptions{RunAt: request.SendAt, GroupKey: strconv.FormatInt(id, 10)}
		if _, err := queue.Enqueue(ctx, transaction, pushQueue, job, options); err != nil {
			return 0, err
		}
	}
	return id, transaction.Commit(ctx)
}

// deliver sends a job to its devices, then removes unregistered tokens, requeues unsent and
// retryable sends, and completes the job in one transaction, so a worker that dies before the
// commit leaves the whole job to another one once its lease runs out.
func (service *service) deliver(ctx context.Context, queued *queue.Job) error {
	startedAt := time.Now()
	job := &claimedJob{notificationID: *queued.GroupKey, failures: map[string]int{}}
	if err := json.Unmarshal(queued.Payload, &job.notification); err != nil {
		return queue.Permanent(err)
	}
	devices, err := service.findDevices(context.WithoutCancel(ctx), job)
	if err != nil {
		slog.Error("find devices", "error", err)
		return err
	}
	var sends sync.WaitGroup
	service.send(ctx, &sends, job, devices)
	sends.Wait()
	if err := service.finish(context.WithoutCancel(ctx), queued, job); err != nil {
		slog.Error("finish job", "error", err)
		return err
	}
	slog.Info("delivered job",
		"app", job.App, "push_type", job.PushType, "attempt", job.Attempt, "devices", job.devices,
		"delivered", job.delivered, "unregistered", len(job.unregisteredTokens), "retrying", len(job.retryTokens),
		"requeued", len(job.unsentTokens), "failures", job.failures, "duration", time.Since(startedAt).String(),
	)
	return nil
}

// findDevices reads the job's devices and the database's clock.
func (service *service) findDevices(ctx context.Context, job *claimedJob) ([]device, error) {
	ctx, cancel := context.WithTimeout(ctx, databaseTimeout)
	defer cancel()
	if err := service.database.QueryRow(ctx, `SELECT now()`).Scan(&job.claimedAt); err != nil {
		return nil, err
	}
	kind := "device"
	if job.PushType == "liveactivity" {
		kind = "liveactivity"
	}
	rows, _ := service.database.Query(ctx,
		`SELECT token, platform, apns_environment FROM push_devices
		WHERE app = $1 AND kind = $2 AND ($3::text[] IS NULL OR user_id = ANY($3)) AND ($4::text[] IS NULL OR token = ANY($4))`,
		job.App, kind, job.UserIDs, job.Tokens,
	)
	return pgx.CollectRows(rows, pgx.RowToStructByPos[device])
}

// send starts a send to every device the job has a payload for. Once ctx is done, because the
// replica is stopping or the lease was lost, it starts no more and leaves the rest to be requeued,
// so a stopping replica finishes the job before it's killed instead of leaving all of it to be sent again.
func (service *service) send(ctx context.Context, sends *sync.WaitGroup, job *claimedJob, devices []device) {
	job.devices = len(devices)
	for index, device := range devices {
		if (device.Platform == "ios" && job.APNs == nil) || (device.Platform == "android" && job.FCM == nil) {
			continue
		}
		// NOTE: checked first, since select picks at random once a send slot is free too
		if ctx.Err() == nil {
			select {
			case service.sends <- struct{}{}:
				sends.Go(func() {
					defer func() { <-service.sends }()
					job.record(device, service.senders[device.Platform].send(context.WithoutCancel(ctx), device, job.notification))
				})
				continue
			case <-ctx.Done():
			}
		}
		for _, unsent := range devices[index:] {
			job.unsentTokens = append(job.unsentTokens, unsent.Token)
		}
		return
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
		retryDelay := max(max(result.backoff, time.Second)<<job.Attempt, result.retryAfter)
		// NOTE: a send whose own retry would come too late fails alone instead of dropping the job's other retries
		if job.Attempt+1 < maxAttempts && retryDelay <= maxRetryDelay {
			job.retryTokens = append(job.retryTokens, device.Token)
			job.retryDelay = max(job.retryDelay, retryDelay)
		}
	case failed:
	}
	if result.outcome != delivered {
		job.failures[result.reason]++
	}
}

// finish removes unregistered tokens, requeues unsent and retryable sends, and completes the job in one transaction.
func (service *service) finish(ctx context.Context, queued *queue.Job, job *claimedJob) error {
	ctx, cancel := context.WithTimeout(ctx, databaseTimeout)
	defer cancel()
	transaction, err := service.database.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	// NOTE: another token taking the same FCM message proves the message valid, so the token is not
	if job.fcmDelivered {
		job.unregisteredTokens = append(job.unregisteredTokens, job.invalidFCMTokens...)
	}
	if len(job.unregisteredTokens) > 0 {
		if _, err := transaction.Exec(ctx, `DELETE FROM push_devices WHERE token = ANY($1) AND updated_at < $2`, job.unregisteredTokens, job.claimedAt); err != nil {
			return err
		}
	}
	requeue := func(runAt time.Time, attempt int, tokens []string) error {
		// NOTE: a job's users can have more devices than a job holds, and a smaller job spreads across workers
		for chunk := range slices.Chunk(tokens, recipientsPerJob) {
			// NOTE: keeps the user IDs, so a token registered to another user meanwhile isn't sent
			next := job.notification
			next.Tokens, next.Attempt = chunk, attempt
			if _, err := queue.Enqueue(ctx, transaction, pushQueue, next, queue.EnqueueOptions{RunAt: runAt, GroupKey: job.notificationID}); err != nil {
				return err
			}
		}
		return nil
	}
	if err := requeue(time.Time{}, job.Attempt, job.unsentTokens); err != nil {
		return err
	}
	if err := requeue(time.Now().Add(job.retryDelay), job.Attempt+1, job.retryTokens); err != nil {
		return err
	}

	// NOTE: a failure returns the error, so the queue retries the whole job with backoff instead of losing its retries
	completed, err := queued.Complete(ctx, transaction)
	if err != nil {
		return err
	}
	if !completed {
		return errors.New("lost the lease before finishing")
	}
	return transaction.Commit(ctx)
}
