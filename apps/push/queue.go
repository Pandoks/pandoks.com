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
	jobWorkers       = 16
	apiConnections   = 4
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
	connection, err := pgx.Connect(ctx, "")
	if err != nil {
		return err
	}
	defer func() { _ = connection.Close(context.WithoutCancel(ctx)) }()
	if _, err := connection.Exec(ctx, "LISTEN push_jobs"); err != nil {
		return err
	}
	for {
		service.wakeWorker()
		waitContext, cancel := context.WithTimeout(ctx, pollInterval)
		_, err := connection.WaitForNotification(waitContext)
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
		// NOTE: a started job finishes during shutdown so its sends aren't repeated
		for ctx.Err() == nil && service.deliverDueJob(context.WithoutCancel(ctx)) {
		}
	}
}

// deliverDueJob claims a due job and deletes it in the same transaction, so a crash before the
// commit leaves the job to another worker.
func (service *service) deliverDueJob(ctx context.Context) bool {
	transaction, err := service.database.Begin(ctx)
	if err != nil {
		slog.Error("claim job", "error", err)
		return false
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	var (
		jobID, notificationID int64
		job                   notification
	)
	err = transaction.QueryRow(ctx,
		`SELECT id, notification_id, job FROM push_jobs WHERE send_at <= now() ORDER BY send_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
	).Scan(&jobID, &notificationID, &job)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		slog.Error("claim job", "error", err)
		return false
	}
	service.wakeWorker()

	if err := service.deliver(ctx, transaction, notificationID, job); err != nil {
		slog.Error("deliver job", "id", jobID, "error", err)
		return false
	}
	_, err = transaction.Exec(ctx, `DELETE FROM push_jobs WHERE id = $1`, jobID)
	if err == nil {
		err = transaction.Commit(ctx)
	}
	if err != nil {
		slog.Error("finish job", "id", jobID, "error", err)
	}
	return true
}

func (service *service) deliver(ctx context.Context, transaction pgx.Tx, notificationID int64, job notification) error {
	startedAt := time.Now()
	kind, topic, priority := "device", job.App, "10"
	switch job.PushType {
	case "liveactivity":
		kind, topic = "liveactivity", job.App+".push-type.liveactivity"
	case "background":
		priority = "5"
	}
	rows, _ := transaction.Query(ctx,
		`SELECT token, platform, apns_environment FROM push_devices WHERE app = $1 AND kind = $2 AND (user_id = ANY($3) OR token = ANY($4))`,
		job.App, kind, job.UserIDs, job.Tokens,
	)
	devices, err := pgx.CollectRows(rows, pgx.RowToStructByPos[struct{ Token, Platform, APNsEnvironment string }])
	if err != nil {
		return err
	}

	var (
		mutex              sync.Mutex
		sends              sync.WaitGroup
		deliveredCount     int
		fcmDelivered       bool
		unregisteredTokens []string
		invalidFCMTokens   []string
		retryTokens        []string
		retryAfter         time.Duration
		failures           = map[string]int{}
	)
	for _, device := range devices {
		if (device.Platform == "ios" && job.APNs == nil) || (device.Platform == "android" && job.FCM == nil) {
			continue
		}
		service.sends <- struct{}{}
		sends.Go(func() {
			defer func() { <-service.sends }()
			var result result
			if device.Platform == "ios" {
				result = service.apns.send(ctx, device.APNsEnvironment, device.Token, topic, job.PushType, priority, job.APNs)
			} else {
				result = service.fcm.send(ctx, device.Token, job.FCM)
			}

			mutex.Lock()
			defer mutex.Unlock()
			switch result.outcome {
			case delivered:
				deliveredCount++
				fcmDelivered = fcmDelivered || device.Platform == "android"
			case unregistered:
				unregisteredTokens = append(unregisteredTokens, device.Token)
			case invalidArgument:
				invalidFCMTokens = append(invalidFCMTokens, device.Token)
			case retryable:
				retryTokens = append(retryTokens, device.Token)
				retryAfter = max(retryAfter, result.retryAfter)
			case failed:
			}
			if result.outcome != delivered {
				failures[result.reason]++
			}
		})
	}
	sends.Wait()

	// NOTE: another token taking the same FCM message proves the message valid, so the token is not
	if fcmDelivered {
		unregisteredTokens = append(unregisteredTokens, invalidFCMTokens...)
	}
	// NOTE: a bookkeeping error is logged instead of rolling back the job and repeating its sends
	err = pgx.BeginFunc(ctx, transaction, func(savepoint pgx.Tx) error {
		if len(unregisteredTokens) > 0 {
			// NOTE: a device that registered again after this job started keeps its token
			_, err := savepoint.Exec(ctx, `DELETE FROM push_devices WHERE token = ANY($1) AND updated_at < $2`, unregisteredTokens, startedAt)
			if err != nil {
				return err
			}
		}
		if len(retryTokens) > 0 && job.Attempt+1 < maxAttempts {
			retry := job
			retry.UserIDs, retry.Tokens, retry.Attempt = nil, retryTokens, job.Attempt+1
			_, err := savepoint.Exec(ctx, `INSERT INTO push_jobs (notification_id, send_at, job) VALUES ($1, $2, $3)`,
				notificationID, time.Now().Add(max(retryAfter, time.Second)<<job.Attempt), retry)
			return err
		}
		return nil
	})
	if err != nil {
		slog.Error("record job results", "error", err)
	}

	slog.Info("delivered job",
		"app", job.App, "push_type", job.PushType, "attempt", job.Attempt, "devices", len(devices),
		"delivered", deliveredCount, "unregistered", len(unregisteredTokens), "retrying", len(retryTokens),
		"failures", failures, "duration", time.Since(startedAt).String(),
	)
	return nil
}
