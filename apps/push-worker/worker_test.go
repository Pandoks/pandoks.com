package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

func TestWorkerPollDeletesOnlySuccessfulMessages(t *testing.T) {
	t.Parallel()

	queue := &fakeSQS{
		messages: []types.Message{
			{
				MessageId:     aws.String("message-1"),
				ReceiptHandle: aws.String("receipt-1"),
				Body: aws.String(`{
                  "id":"apns-ok",
                  "provider":"apns",
                  "apns":{"token":"token","topic":"com.example","pushType":"alert","priority":10,"payload":{"aps":{}}}
                }`),
			},
			{
				MessageId:     aws.String("message-2"),
				ReceiptHandle: aws.String("receipt-2"),
				Body: aws.String(`{
                  "id":"fcm-fails",
                  "provider":"fcm",
                  "fcm":{"fid":"installation","data":{"test":"true"}}
                }`),
			},
			{
				MessageId:     aws.String("message-3"),
				ReceiptHandle: aws.String("receipt-3"),
				Body:          aws.String(`{"not":"a job"}`),
			},
		},
	}
	sender := &fakeJobSender{fail: map[string]error{"fcm-fails": errors.New("provider unavailable")}}
	worker := NewWorker(queue, "queue-url", sender, slog.New(slog.NewJSONHandler(io.Discard, nil)))

	if err := worker.poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if queue.receiveInput.MaxNumberOfMessages != 10 {
		t.Fatalf("max messages = %d", queue.receiveInput.MaxNumberOfMessages)
	}
	if queue.receiveInput.WaitTimeSeconds != 20 {
		t.Fatalf("wait time = %d", queue.receiveInput.WaitTimeSeconds)
	}
	if queue.receiveInput.VisibilityTimeout != 60 {
		t.Fatalf("visibility timeout = %d", queue.receiveInput.VisibilityTimeout)
	}
	if len(queue.deleted) != 1 || aws.ToString(queue.deleted[0].ReceiptHandle) != "receipt-1" {
		t.Fatalf("deleted = %#v", queue.deleted)
	}
	if len(sender.sent) != 2 {
		t.Fatalf("sent = %#v", sender.sent)
	}
}

