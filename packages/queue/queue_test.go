package queue

import (
	"bytes"
	"context"
	"errors"
	"log"
	"log/slog"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NOTE: pgx reads PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD
var pool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, "")
	if err != nil {
		log.Fatal(err)
	}
	if err := Migrate(ctx, conn); err != nil {
		log.Fatal(err)
	}
	_ = conn.Close(ctx)
	// NOTE: enough for the tests' Concurrency 4 worker and their own queries
	pool, err = pgxpool.New(ctx, "pool_max_conns=8")
	if err != nil {
		log.Fatal(err)
	}
	code := m.Run()
	pool.Close()
	os.Exit(code)
}

// newQueue names a queue after the test and empties it, so reruns against the same database start clean.
func newQueue(t *testing.T) string {
	t.Helper()
	exec(t, `DELETE FROM queue_jobs WHERE queue LIKE $1 || '%'`, t.Name())
	return t.Name()
}

func exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func enqueue(t *testing.T, queue string, options EnqueueOptions) int64 {
	t.Helper()
	id, err := Enqueue(context.Background(), pool, queue, map[string]string{}, options)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// claim claims the queue's next job as worker, or returns nil.
func claim(t *testing.T, queue, worker string) *Job {
	t.Helper()
	job := &Job{}
	err := pool.QueryRow(context.Background(), `SELECT id, queue, payload, group_key, attempts FROM queue_claim($1, $2, 30)`, queue, worker).
		Scan(&job.ID, &job.Queue, &job.Payload, &job.GroupKey, &job.Attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return job
}

// expireLease ends a running job's lease, or a queued job's backoff, now.
func expireLease(t *testing.T, id int64) {
	t.Helper()
	exec(t, `UPDATE queue_jobs SET available_at = now() WHERE id = $1`, id)
}

type row struct {
	state, worker, lastError string
	attempts                 int
	secondsUntilAvailable    float64
}

// jobRow reads a job, or returns nil once it is deleted.
func jobRow(t *testing.T, id int64) *row {
	t.Helper()
	r := &row{}
	err := pool.QueryRow(context.Background(), `
		SELECT state, coalesce(worker, ''), coalesce(last_error, ''), attempts, extract(epoch FROM available_at - now())::double precision
		FROM queue_jobs WHERE id = $1`, id).Scan(&r.state, &r.worker, &r.lastError, &r.attempts, &r.secondsUntilAvailable)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	for deadline := time.Now().Add(timeout); !condition(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("condition not met within %s", timeout)
		}
	}
}

// startWorker runs worker until the test ends.
func startWorker(t *testing.T, worker Worker) {
	t.Helper()
	worker.Pool = pool
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan error, 1)
	go func() { stopped <- worker.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-stopped; !errors.Is(err, context.Canceled) {
			t.Errorf("Run returned %v, want context.Canceled", err)
		}
	})
}

