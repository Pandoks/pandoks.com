// Package queue runs jobs from the queue_jobs table. Every rule is in queue.sql; this only waits, claims,
// heartbeats, runs and reports.
package queue

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed queue.sql
var schema string

// NOTE: PgDog parses a SELECT as a read, but every queue function writes
const primary = "/* pgdog_role: primary */ "

// Migrate installs or updates the schema. It is idempotent and serialized, so every pod may run it at start.
func Migrate(ctx context.Context, conn *pgx.Conn) error {
	_, err := conn.Exec(ctx, schema)
	return err
}

// Job is a claimed job. Attempt fences its reports: a worker whose lease ran out can't report it.
type Job struct {
	ID       int64
	Queue    string
	Payload  json.RawMessage
	GroupKey *string
	Attempt  int
	reported bool
}

// Handler runs a job. Returning an error retries it with backoff, unless the error is Permanent or RetryAfter.
type Handler func(ctx context.Context, job *Job) error

// Querier is a pool, connection or transaction. Enqueue in a transaction to commit the job with the caller's writes.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type failure struct {
	err        error
	permanent  bool
	retryAfter time.Duration
}

func (f *failure) Error() string { return f.err.Error() }
func (f *failure) Unwrap() error { return f.err }

// Permanent makes a handler error dead at once instead of retrying it.
func Permanent(err error) error { return &failure{err: err, permanent: true} }

// RetryAfter retries a handler error after delay instead of the backoff.
func RetryAfter(delay time.Duration, err error) error { return &failure{err: err, retryAfter: delay} }

type EnqueueOptions struct {
	RunAt       time.Time
	GroupKey    string
	MaxAttempts int
}

// Enqueue adds a job that may run from options.RunAt, or now, and returns its ID.
func Enqueue(ctx context.Context, db Querier, queue string, payload any, options EnqueueOptions) (int64, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	var runAt *time.Time
	if !options.RunAt.IsZero() {
		runAt = &options.RunAt
	}
	var groupKey *string
	if options.GroupKey != "" {
		groupKey = &options.GroupKey
	}
	var maxAttempts *int
	if options.MaxAttempts != 0 {
		maxAttempts = &options.MaxAttempts
	}
	var id int64
	err = db.QueryRow(ctx, primary+`SELECT queue_enqueue($1, $2, $3, $4, $5)`, queue, data, runAt, groupKey, maxAttempts).Scan(&id)
	return id, err
}

// Cancel deletes a job no worker is running, and reports whether it did.
func Cancel(ctx context.Context, db Querier, id int64) (bool, error) {
	var cancelled bool
	err := db.QueryRow(ctx, primary+`SELECT queue_cancel($1)`, id).Scan(&cancelled)
	return cancelled, err
}

// CancelGroup deletes every job of queue and groupKey that no worker is running, and returns how many.
func CancelGroup(ctx context.Context, db Querier, queue, groupKey string) (int64, error) {
	var cancelled int64
	err := db.QueryRow(ctx, primary+`SELECT queue_cancel_group($1, $2)`, queue, groupKey).Scan(&cancelled)
	return cancelled, err
}

// Complete ends the job in tx, so it commits with the handler's writes. False means the lease was lost:
// roll tx back.
func (job *Job) Complete(ctx context.Context, tx Querier) (bool, error) {
	err := tx.QueryRow(ctx, primary+`SELECT queue_complete($1, $2)`, job.ID, job.Attempt).Scan(&job.reported)
	return job.reported, err
}

type Worker struct {
	Pool        *pgxpool.Pool
	Queue, Name string
	// Lease is how long a job stays claimed without a heartbeat, so how soon a dead worker's job runs again.
	// Zero means 30 s.
	Lease time.Duration
	// Concurrency is how many jobs run at once. Zero means 1.
	Concurrency int
	Handle      Handler
}

