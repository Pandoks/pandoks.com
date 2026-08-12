package sqs_test

import (
	"context"
	"errors"
	"queueworker"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"

	sqsqueue "queueworker/sqs"
)

func TestPublisherBatchesMessages(t *testing.T) {
	t.Parallel()

	client := &fakeClient{}
	publisher, err := sqsqueue.NewPublisher(client, "queue-url", sqsqueue.PublisherOptions{BatchSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	messages := []queueworker.Publication{
		{ID: "1", Body: []byte("one")},
		{ID: "2", Body: []byte("two")},
	}
	if err := publisher.Publish(context.Background(), messages); err != nil {
		t.Fatal(err)
	}
	if client.sendInput == nil || len(client.sendInput.Entries) != 2 {
		t.Fatalf("send input = %#v", client.sendInput)
	}
	if aws.ToString(client.sendInput.Entries[0].MessageBody) != "one" {
		t.Fatalf("first body = %q", aws.ToString(client.sendInput.Entries[0].MessageBody))
	}
}

func TestPublisherReportsPartialFailures(t *testing.T) {
	t.Parallel()

	client := &fakeClient{sendOutput: &awssqs.SendMessageBatchOutput{
		Failed: []types.BatchResultErrorEntry{{
			Id:      aws.String("1"),
			Code:    aws.String("InternalError"),
			Message: aws.String("retry"),
		}},
	}}
	publisher, err := sqsqueue.NewPublisher(client, "queue-url")
	if err != nil {
		t.Fatal(err)
	}
	err = publisher.Publish(context.Background(), []queueworker.Publication{
		{ID: "first", Body: []byte("one")},
		{ID: "second", Body: []byte("two")},
	})
	var publishError *queueworker.PublishError
	if !errors.As(err, &publishError) {
		t.Fatalf("error = %v", err)
	}
	if len(publishError.Failures) != 1 || publishError.Failures[0].ID != "second" {
		t.Fatalf("failures = %#v", publishError.Failures)
	}
}
