package valkey_test

import (
	"context"
	"queueworker"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	valkeygo "github.com/valkey-io/valkey-go"

	queuevalkey "queueworker/valkey"
)

func TestQueuePublishesReceivesAndAcknowledges(t *testing.T) {
	queue, client, server := newQueue(t, func(options *queuevalkey.Options) {})
	ctx := context.Background()

	err := queue.Publish(ctx, []queueworker.Publication{{
		ID: "job-1", Body: []byte("payload"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	messages, err := queue.Receive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].ID() == "" ||
		string(messages[0].Body()) != "payload" ||
		queueworker.Attempts(messages[0]) != 1 {
		t.Fatalf("messages = %#v", messages)
	}
	if err := queue.Settle(ctx, queueworker.Settlement{Acknowledge: messages}); err != nil {
		t.Fatal(err)
	}
	length, err := client.Do(ctx, client.B().Xlen().Key("jobs").Build()).ToInt64()
	if err != nil {
		t.Fatal(err)
	}
	if length != 0 {
		t.Fatalf("source stream length = %d, want 0", length)
	}
	if server.Exists("jobs:dlq") {
		t.Fatal("dead-letter stream was created for an acknowledged message")
	}
}

func TestQueueMovesExpiredPoisonMessageToDeadLetterStream(t *testing.T) {
	queue, client, server := newQueue(t, func(options *queuevalkey.Options) {
		options.MaxDeliveries = 1
		options.VisibilityTimeout = time.Second
	})
	ctx := context.Background()

	if err := queue.Publish(ctx, []queueworker.Publication{{Body: []byte("poison")}}); err != nil {
		t.Fatal(err)
	}
	messages, err := queue.Receive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 {
		t.Fatalf("first receive count = %d, want 1", len(messages))
	}
	if err := queue.Settle(ctx, queueworker.Settlement{Retry: messages}); err != nil {
		t.Fatal(err)
	}
	server.SetTime(time.Unix(1_002, 0))

	messages, err = queue.Receive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 0 {
		t.Fatalf("second receive count = %d, want poison message suppressed", len(messages))
	}
	deadLetters, err := client.Do(
		ctx,
		client.B().Xrange().Key("jobs:dlq").Start("-").End("+").Build(),
	).AsXRange()
	if err != nil {
		t.Fatal(err)
	}
	if len(deadLetters) != 1 || deadLetters[0].FieldValues["body"] != "poison" ||
		deadLetters[0].FieldValues["deliveries"] != "2" {
		t.Fatalf("dead letters = %#v", deadLetters)
	}
}

func newQueue(
	t *testing.T,
	configure func(*queuevalkey.Options),
) (*queuevalkey.Queue, valkeygo.Client, *miniredis.Miniredis) {
	t.Helper()
	server := miniredis.RunT(t)
	server.SetTime(time.Unix(1_000, 0))
	client, err := valkeygo.NewClient(valkeygo.ClientOption{
		InitAddress:  []string{server.Addr()},
		DisableCache: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	options := queuevalkey.DefaultOptions("jobs", "workers", "worker-1")
	options.BlockTime = time.Millisecond
	configure(&options)
	queue, err := queuevalkey.New(client, options)
	if err != nil {
		client.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = queue.Close() })
	return queue, client, server
}