func TestFencedReports(t *testing.T) {
	ctx := context.Background()
	queue := newQueue(t)
	id := enqueue(t, queue, EnqueueOptions{})
	stale := claim(t, queue, "a")
	expireLease(t, id)
	if current := claim(t, queue, "b"); current.Attempt != 2 {
		t.Fatalf("b claimed attempt %d, want 2", current.Attempt)
	}

	for _, report := range []string{
		`SELECT queue_extend($1, $2, 30)`,
		`SELECT queue_retry($1, $2, 'stale')`,
		`SELECT queue_fail($1, $2, 'stale')`,
	} {
		var reported bool
		if err := pool.QueryRow(ctx, report, stale.ID, stale.Attempt).Scan(&reported); err != nil {
			t.Fatal(err)
		}
		if reported {
			t.Errorf("%s by the stale worker returned true", report)
		}
	}

	completed, err := stale.Complete(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if completed {
		t.Error("Complete by the stale worker returned true")
	}

	if got := jobRow(t, id); got == nil || got.state != "running" || got.worker != "b" || got.attempts != 2 || got.lastError != "" {
		t.Fatalf("the stale worker's reports changed b's job: %+v", got)
	}
	completed, err = (&Job{ID: id, Attempt: 2}).Complete(ctx, pool)
	if err != nil || !completed {
		t.Fatalf("b's Complete = %v, %v, want true", completed, err)
	}
}

func TestHeartbeatKeepsALongJob(t *testing.T) {
	queue := newQueue(t)
	lease := time.Second
	var starts atomic.Int32
	startWorker(t, Worker{Queue: queue, Name: "worker", Lease: lease, Concurrency: 2, Handle: func(ctx context.Context, job *Job) error {
		starts.Add(1)
		time.Sleep(3 * lease)
		return nil
	}})
	id := enqueue(t, queue, EnqueueOptions{})
	waitFor(t, 10*lease, func() bool { return jobRow(t, id) == nil })
	if got := starts.Load(); got != 1 {
		t.Fatalf("a job 3 leases long started %d times, want 1", got)
	}
}

func TestRetryBackoffAndDead(t *testing.T) {
	ctx := context.Background()
	queue := newQueue(t)
	worker := Worker{Pool: pool}
	report := func(job *Job, err error) *row {
		t.Helper()
		if err := worker.report(ctx, job, err); err != nil {
			t.Fatal(err)
		}
		return jobRow(t, job.ID)
	}
	near := func(got, want float64) bool { return got > want-0.5 && got <= want }

	// The default of 5 attempts: backoff 2^(attempt-1) s unless RetryAfter, then dead
	id := enqueue(t, queue, EnqueueOptions{})
	for _, step := range []struct {
		err   error
		delay float64
	}{
		{errors.New("boom 1"), 1},
		{errors.New("boom 2"), 2},
		{RetryAfter(10*time.Second, errors.New("boom 3")), 10},
		{errors.New("boom 4"), 8},
	} {
		expireLease(t, id)
		job := claim(t, queue, "worker")
		if got := report(job, step.err); got.state != "queued" || !near(got.secondsUntilAvailable, step.delay) || got.lastError != step.err.Error() {
			t.Fatalf("attempt %d returned %q: got %+v, want queued for %v s", job.Attempt, step.err, got, step.delay)
		}
	}
	expireLease(t, id)
	if got := report(claim(t, queue, "worker"), errors.New("boom 5")); got.state != "dead" || got.lastError != "boom 5" {
		t.Fatalf("the 5th failure: got %+v, want dead", got)
	}
	expireLease(t, id)
	if job := claim(t, queue, "worker"); job != nil {
		t.Fatalf("claimed a dead job: %+v", job)
	}

	enqueue(t, queue, EnqueueOptions{})
	if got := report(claim(t, queue, "worker"), Permanent(errors.New("bad payload"))); got.state != "dead" || got.attempts != 1 || got.lastError != "bad payload" {
		t.Fatalf("Permanent on the first attempt: got %+v, want dead", got)
	}

	// A worker that dies on the last attempt never reports, so the next claim marks the job dead.
	id = enqueue(t, queue, EnqueueOptions{MaxAttempts: 1})
	claim(t, queue, "worker")
	expireLease(t, id)
	if job := claim(t, queue, "worker"); job != nil {
		t.Fatalf("claimed a job past its last attempt: %+v", job)
	}
	if got := jobRow(t, id); got.state != "dead" || got.lastError != "lease expired on the last attempt" {
		t.Fatalf("a lost last attempt: got %+v, want dead", got)
	}
}

func TestScheduleAndCancel(t *testing.T) {
	ctx := context.Background()
	queue := newQueue(t)

	scheduled := enqueue(t, queue, EnqueueOptions{RunAt: time.Now().Add(time.Hour)})
	if job := claim(t, queue, "worker"); job != nil {
		t.Fatalf("claimed a job scheduled an hour ahead: %+v", job)
	}
	if cancelled, err := Cancel(ctx, pool, scheduled); err != nil || !cancelled || jobRow(t, scheduled) != nil {
		t.Fatalf("Cancel of a scheduled job = %v, %v", cancelled, err)
	}

	backingOff := enqueue(t, queue, EnqueueOptions{})
	if err := (Worker{Pool: pool}).report(ctx, claim(t, queue, "worker"), errors.New("boom")); err != nil {
		t.Fatal(err)
	}
	if cancelled, err := Cancel(ctx, pool, backingOff); err != nil || !cancelled || jobRow(t, backingOff) != nil {
		t.Fatalf("Cancel of a job in backoff = %v, %v", cancelled, err)
	}

	orphaned := enqueue(t, queue, EnqueueOptions{})
	claim(t, queue, "worker")
	expireLease(t, orphaned)
	if cancelled, err := Cancel(ctx, pool, orphaned); err != nil || !cancelled || jobRow(t, orphaned) != nil {
		t.Fatalf("Cancel of a job whose worker died = %v, %v", cancelled, err)
	}

	// A running job finishes this run, then its retry, fail, release or lost lease deletes it instead of running it again
	worker := Worker{Pool: pool}
	for end, finish := range map[string]func(job *Job) error{
		"retry":      func(job *Job) error { return worker.report(ctx, job, errors.New("boom")) },
		"fail":       func(job *Job) error { return worker.report(ctx, job, Permanent(errors.New("bad payload"))) },
		"release":    func(job *Job) error { return worker.release(ctx, job) },
		"lost lease": func(job *Job) error { expireLease(t, job.ID); claim(t, queue, "worker"); return nil },
	} {
		running := enqueue(t, queue, EnqueueOptions{})
		job := claim(t, queue, "worker")
		if cancelled, err := Cancel(ctx, pool, running); err != nil || !cancelled || jobRow(t, running) == nil {
			t.Fatalf("Cancel of a running job = %v, %v, want it marked", cancelled, err)
		}
		if err := finish(job); err != nil {
			t.Fatal(err)
		}
		if got := jobRow(t, running); got != nil {
			t.Fatalf("a cancelled running job's %s kept it: %+v", end, got)
		}
	}

	running := enqueue(t, queue, EnqueueOptions{GroupKey: "a"})
	claim(t, queue, "worker")
	later := time.Now().Add(time.Hour)
	enqueue(t, queue, EnqueueOptions{GroupKey: "a", RunAt: later})
	enqueue(t, queue, EnqueueOptions{GroupKey: "a", RunAt: later})
	other := enqueue(t, queue, EnqueueOptions{GroupKey: "b", RunAt: later})
	otherQueue := enqueue(t, queue+"-other", EnqueueOptions{GroupKey: "a", RunAt: later})
	if cancelled, err := CancelGroup(ctx, pool, queue, "a"); err != nil || cancelled != 3 {
		t.Fatalf("CancelGroup = %d, %v, want 3", cancelled, err)
	}
	if jobRow(t, running) == nil || jobRow(t, other) == nil || jobRow(t, otherQueue) == nil {
		t.Fatal("CancelGroup deleted a running job, another group's job, or another queue's job")
	}
}

// A cancel that waits on a claim's row lock must judge the claimed row, or it misses the job and the job runs.
func TestCancelDuringAClaim(t *testing.T) {
	ctx := context.Background()
	queue := newQueue(t)
	for name, cancel := range map[string]func(id int64) (bool, error){
		"Cancel": func(id int64) (bool, error) { return Cancel(ctx, pool, id) },
		"CancelGroup": func(int64) (bool, error) {
			cancelled, err := CancelGroup(ctx, pool, queue, "group")
			return cancelled == 1, err
		},
	} {
		id := enqueue(t, queue, EnqueueOptions{GroupKey: "group"})
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `SELECT FROM queue_claim($1, 'worker', 30)`, queue); err != nil {
			t.Fatal(err)
		}
		type result struct {
			cancelled bool
			err       error
		}
		cancelled := make(chan result, 1)
		go func() {
			ok, err := cancel(id)
			cancelled <- result{ok, err}
		}()
		waitFor(t, 5*time.Second, func() bool {
			var waiting bool
			if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT FROM pg_stat_activity WHERE pid <> pg_backend_pid()
				AND query LIKE '%queue_cancel%' AND wait_event_type = 'Lock')`).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			return waiting
		})
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if got := <-cancelled; got.err != nil || !got.cancelled {
			t.Fatalf("%s during a claim = %v, %v, want true", name, got.cancelled, got.err)
		}
		expireLease(t, id)
		if job := claim(t, queue, "worker"); job != nil {
			t.Fatalf("a job %s cancelled during its claim ran again: %+v", name, job)
		}
	}
}

func TestWakeAndIsolation(t *testing.T) {
	queue := newQueue(t)
	otherQueue := enqueue(t, queue+"-other", EnqueueOptions{})
	started := make(chan time.Time, 2)
	startWorker(t, Worker{Queue: queue, Name: "worker", Lease: 30 * time.Second, Handle: func(ctx context.Context, job *Job) error {
		started <- time.Now()
		return nil
	}})
	// NOTE: the first job proves the worker runs; after it the worker idles, waiting up to the 30 s lease
	enqueue(t, queue, EnqueueOptions{})
	<-started
	time.Sleep(200 * time.Millisecond)

	enqueued := time.Now()
	enqueue(t, queue, EnqueueOptions{})
	select {
	case at := <-started:
		t.Logf("woke %s after the enqueue", at.Sub(enqueued))
	case <-time.After(time.Second):
		t.Fatal("an idle worker didn't start a new job within 1 s")
	}
	if got := jobRow(t, otherQueue); got.state != "queued" || got.attempts != 0 {
		t.Fatalf("another queue's job was claimed: %+v", got)
	}
}

func TestCompleteInTheHandlersTransaction(t *testing.T) {
	queue := newQueue(t)
	var logs bytes.Buffer
	defaultLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(defaultLogger) })

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan error, 1)
	go func() {
		stopped <- Worker{Pool: pool, Queue: queue, Name: "worker", Lease: 300 * time.Millisecond, Handle: func(ctx context.Context, job *Job) error {
			tx, err := pool.Begin(ctx)
			if err != nil {
				return err
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, err := Enqueue(ctx, tx, queue+"-followup", map[string]int64{"parent": job.ID}, EnqueueOptions{GroupKey: *job.GroupKey}); err != nil {
				return err
			}
			if completed, err := job.Complete(ctx, tx); err != nil || !completed {
				return err
			}
			// NOTE: lets a heartbeat tick land between Complete and Commit
			time.Sleep(200 * time.Millisecond)
			return tx.Commit(ctx)
		}}.Run(ctx)
	}()

	id := enqueue(t, queue, EnqueueOptions{GroupKey: "group"})
	var followups int
	waitFor(t, 5*time.Second, func() bool {
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM queue_jobs WHERE queue = $1 AND group_key = 'group' AND (payload->>'parent')::bigint = $2`,
			queue+"-followup", id).Scan(&followups); err != nil {
			t.Fatal(err)
		}
		return followups == 1
	})
	if jobRow(t, id) != nil {
		t.Fatal("the follow-up committed but the job wasn't deleted with it")
	}
	cancel()
	if err := <-stopped; !errors.Is(err, context.Canceled) {
		t.Errorf("Run returned %v, want context.Canceled", err)
	}
	if strings.Contains(logs.String(), "lease lost") {
		t.Fatalf("the runner reported a job the handler completed: %s", logs.String())
	}
}

