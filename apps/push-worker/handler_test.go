package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"queueworker"
	"testing"
)

func TestPushHandlerAcknowledgmentPolicy(t *testing.T) {
	t.Parallel()

	retryable := errors.New("provider unavailable")
	tests := []struct {
		name         string
		body         string
		sendError    error
		acknowledged bool
	}{
		{
			name:         "success",
			body:         fcmJobBody("success"),
			acknowledged: true,
		},
		{
			name:         "invalid job",
			body:         `{"not":"a job"}`,
			acknowledged: true,
		},
		{
			name:         "permanent provider failure",
			body:         fcmJobBody("permanent"),
			sendError:    newPermanentError(errors.New("device is unregistered")),
			acknowledged: true,
		},
		{
			name:      "retryable provider failure",
			body:      fcmJobBody("retry"),
			sendError: retryable,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			ctx, cancel := context.WithCancel(context.Background())
			queue := &oneMessageQueue{
				message: testMessage{id: "message", body: []byte(test.body)},
				cancel:  cancel,
			}
			handler := NewPushHandler(
				&fakeJobSender{err: test.sendError},
				slog.New(slog.NewJSONHandler(io.Discard, nil)),
			)
			runner := queueworker.New(queue, handler, queueworker.Options{
				Logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
			})

			if err := runner.Run(ctx); err != nil {
				t.Fatal(err)
			}
			if queue.acknowledged != test.acknowledged {
				t.Fatalf("acknowledged = %t, want %t", queue.acknowledged, test.acknowledged)
			}
		})
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

type testMessage struct {
	id   string
	body []byte
}

func (message testMessage) ID() string   { return message.id }
func (message testMessage) Body() []byte { return message.body }

type oneMessageQueue struct {
	message      queueworker.Message
	cancel       context.CancelFunc
	received     bool
	acknowledged bool
}

func (queue *oneMessageQueue) Receive(ctx context.Context) ([]queueworker.Message, error) {
	if !queue.received {
		queue.received = true
		return []queueworker.Message{queue.message}, nil
	}
	queue.cancel()
	<-ctx.Done()
	return nil, ctx.Err()
}

func (queue *oneMessageQueue) Acknowledge(context.Context, []queueworker.Message) error {
	queue.acknowledged = true
	queue.cancel()
	return nil
}

type fakeJobSender struct {
	err error
}

func (sender *fakeJobSender) Send(context.Context, Job) error {
	return sender.err
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

func fcmJobBody(jobID string) string {
	return `{"id":"` + jobID + `","provider":"fcm","fcm":{"fid":"installation","data":{"test":"true"}}}`
}
