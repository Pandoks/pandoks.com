package queueworker_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"queueworker"
	"sync"
	"testing"
	"time"
)

func TestRunnerAcknowledgesSuccessAndDiscardOnly(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	queue := &fakeQueue{
		messages: []queueworker.Message{
			fakeMessage{id: "success", body: []byte("success")},
			fakeMessage{id: "retry", body: []byte("retry")},
			fakeMessage{id: "discard", body: []byte("discard")},
		},
		acknowledged: make(chan []queueworker.Message, 1),
		cancel:       cancel,
	}
	runner := queueworker.New(queue, queueworker.HandlerFunc(func(_ context.Context, message queueworker.Message) error {
		switch string(message.Body()) {
		case "retry":
			return errors.New("temporary failure")
		case "discard":
			return queueworker.Discard(errors.New("invalid work"))
		default:
			return nil
		}
	}), queueworker.Options{Logger: discardLogger()})

	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}

	acknowledged := <-queue.acknowledged
	if len(acknowledged) != 2 {
		t.Fatalf("acknowledged = %d, want 2", len(acknowledged))
	}
	if acknowledged[0].ID() != "success" || acknowledged[1].ID() != "discard" {
		t.Fatalf("acknowledged = %q, %q", acknowledged[0].ID(), acknowledged[1].ID())
	}
}

func TestRunnerBoundsConcurrency(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	queue := &fakeQueue{
		messages: []queueworker.Message{
			fakeMessage{id: "1"},
			fakeMessage{id: "2"},
			fakeMessage{id: "3"},
		},
		acknowledged: make(chan []queueworker.Message, 1),
		cancel:       cancel,
	}
	started := make(chan struct{}, 3)
	release := make(chan struct{})
	runner := queueworker.New(queue, queueworker.HandlerFunc(func(context.Context, queueworker.Message) error {
		started <- struct{}{}
		<-release
		return nil
	}), queueworker.Options{Concurrency: 2, Logger: discardLogger()})

	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()

	<-started
	<-started
	select {
	case <-started:
		t.Fatal("third handler started before a concurrency slot was released")
	case <-time.After(20 * time.Millisecond):
	}
	release <- struct{}{}
	<-started
	release <- struct{}{}
	release <- struct{}{}

	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRunnerTimesOutHandlers(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	queue := &fakeQueue{
		messages:     []queueworker.Message{fakeMessage{id: "slow"}},
		acknowledged: make(chan []queueworker.Message, 1),
		cancel:       cancel,
	}
	timedOut := make(chan bool, 1)
	runner := queueworker.New(queue, queueworker.HandlerFunc(func(ctx context.Context, _ queueworker.Message) error {
		<-ctx.Done()
		timedOut <- errors.Is(ctx.Err(), context.DeadlineExceeded)
		cancel()
		return ctx.Err()
	}), queueworker.Options{HandlerTimeout: 10 * time.Millisecond, Logger: discardLogger()})

	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if !<-timedOut {
		t.Fatal("handler context did not reach its deadline")
	}
	acknowledged := <-queue.acknowledged
	if len(acknowledged) != 0 {
		t.Fatalf("acknowledged = %#v, want none", acknowledged)
	}
}

func TestRunnerRetriesReceiveErrorsUntilCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	queue := &failingQueue{cancel: cancel}
	runner := queueworker.New(queue, queueworker.HandlerFunc(func(context.Context, queueworker.Message) error {
		return nil
	}), queueworker.Options{PollErrorDelay: time.Millisecond, Logger: discardLogger()})

	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if queue.receives != 2 {
		t.Fatalf("receives = %d, want 2", queue.receives)
	}
}

func TestRunnerSettlesCompletedWorkAfterCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	queue := &cancellationQueue{message: fakeMessage{id: "completed"}}
	runner := queueworker.New(queue, queueworker.HandlerFunc(func(context.Context, queueworker.Message) error {
		cancel()
		return nil
	}), queueworker.Options{SettleTimeout: time.Second, Logger: discardLogger()})

	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if queue.settleErr != nil {
		t.Fatalf("settlement context error = %v", queue.settleErr)
	}
	if len(queue.acknowledged) != 1 || queue.acknowledged[0].ID() != "completed" {
		t.Fatalf("acknowledged = %#v", queue.acknowledged)
	}
}

func TestRunnerRetriesPanickingHandlers(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	queue := &retryQueue{
		message: fakeMessage{id: "panic"},
		cancel:  cancel,
	}
	runner := queueworker.New(queue, queueworker.HandlerFunc(func(context.Context, queueworker.Message) error {
		panic("boom")
	}), queueworker.Options{Logger: discardLogger()})

	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(queue.retried) != 1 || queue.retried[0].ID() != "panic" {
		t.Fatalf("retried = %#v", queue.retried)
	}
}

type fakeMessage struct {
	id   string
	body []byte
}

func (message fakeMessage) ID() string   { return message.id }
func (message fakeMessage) Body() []byte { return message.body }

type fakeQueue struct {
	mu           sync.Mutex
	messages     []queueworker.Message
	acknowledged chan []queueworker.Message
	cancel       context.CancelFunc
	received     bool
}

func (queue *fakeQueue) Receive(ctx context.Context) ([]queueworker.Message, error) {
	queue.mu.Lock()
	if !queue.received {
		queue.received = true
		messages := queue.messages
		queue.mu.Unlock()
		return messages, nil
	}
	queue.mu.Unlock()
	<-ctx.Done()
	return nil, ctx.Err()
}

func (queue *fakeQueue) Settle(_ context.Context, settlement queueworker.Settlement) error {
	queue.acknowledged <- settlement.Acknowledge
	queue.cancel()
	return nil
}

type failingQueue struct {
	receives int
	cancel   context.CancelFunc
}

func (queue *failingQueue) Receive(context.Context) ([]queueworker.Message, error) {
	queue.receives++
	if queue.receives == 2 {
		queue.cancel()
	}
	return nil, errors.New("queue unavailable")
}

func (*failingQueue) Settle(context.Context, queueworker.Settlement) error { return nil }

type cancellationQueue struct {
	message      queueworker.Message
	received     bool
	acknowledged []queueworker.Message
	settleErr    error
}

func (queue *cancellationQueue) Receive(context.Context) ([]queueworker.Message, error) {
	if queue.received {
		return nil, errors.New("unexpected second receive")
	}
	queue.received = true
	return []queueworker.Message{queue.message}, nil
}

func (queue *cancellationQueue) Settle(
	ctx context.Context,
	settlement queueworker.Settlement,
) error {
	queue.settleErr = ctx.Err()
	queue.acknowledged = append(queue.acknowledged, settlement.Acknowledge...)
	return nil
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