func TestMigrateTwice(t *testing.T) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	for range 2 {
		if err := Migrate(ctx, conn); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMigrateFailsBehindAnOpenTransaction(t *testing.T) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := Enqueue(ctx, tx, newQueue(t), map[string]string{}, EnqueueOptions{}); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	migrateContext, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var pgError *pgconn.PgError
	if err := Migrate(migrateContext, conn); !errors.As(err, &pgError) || pgError.Code != "55P03" {
		t.Fatalf("Migrate behind an open transaction returned %v, want a lock timeout", err)
	}
}

// A handler on its last attempt that called Complete in its transaction locks the job, and its lease can run out
// before the transaction ends.
func TestLockedExpiredJobStallsNoClaims(t *testing.T) {
	ctx := context.Background()
	queue := newQueue(t)
	id := enqueue(t, queue, EnqueueOptions{MaxAttempts: 1})
	job := claim(t, queue, "worker")
	expireLease(t, id)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if completed, err := job.Complete(ctx, tx); err != nil || !completed {
		t.Fatalf("Complete = %v, %v, want true", completed, err)
	}

	next := enqueue(t, queue, EnqueueOptions{})
	claimContext, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	var claimed int64
	if err := pool.QueryRow(claimContext, `SELECT id FROM queue_claim($1, 'worker', 30)`, queue).Scan(&claimed); err != nil || claimed != next {
		t.Fatalf("claim beside a locked expired job = %d, %v, want %d", claimed, err, next)
	}
	var seconds float64
	if err := pool.QueryRow(ctx, `SELECT queue_wait_seconds($1, 30)`, queue).Scan(&seconds); err != nil || seconds <= 0 {
		t.Fatalf("wait beside a locked due job = %v, %v, want more than 0 so idle workers don't spin", seconds, err)
	}
}

