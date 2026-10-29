package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/valkey-io/valkey-go"
)

const (
	jobStream        = "push:jobs"
	jobGroup         = "push"
	jobWorkers       = 32
	staleJobAge      = 5 * time.Minute
	recipientsPerJob = 500
	sendConcurrency  = 1000
	scheduledBatch   = 100
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
	retryable
	failed
)

type result struct {
	outcome    outcome
	reason     string
	retryAfter time.Duration
}

// enqueue splits the recipients into jobs so one fan-out spreads across every worker.
func (service *service) enqueue(ctx context.Context, notification notification) error {
	var commands valkey.Commands
	addJob := func(userIDs, tokens []string) error {
		job := notification
		job.UserIDs, job.Tokens = userIDs, tokens
		encoded, err := json.Marshal(job)
		if err != nil {
			return err
		}
		commands = append(commands, service.valkey.B().Xadd().Key(jobStream).Id("*").FieldValue().FieldValue("job", string(encoded)).Build())
		return nil
	}
	for userIDs := range slices.Chunk(notification.UserIDs, recipientsPerJob) {
		if err := addJob(userIDs, nil); err != nil {
			return err
		}
	}
	for tokens := range slices.Chunk(notification.Tokens, recipientsPerJob) {
		if err := addJob(nil, tokens); err != nil {
			return err
		}
	}
	for _, response := range service.valkey.DoMulti(ctx, commands...) {
		if err := response.Error(); err != nil {
			return err
		}
	}
	return nil
}

func (service *service) scheduleNotification(ctx context.Context, notification notification) (int64, error) {
	var id int64
	err := service.database.QueryRow(ctx,
		`INSERT INTO push_scheduled_notifications (send_at, notification) VALUES ($1, $2) RETURNING id`,
		notification.SendAt, notification,
	).Scan(&id)
	return id, err
}

// schedule moves due notifications onto the job stream; SKIP LOCKED lets every replica run it.
func (service *service) schedule(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		for {
			var count int
			err := pgx.BeginFunc(ctx, service.database, func(transaction pgx.Tx) error {
				rows, _ := transaction.Query(ctx, `
					DELETE FROM push_scheduled_notifications WHERE id IN (
					  SELECT id FROM push_scheduled_notifications WHERE send_at <= now()
					  ORDER BY send_at LIMIT $1 FOR UPDATE SKIP LOCKED
					) RETURNING notification`, scheduledBatch)
				notifications, err := pgx.CollectRows(rows, pgx.RowTo[notification])
				if err != nil {
					return err
				}
				for _, notification := range notifications {
					if err := service.enqueue(ctx, notification); err != nil {
						return err
					}
				}
				count = len(notifications)
				return nil
			})
			if err != nil && ctx.Err() == nil {
				slog.Error("enqueue scheduled notifications", "error", err)
			}
			if err != nil || count < scheduledBatch {
				break
			}
		}
	}
}

func createJobGroup(ctx context.Context, client valkey.Client) error {
	err := client.Do(ctx, client.B().XgroupCreate().Key(jobStream).Group(jobGroup).Id("0").Mkstream().Build()).Error()
	if valkey.IsValkeyBusyGroup(err) {
		return nil
	}
	return err
}

// consume takes over jobs a dead consumer left pending, otherwise blocks for new ones.
func (service *service) consume(ctx context.Context) {
	for ctx.Err() == nil {
		entries, err := service.claimJobs(ctx)
		if err != nil {
			if ctx.Err() == nil {
				slog.Error("read jobs", "error", err)
				// NOTE: Valkey without persistence loses the consumer group when it restarts
				if err := createJobGroup(ctx, service.valkey); err != nil {
					slog.Error("create job consumer group", "error", err)
				}
				time.Sleep(time.Second)
			}
			continue
		}
		// NOTE: a started job finishes during shutdown instead of waiting staleJobAge to be reclaimed
		jobContext := context.WithoutCancel(ctx)
		for _, entry := range entries {
			if err := service.deliver(jobContext, entry.FieldValues["job"]); err != nil {
				slog.Error("deliver job", "id", entry.ID, "error", err)
				continue
			}
			for _, response := range service.valkey.DoMulti(jobContext,
				service.valkey.B().Xack().Key(jobStream).Group(jobGroup).Id(entry.ID).Build(),
				service.valkey.B().Xdel().Key(jobStream).Id(entry.ID).Build(),
			) {
				if err := response.Error(); err != nil {
					slog.Error("acknowledge job", "id", entry.ID, "error", err)
				}
			}
		}
	}
}

