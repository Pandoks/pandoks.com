package queueworker

import (
	"context"
	"errors"
	"log/slog"
	"runtime/debug"
	"time"
)

const (
	defaultConcurrency    = 10
	defaultHandlerTimeout = 30 * time.Second
	defaultPollErrorDelay = time.Second
	defaultSettleTimeout  = 10 * time.Second
)

type Message interface {
	ID() string
	Body() []byte
}

type attemptedMessage interface {
	Attempts() int
}

func Attempts(message Message) int {
	if attempted, ok := message.(attemptedMessage); ok && attempted.Attempts() > 0 {
		return attempted.Attempts()
	}
	return 1
}

type Queue interface {
	Receive(context.Context) ([]Message, error)
	Settle(context.Context, Settlement) error
}

type Handler interface {
	Handle(context.Context, Message) error
}

type HandlerFunc func(context.Context, Message) error

func (handler HandlerFunc) Handle(ctx context.Context, message Message) error {
	return handler(ctx, message)
}

type Settlement struct {
	Acknowledge []Message
	Retry       []Message
}

type Options struct {
	Concurrency    int
	HandlerTimeout time.Duration
	PollErrorDelay time.Duration
	SettleTimeout  time.Duration
	Logger         *slog.Logger
}

type Runner struct {
	queue          Queue
	handler        Handler
	concurrency    int
	handlerTimeout time.Duration
	pollErrorDelay time.Duration
	settleTimeout  time.Duration
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
	if options.SettleTimeout <= 0 {
		options.SettleTimeout = defaultSettleTimeout
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
		settleTimeout:  options.SettleTimeout,
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

		settlement := runner.process(ctx, messages)
		if len(settlement.Acknowledge) == 0 && len(settlement.Retry) == 0 {
			continue
		}
		settleContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), runner.settleTimeout)
		err = runner.queue.Settle(settleContext, settlement)
		cancel()
		if err != nil {
			runner.logger.Error(
				"queue settlement failed",
				"acknowledge_count", len(settlement.Acknowledge),
				"retry_count", len(settlement.Retry),
				"error", err,
			)
		}
	}
	return nil
}

func (runner *Runner) process(ctx context.Context, messages []Message) Settlement {
	if len(messages) == 0 {
		return Settlement{}
	}

	actions := make([]bool, len(messages))
	jobs := make(chan int)
	workers := min(runner.concurrency, len(messages))
	done := make(chan struct{}, workers)
	for range workers {
		go func() {
			defer func() { done <- struct{}{} }()
			for index := range jobs {
				message := messages[index]
				err := runner.handle(ctx, message)

				switch {
				case err == nil:
					actions[index] = true
				case isDiscard(err):
					actions[index] = true
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

	settlement := Settlement{
		Acknowledge: make([]Message, 0, len(messages)),
		Retry:       make([]Message, 0, len(messages)),
	}
	for index, message := range messages {
		if actions[index] {
			settlement.Acknowledge = append(settlement.Acknowledge, message)
		} else {
			settlement.Retry = append(settlement.Retry, message)
		}
	}
	return settlement
}

func (runner *Runner) handle(ctx context.Context, message Message) (err error) {
	handlerContext, cancel := context.WithTimeout(ctx, runner.handlerTimeout)
	defer cancel()
	defer func() {
		if recovered := recover(); recovered != nil {
			runner.logger.Error(
				"queue handler panicked",
				"message_id", message.ID(),
				"panic", recovered,
				"stack", string(debug.Stack()),
			)
			err = errors.New("queue handler panicked")
		}
	}()
	return runner.handler.Handle(handlerContext, message)
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
