package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"
)

const (
	handlerMargin  = 10 * time.Second
	settleTimeout  = 10 * time.Second
	pollErrorDelay = time.Second
)

// Worker runs Handle on up to Concurrency deliveries at once. A handler that returns nil is
// acked; Permanent errors are acked and logged; RetryAfter errors are retried after their delay;
// any other error or a panic is retried after backoff. The handler's context ends 10 s before
// the delivery's deadline, or halfway there for a shorter lease. When Run's context ends, Run
// stops receiving, releases what its last receive returned, cancels the handlers' contexts,
// settles them, and returns.
type Worker struct {
	Queue       Queue
	Handle      func(context.Context, *Delivery) error
	Concurrency int
}

func (worker Worker) Run(ctx context.Context) error {
	if worker.Concurrency < 1 {
		return errors.New("queue worker: concurrency must be at least 1")
	}
	slots := make(chan struct{}, worker.Concurrency)
	var running sync.WaitGroup
	defer running.Wait()
	for {
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			return nil
		}
		free := 1
	fill:
		for free < worker.Concurrency {
			select {
			case slots <- struct{}{}:
				free++
			default:
				break fill
			}
		}

		deliveries, err := worker.Queue.Receive(ctx, free)
		if ctx.Err() != nil {
			worker.release(ctx, deliveries)
			return nil
		}
		for range free - len(deliveries) {
			<-slots
		}
		if err != nil {
			slog.Error("queue receive failed", "error", err)
			select {
			case <-time.After(pollErrorDelay):
			case <-ctx.Done():
				return nil
			}
			continue
		}
		for _, delivery := range deliveries {
			running.Go(func() {
				defer func() { <-slots }()
				worker.process(ctx, delivery)
			})
		}
	}
}

func (worker Worker) process(ctx context.Context, delivery *Delivery) {
	margin := min(handlerMargin, time.Until(delivery.Deadline)/2)
	handlerContext, cancel := context.WithDeadline(ctx, delivery.Deadline.Add(-margin))
	err := worker.handle(handlerContext, delivery)
	cancel()

	settleContext, cancelSettle := context.WithTimeout(context.WithoutCancel(ctx), settleTimeout)
	defer cancelSettle()
	log := slog.With("id", delivery.ID, "type", delivery.Type, "attempt", delivery.Attempt)
	var permanent *permanentError
	var retryAfter *retryAfterError
	var settleErr error
	switch {
	case err == nil:
		settleErr = worker.Queue.Ack(settleContext, delivery)
	case errors.As(err, &permanent):
		log.Error("queue message failed permanently", "error", err)
		settleErr = worker.Queue.Ack(settleContext, delivery)
	case errors.As(err, &retryAfter):
		log.Warn("queue message retried", "delay", retryAfter.delay, "error", err)
		settleErr = worker.Queue.Retry(settleContext, min(max(retryAfter.delay, 0), MaxDelay), delivery)
	default:
		log.Error("queue message failed", "error", err)
		settleErr = worker.Queue.Retry(settleContext, backoff(delivery.Attempt), delivery)
	}
	if settleErr != nil {
		log.Error("queue settle failed", "error", settleErr)
	}
}

// release returns deliveries received after shutdown began to the queue without handling them.
func (worker Worker) release(ctx context.Context, deliveries []*Delivery) {
	settleContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), settleTimeout)
	defer cancel()
	if err := worker.Queue.Retry(settleContext, 0, deliveries...); err != nil {
		slog.Error("queue release failed", "error", err)
	}
}

func (worker Worker) handle(ctx context.Context, delivery *Delivery) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("queue handler panicked: %v\n%s", recovered, debug.Stack())
		}
	}()
	return worker.Handle(ctx, delivery)
}

type permanentError struct{ err error }

func (err *permanentError) Error() string { return err.err.Error() }
func (err *permanentError) Unwrap() error { return err.err }

// Permanent marks a handler error the worker acks instead of retrying, like a malformed payload.
func Permanent(err error) error { return &permanentError{err: err} }

type retryAfterError struct {
	delay time.Duration
	err   error
}

func (err *retryAfterError) Error() string { return err.err.Error() }
func (err *retryAfterError) Unwrap() error { return err.err }

// RetryAfter marks a handler error the worker retries after delay, clamped to 0 through MaxDelay.
func RetryAfter(delay time.Duration, err error) error {
	return &retryAfterError{delay: delay, err: err}
}