func TestRunRejectsAPoolOfOne(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	single, err := pgxpool.New(ctx, "pool_max_conns=1")
	if err != nil {
		t.Fatal(err)
	}
	defer single.Close()
	err = Worker{Pool: single, Queue: newQueue(t), Name: "worker"}.Run(ctx)
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run with a pool of one, which can never claim, returned %v", err)
	}
}

func TestRunRejectsANegativeLease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := Worker{Pool: pool, Queue: newQueue(t), Name: "worker", Lease: -time.Second}.Run(ctx)
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run with a negative lease, which every claim would hand straight back, returned %v", err)
	}
}

func TestRetryBackoffNeverOverflows(t *testing.T) {
	queue := newQueue(t)
	id := enqueue(t, queue, EnqueueOptions{MaxAttempts: 5000})
	exec(t, `UPDATE queue_jobs SET state = 'running', attempts = 2000 WHERE id = $1`, id)
	var retried bool
	if err := pool.QueryRow(context.Background(), `SELECT queue_retry($1, 2000, 'failed')`, id).Scan(&retried); err != nil || !retried {
		t.Fatalf("retrying attempt 2000 = %v, %v", retried, err)
	}
	if got := jobRow(t, id); got.secondsUntilAvailable < 3599 || got.secondsUntilAvailable > 3600 {
		t.Fatalf("attempt 2000 retries after %.0f s, want the 1 hour cap", got.secondsUntilAvailable)
	}
}

