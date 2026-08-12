package queueworker_test

import (
	"context"
	"errors"
	"queueworker"
	"testing"
)

func TestRunnerSettlesRetryableMessages(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	queue := &retryQueue{
		message: fakeMessage{id: "retry", body: []byte("retry")},
		cancel:  cancel,
	}
	runner := queueworker.New(queue, queueworker.HandlerFunc(func(context.Context, queueworker.Message) error {
		return errors.New("temporary failure")
	}), queueworker.Options{Logger: discardLogger()})

	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(queue.retried) != 1 || queue.retried[0].ID() != "retry" {
		t.Fatalf("retried = %#v", queue.retried)
	}
}

type retryQueue struct {
	message  queueworker.Message
	retried  []queueworker.Message
	cancel   context.CancelFunc
	received bool
}

func (queue *retryQueue) Receive(ctx context.Context) ([]queueworker.Message, error) {
	if !queue.received {
		queue.received = true
		return []queueworker.Message{queue.message}, nil
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func (queue *retryQueue) Settle(_ context.Context, settlement queueworker.Settlement) error {
	queue.retried = append(queue.retried, settlement.Retry...)
	queue.cancel()
	return nil
}
