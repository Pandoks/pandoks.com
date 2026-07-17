package queueworker

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	defaultConcurrency    = 10
	defaultHandlerTimeout = 30 * time.Second
	defaultPollErrorDelay = time.Second
)

type Message interface {
	ID() string
	Body() []byte
}

type Queue interface {
	Receive(context.Context) ([]Message, error)
	Acknowledge(context.Context, []Message) error
}

type Handler interface {
	Handle(context.Context, []byte) error
}

type HandlerFunc func(context.Context, []byte) error

func (handler HandlerFunc) Handle(ctx context.Context, body []byte) error {
	return handler(ctx, body)
}

type Options struct {
	Concurrency    int
	HandlerTimeout time.Duration
	PollErrorDelay time.Duration
	Logger         *slog.Logger
}

type Runner struct {
	queue          Queue
	handler        Handler
	concurrency    int
	handlerTimeout time.Duration
	pollErrorDelay time.Duration
	logger         *slog.Logger
}

func New(queue Queue, handler Handler, options Options) *Runner {
	if options.Concurrency <= 0 {
		options.Concurrency = defaultConcurrency
	}
	if options.HandlerTimeout <= 0 {
		options.HandlerTimeout = defaultHandlerTimeout
	}
	if options.PollErrorDelay <= 0 {
		options.PollErrorDelay = defaultPollErrorDelay
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return &Runner{
		queue:          queue,
		handler:        handler,
		concurrency:    options.Concurrency,
		handlerTimeout: options.HandlerTimeout,
		pollErrorDelay: options.PollErrorDelay,
		logger:         options.Logger,
	}
}

func (runner *Runner) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		messages, err := runner.queue.Receive(ctx)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) {
				return nil
			}
			runner.logger.Error("queue receive failed", "error", err)
			if !wait(ctx, runner.pollErrorDelay) {
				return nil
			}
			continue
		}

		acknowledged := runner.process(ctx, messages)
		if len(acknowledged) == 0 {
			continue
		}
		if err := runner.queue.Acknowledge(ctx, acknowledged); err != nil {
			runner.logger.Error(
				"queue acknowledge failed",
				"count", len(acknowledged),
				"error", err,
			)
		}
	}
	return nil
}

func (runner *Runner) process(ctx context.Context, messages []Message) []Message {
	if len(messages) == 0 {
		return nil
	}

	acknowledge := make([]bool, len(messages))
	jobs := make(chan int)
	workers := min(runner.concurrency, len(messages))
	done := make(chan struct{}, workers)
	for range workers {
		go func() {
			defer func() { done <- struct{}{} }()
			for index := range jobs {
				message := messages[index]
				handlerContext, cancel := context.WithTimeout(ctx, runner.handlerTimeout)
				err := runner.handler.Handle(handlerContext, message.Body())
				cancel()

				switch {
				case err == nil:
					acknowledge[index] = true
				case isDiscard(err):
					acknowledge[index] = true
					runner.logger.Warn(
						"queue message discarded",
						"message_id", message.ID(),
						"error", err,
					)
				default:
					runner.logger.Error(
						"queue message failed",
						"message_id", message.ID(),
						"error", err,
					)
				}
			}
		}()
	}
	for index := range messages {
		jobs <- index
	}
	close(jobs)
	for range workers {
		<-done
	}

	result := make([]Message, 0, len(messages))
	for index, message := range messages {
		if acknowledge[index] {
			result = append(result, message)
		}
	}
	return result
}

type discardError struct {
	err error
}

func (err discardError) Error() string { return err.err.Error() }
func (err discardError) Unwrap() error { return err.err }

func Discard(err error) error {
	return discardError{err: err}
}

func isDiscard(err error) bool {
	var target discardError
	return errors.As(err, &target)
}

func wait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