func TestBatchEnqueueWakesEveryWorker(t *testing.T) {
	ctx := context.Background()
	queue := newQueue(t)
	var running atomic.Int32
	release := make(chan struct{})
	startWorker(t, Worker{Queue: queue, Name: "worker", Lease: 30 * time.Second, Concurrency: 4, Handle: func(ctx context.Context, job *Job) error {
		running.Add(1)
		<-release
		return nil
	}})
	// NOTE: lets every claim loop go idle first, so only the batch's one NOTIFY can wake them
	time.Sleep(200 * time.Millisecond)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for range 4 {
		if _, err := Enqueue(ctx, tx, queue, map[string]string{}, EnqueueOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer close(release)
	waitFor(t, 2*time.Second, func() bool { return running.Load() == 4 })
}

func TestEnqueueRejectsNoAttempts(t *testing.T) {
	if _, err := Enqueue(context.Background(), pool, newQueue(t), map[string]string{}, EnqueueOptions{MaxAttempts: -1}); err == nil {
		t.Fatal("enqueued a job that can never be claimed")
	}
}

func TestShutdownGivesTheJobBack(t *testing.T) {
	// NOTE: a cancel stops Run once the handler starts, and a deadline a second in stops it on its own
	for _, stop := range []error{context.Canceled, context.DeadlineExceeded} {
		queue := newQueue(t)
		id := enqueue(t, queue, EnqueueOptions{MaxAttempts: 1})
		started := make(chan struct{})
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		stopped := make(chan error, 1)
		go func() {
			stopped <- Worker{Pool: pool, Queue: queue, Name: "worker", Handle: func(ctx context.Context, job *Job) error {
				close(started)
				<-ctx.Done()
				return ctx.Err()
			}}.Run(ctx)
		}()
		<-started
		if errors.Is(stop, context.Canceled) {
			cancel()
		}
		err := <-stopped
		cancel()
		if !errors.Is(err, stop) {
			t.Fatalf("Run returned %v, want %v", err, stop)
		}
		if got := jobRow(t, id); got == nil || got.state != "queued" || got.attempts != 0 {
			t.Fatalf("a job stopped by %v wasn't given back unspent: %+v", stop, got)
		}
	}
}

func TestShutdownGivesBackAClaimInFlight(t *testing.T) {
	ctx := context.Background()
	queue := newQueue(t)
	id := enqueue(t, queue, EnqueueOptions{})
	// NOTE: a pool whose cancel requests can't reach Postgres, like one that lands after the claim commits
	config, err := pgxpool.ParseConfig("pool_max_conns=3")
	if err != nil {
		t.Fatal(err)
	}
	var unreachable atomic.Bool
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		if unreachable.Load() {
			return nil, errors.New("unreachable")
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	lossy, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer lossy.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// NOTE: blocks the claim's update, so Run stops while its claim waits
	if _, err := tx.Exec(ctx, `LOCK TABLE queue_jobs IN SHARE MODE`); err != nil {
		t.Fatal(err)
	}
	claimActive := func(onLock bool) bool {
		var active bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active'
			AND query LIKE '%queue_claim%' AND (NOT $1 OR wait_event_type = 'Lock'))`, onLock).Scan(&active); err != nil {
			t.Fatal(err)
		}
		return active
	}

	runContext, cancel := context.WithCancel(ctx)
	stopped := make(chan error, 1)
	go func() {
		stopped <- Worker{Pool: lossy, Queue: queue, Name: "worker", Handle: func(ctx context.Context, job *Job) error { return nil }}.Run(runContext)
	}()
	waitFor(t, 5*time.Second, func() bool { return claimActive(true) })
	unreachable.Store(true)
	cancel()
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-stopped; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want context.Canceled", err)
	}
	waitFor(t, 5*time.Second, func() bool { return !claimActive(false) })
	if got := jobRow(t, id); got == nil || got.state != "queued" || got.attempts != 0 {
		t.Fatalf("a job claimed as Run stopped wasn't given back unspent: %+v", got)
	}
}

// SQL function bodies resolve names at each call under the caller's search_path, where a session's temp table
// comes first.
func TestATempTableDoesNotShadowTheQueue(t *testing.T) {
	ctx := context.Background()
	queue := newQueue(t)
	conn, err := pgx.Connect(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, `CREATE TEMP TABLE queue_jobs (LIKE public.queue_jobs INCLUDING ALL)`); err != nil {
		t.Fatal(err)
	}
	id, err := Enqueue(ctx, conn, queue, map[string]string{}, EnqueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if jobRow(t, id) == nil {
		t.Fatal("Enqueue wrote to the session's temp queue_jobs")
	}
	var claimed int64
	if err := conn.QueryRow(ctx, `SELECT id FROM public.queue_claim($1, 'worker', 30)`, queue).Scan(&claimed); err != nil || claimed != id {
		t.Fatalf("claim beside a temp queue_jobs = %d, %v, want %d", claimed, err, id)
	}
}