func (service *service) claimJobs(ctx context.Context) ([]valkey.XRangeEntry, error) {
	claimed, err := service.valkey.Do(ctx, service.valkey.B().Xautoclaim().Key(jobStream).Group(jobGroup).Consumer(service.consumer).
		MinIdleTime(strconv.FormatInt(staleJobAge.Milliseconds(), 10)).Start("0-0").Count(1).Build()).ToArray()
	if err != nil {
		return nil, err
	}
	entries, err := claimed[1].AsXRange()
	if err != nil || len(entries) > 0 {
		return entries, err
	}

	streams, err := service.valkey.Do(ctx, service.valkey.B().Xreadgroup().Group(jobGroup, service.consumer).
		Count(1).Block(5000).Streams().Key(jobStream).Id(">").Build()).AsXRead()
	if valkey.IsValkeyNil(err) {
		return nil, nil
	}
	return streams[jobStream], err
}

func (service *service) deliver(ctx context.Context, encodedJob string) error {
	startedAt := time.Now()
	var job notification
	if err := json.Unmarshal([]byte(encodedJob), &job); err != nil {
		return err
	}

	kind, topic, priority := "device", job.App, "10"
	switch job.PushType {
	case "liveactivity":
		kind, topic = "liveactivity", job.App+".push-type.liveactivity"
	case "background":
		priority = "5"
	}
	rows, _ := service.database.Query(ctx,
		`SELECT token, platform FROM push_devices WHERE app = $1 AND kind = $2 AND (user_id = ANY($3) OR token = ANY($4))`,
		job.App, kind, job.UserIDs, job.Tokens,
	)
	devices, err := pgx.CollectRows(rows, pgx.RowToStructByPos[struct{ Token, Platform string }])
	if err != nil {
		return err
	}

	var (
		mutex              sync.Mutex
		sends              sync.WaitGroup
		deliveredCount     int
		unregisteredTokens []string
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
				result = service.apns.send(ctx, device.Token, topic, job.PushType, priority, job.APNs)
			} else {
				result = service.fcm.send(ctx, device.Token, job.FCM)
			}

			mutex.Lock()
			defer mutex.Unlock()
			switch result.outcome {
			case delivered:
				deliveredCount++
			case unregistered:
				unregisteredTokens = append(unregisteredTokens, device.Token)
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

	if len(unregisteredTokens) > 0 {
		// NOTE: a device that registered again after this job started keeps its token
		_, err := service.database.Exec(ctx, `DELETE FROM push_devices WHERE token = ANY($1) AND updated_at < $2`, unregisteredTokens, startedAt)
		if err != nil {
			return err
		}
	}
	if len(retryTokens) > 0 && job.Attempt+1 < maxAttempts {
		retry := job
		retry.UserIDs, retry.Tokens, retry.Attempt = nil, retryTokens, job.Attempt+1
		retry.SendAt = time.Now().Add(max(retryAfter, time.Second) << job.Attempt)
		if _, err := service.scheduleNotification(ctx, retry); err != nil {
			return err
		}
	}

	slog.Info("delivered job",
		"app", job.App, "push_type", job.PushType, "attempt", job.Attempt, "devices", len(devices),
		"delivered", deliveredCount, "unregistered", len(unregisteredTokens), "retrying", len(retryTokens),
		"failures", failures, "duration", time.Since(startedAt).String(),
	)
	return nil
}