func TestWorkerPollDispatchesConcurrently(t *testing.T) {
	t.Parallel()

	queue := &fakeSQS{messages: []types.Message{
		fcmQueueMessage("message-1", "receipt-1", "job-1"),
		fcmQueueMessage("message-2", "receipt-2", "job-2"),
	}}
	sender := newBlockingSender()
	worker := NewWorker(queue, "queue-url", sender, slog.New(slog.NewJSONHandler(io.Discard, nil)))

	done := make(chan error, 1)
	go func() {
		done <- worker.poll(context.Background())
	}()

	for range 2 {
		<-sender.started
	}
	close(sender.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(queue.deleted) != 2 {
		t.Fatalf("deleted = %d, want 2", len(queue.deleted))
	}
}

func TestWorkerPollDeletesPermanentFailures(t *testing.T) {
	t.Parallel()

	queue := &fakeSQS{messages: []types.Message{
		fcmQueueMessage("message-1", "receipt-1", "unregistered"),
	}}
	sender := &fakeJobSender{fail: map[string]error{
		"unregistered": newPermanentError(errors.New("device is unregistered")),
	}}
	worker := NewWorker(queue, "queue-url", sender, slog.New(slog.NewJSONHandler(io.Discard, nil)))

	if err := worker.poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(queue.deleted) != 1 || aws.ToString(queue.deleted[0].ReceiptHandle) != "receipt-1" {
		t.Fatalf("deleted = %#v", queue.deleted)
	}
}

func TestWorkerRunStopsOnCancellation(t *testing.T) {
	t.Parallel()

	queue := &fakeSQS{receive: func(ctx context.Context) (*sqs.ReceiveMessageOutput, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	worker := NewWorker(
		queue,
		"queue-url",
		&fakeJobSender{},
		slog.New(slog.NewJSONHandler(io.Discard, nil)),
	)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := worker.Run(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerPollTimesOutDelivery(t *testing.T) {
	t.Parallel()

	queue := &fakeSQS{messages: []types.Message{
		fcmQueueMessage("message-1", "receipt-1", "slow"),
	}}
	sender := &contextSender{timedOut: make(chan bool, 1)}
	worker := NewWorker(queue, "queue-url", sender, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	worker.deliveryTimeout = 10 * time.Millisecond

	if err := worker.poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if timedOut := <-sender.timedOut; !timedOut {
		t.Fatal("delivery context did not time out")
	}
	if len(queue.deleted) != 0 {
		t.Fatalf("deleted = %#v", queue.deleted)
	}
}

func TestDispatcherRoutesProviders(t *testing.T) {
	t.Parallel()

	apns := &fakeAPNsSender{}
	fcm := &fakeFCMSender{}
	dispatcher := Dispatcher{APNs: apns, FCM: fcm}

	if err := dispatcher.Send(context.Background(), Job{
		ID:       "1",
		Provider: ProviderAPNs,
		APNs:     &APNsJob{Token: "apns"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := dispatcher.Send(context.Background(), Job{
		ID:       "2",
		Provider: ProviderFCM,
		FCM:      &FCMJob{FID: "fcm"},
	}); err != nil {
		t.Fatal(err)
	}
	if apns.token != "apns" || fcm.fid != "fcm" {
		t.Fatalf("APNs token = %q, FCM FID = %q", apns.token, fcm.fid)
	}
}

type fakeSQS struct {
	messages     []types.Message
	receive      func(context.Context) (*sqs.ReceiveMessageOutput, error)
	receiveInput *sqs.ReceiveMessageInput
	deleted      []types.DeleteMessageBatchRequestEntry
}

func (queue *fakeSQS) ReceiveMessage(
	ctx context.Context,
	input *sqs.ReceiveMessageInput,
	_ ...func(*sqs.Options),
) (*sqs.ReceiveMessageOutput, error) {
	queue.receiveInput = input
	if queue.receive != nil {
		return queue.receive(ctx)
	}
	return &sqs.ReceiveMessageOutput{Messages: queue.messages}, nil
}

func (queue *fakeSQS) DeleteMessageBatch(
	_ context.Context,
	input *sqs.DeleteMessageBatchInput,
	_ ...func(*sqs.Options),
) (*sqs.DeleteMessageBatchOutput, error) {
	queue.deleted = append(queue.deleted, input.Entries...)
	return &sqs.DeleteMessageBatchOutput{}, nil
}

type fakeJobSender struct {
	mu   sync.Mutex
	fail map[string]error
	sent []Job
}

func (sender *fakeJobSender) Send(_ context.Context, job Job) error {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	sender.sent = append(sender.sent, job)
	return sender.fail[job.ID]
}

type blockingSender struct {
	started chan struct{}
	release chan struct{}
}

type contextSender struct {
	timedOut chan bool
}

func (sender *contextSender) Send(ctx context.Context, _ Job) error {
	select {
	case <-ctx.Done():
		sender.timedOut <- errors.Is(ctx.Err(), context.DeadlineExceeded)
		return ctx.Err()
	case <-time.After(time.Second):
		sender.timedOut <- false
		return errors.New("delivery context was not cancelled")
	}
}

func newBlockingSender() *blockingSender {
	return &blockingSender{
		started: make(chan struct{}, 2),
		release: make(chan struct{}),
	}
}

func (sender *blockingSender) Send(_ context.Context, _ Job) error {
	sender.started <- struct{}{}
	<-sender.release
	return nil
}

type fakeAPNsSender struct {
	token string
}

func (sender *fakeAPNsSender) Send(_ context.Context, job APNsJob) error {
	sender.token = job.Token
	return nil
}

type fakeFCMSender struct {
	fid string
}

func (sender *fakeFCMSender) Send(_ context.Context, job FCMJob) error {
	sender.fid = job.FID
	return nil
}

func fcmQueueMessage(messageID, receipt, jobID string) types.Message {
	return types.Message{
		MessageId:     aws.String(messageID),
		ReceiptHandle: aws.String(receipt),
		Body: aws.String(`{
          "id":"` + jobID + `",
          "provider":"fcm",
          "fcm":{"fid":"installation","data":{"test":"true"}}
        }`),
	}
}