// Run runs jobs until ctx is done or the database fails. It holds one pool connection for LISTEN. When ctx
// is done, it cancels the running handlers' contexts, waits for them to return, and gives back the jobs
// whose handlers returned context.Canceled without spending their attempt.
func (worker Worker) Run(ctx context.Context) error {
	if worker.Lease == 0 {
		worker.Lease = 30 * time.Second
	}
	worker.Concurrency = max(worker.Concurrency, 1)
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	listener, err := worker.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// NOTE: closed before release, so the pool replaces it instead of handing out a listening connection
	defer func() {
		_ = listener.Conn().Close(context.WithoutCancel(ctx))
		listener.Release()
	}()
	if _, err := listener.Exec(ctx, "LISTEN "+pgx.Identifier{"queue_" + worker.Queue}.Sanitize()); err != nil {
		return err
	}

	wake := make(chan struct{}, worker.Concurrency)
	done := make(chan struct{})
	for range worker.Concurrency {
		go func() {
			defer func() { done <- struct{}{} }()
			if err := worker.work(ctx, wake); err != nil {
				cancel(err)
			}
		}()
	}
	for ctx.Err() == nil {
		if _, err := listener.Conn().WaitForNotification(ctx); err != nil {
			cancel(err)
			break
		}
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	for range worker.Concurrency {
		<-done
	}
	return context.Cause(ctx)
}

func (worker Worker) work(ctx context.Context, wake chan struct{}) error {
	for {
		job := &Job{}
		err := worker.Pool.QueryRow(ctx, primary+`SELECT id, queue, payload, group_key, attempts FROM queue_claim($1, $2, $3)`,
			worker.Queue, worker.Name, worker.Lease.Seconds(),
		).Scan(&job.ID, &job.Queue, &job.Payload, &job.GroupKey, &job.Attempt)
		if errors.Is(err, pgx.ErrNoRows) {
			var seconds float64
			if err := worker.Pool.QueryRow(ctx, primary+`SELECT queue_wait_seconds($1, $2)`, worker.Queue, worker.Lease.Seconds()).Scan(&seconds); err != nil {
				return err
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-wake:
			case <-time.After(time.Duration(seconds * float64(time.Second))):
			}
			continue
		}
		if err != nil {
			return err
		}
		// NOTE: Postgres folds a transaction's NOTIFYs into one, so pass the wake on in case more jobs are due
		select {
		case wake <- struct{}{}:
		default:
		}
		if err := worker.run(ctx, job); err != nil {
			return err
		}
	}
}

// run heartbeats the lease while the handler runs, and cancels the handler if the lease is lost. The heartbeat
// outlives ctx, so a stopping worker keeps the lease while its handler drains.
func (worker Worker) run(ctx context.Context, job *Job) error {
	handlerContext, cancel := context.WithCancel(ctx)
	defer cancel()
	handled := make(chan error, 1)
	go func() { handled <- worker.Handle(handlerContext, job) }()
	heartbeat := time.NewTicker(worker.Lease / 3)
	defer heartbeat.Stop()
	for {
		select {
		case <-heartbeat.C:
			var extended bool
			extendContext, cancelExtend := context.WithTimeout(context.WithoutCancel(ctx), worker.Lease)
			err := worker.Pool.QueryRow(extendContext, primary+`SELECT queue_extend($1, $2, $3)`, job.ID, job.Attempt, worker.Lease.Seconds()).Scan(&extended)
			cancelExtend()
			if err != nil || !extended {
				slog.Warn("lease lost while running", "job", job.ID, "attempt", job.Attempt, "error", err)
				heartbeat.Stop()
				cancel()
			}
		case err := <-handled:
			// NOTE: a handler stopped by Run's ctx gives the job back instead of spending an attempt on it
			if ctx.Err() != nil && errors.Is(err, context.Canceled) {
				return worker.release(context.WithoutCancel(ctx), job)
			}
			return worker.report(context.WithoutCancel(ctx), job, err)
		}
	}
}

func (worker Worker) release(ctx context.Context, job *Job) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var released bool
	return worker.Pool.QueryRow(ctx, primary+`SELECT queue_release($1, $2)`, job.ID, job.Attempt).Scan(&released)
}

func (worker Worker) report(ctx context.Context, job *Job, err error) error {
	if err == nil && job.reported {
		return nil
	}
	var f *failure
	query := `SELECT queue_complete($1, $2)`
	args := []any{job.ID, job.Attempt}
	switch {
	case err == nil:
	case errors.As(err, &f) && f.permanent:
		query = `SELECT queue_fail($1, $2, $3)`
		args = append(args, err.Error())
	default:
		query = `SELECT queue_retry($1, $2, $3, $4)`
		var retryAfter *float64
		if f != nil {
			seconds := f.retryAfter.Seconds()
			retryAfter = &seconds
		}
		args = append(args, err.Error(), retryAfter)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var reported bool
	if err := worker.Pool.QueryRow(ctx, primary+query, args...).Scan(&reported); err != nil {
		return err
	}
	if !reported {
		slog.Warn("lease lost before the report", "job", job.ID, "attempt", job.Attempt)
	}
	return nil
}
