package sqs_test

import (
	"context"
	"queueworker"
	"reflect"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"

	sqsqueue "queueworker/sqs"
)

func TestQueueReceivesDeliveriesWithLongPolling(t *testing.T) {
	t.Parallel()

	client := &fakeClient{messages: []types.Message{{
		MessageId:     aws.String("message-1"),
		ReceiptHandle: aws.String("receipt-1"),
		Body:          aws.String("body-1"),
	}}}
	queue, err := sqsqueue.New(client, "queue-url")
	if err != nil {
		t.Fatal(err)
	}

	messages, err := queue.Receive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].ID() != "message-1" || string(messages[0].Body()) != "body-1" {
		t.Fatalf("messages = %#v", messages)
	}
	if client.receiveInput == nil {
		t.Fatal("ReceiveMessage was not called")
	}
	if aws.ToString(client.receiveInput.QueueUrl) != "queue-url" ||
		client.receiveInput.MaxNumberOfMessages != 10 ||
		client.receiveInput.WaitTimeSeconds != 20 ||
		client.receiveInput.VisibilityTimeout != 60 {
		t.Fatalf("receive input = %#v", client.receiveInput)
	}
}

func TestQueueAcknowledgesByReceiptHandle(t *testing.T) {
	t.Parallel()

	client := &fakeClient{messages: []types.Message{
		{MessageId: aws.String("first"), ReceiptHandle: aws.String("receipt-1")},
		{MessageId: aws.String("second"), ReceiptHandle: aws.String("receipt-2")},
	}}
	queue, err := sqsqueue.New(client, "queue-url")
	if err != nil {
		t.Fatal(err)
	}
	messages, err := queue.Receive(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if err := queue.Settle(context.Background(), queueworker.Settlement{Acknowledge: messages}); err != nil {
		t.Fatal(err)
	}
	if got := client.deleteInput.Entries; len(got) != 2 ||
		aws.ToString(got[0].ReceiptHandle) != "receipt-1" ||
		aws.ToString(got[1].ReceiptHandle) != "receipt-2" {
		t.Fatalf("delete entries = %#v", got)
	}
	if !reflect.DeepEqual(
		[]string{aws.ToString(client.deleteInput.Entries[0].Id), aws.ToString(client.deleteInput.Entries[1].Id)},
		[]string{"0", "1"},
	) {
		t.Fatalf("delete IDs = %#v", client.deleteInput.Entries)
	}
}

func TestQueueReportsPartialAcknowledgmentFailures(t *testing.T) {
	t.Parallel()

	client := &fakeClient{
		messages: []types.Message{{
			MessageId:     aws.String("message-1"),
			ReceiptHandle: aws.String("receipt-1"),
		}},
		deleteOutput: &awssqs.DeleteMessageBatchOutput{Failed: []types.BatchResultErrorEntry{{
			Id:      aws.String("0"),
			Code:    aws.String("InternalError"),
			Message: aws.String("try again"),
		}}},
	}
	queue, err := sqsqueue.New(client, "queue-url")
	if err != nil {
		t.Fatal(err)
	}
	messages, err := queue.Receive(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	err = queue.Settle(context.Background(), queueworker.Settlement{Acknowledge: messages})
	if err == nil {
		t.Fatal("Acknowledge returned nil for a partial batch failure")
	}
}

func TestQueueRejectsForeignMessages(t *testing.T) {
	t.Parallel()

	queue, err := sqsqueue.New(&fakeClient{}, "queue-url")
	if err != nil {
		t.Fatal(err)
	}
	err = queue.Settle(context.Background(), queueworker.Settlement{
		Acknowledge: []queueworker.Message{foreignMessage{}},
	})
	if err == nil {
		t.Fatal("Settle returned nil for a foreign message")
	}
}

func TestQueueRetriesImmediatelyWhenConfigured(t *testing.T) {
	t.Parallel()

	delay := time.Duration(0)
	client := &fakeClient{messages: []types.Message{{
		MessageId:     aws.String("message-1"),
		ReceiptHandle: aws.String("receipt-1"),
	}}}
	options := sqsqueue.DefaultOptions()
	options.RetryDelay = &delay
	queue, err := sqsqueue.New(client, "queue-url", options)
	if err != nil {
		t.Fatal(err)
	}
	messages, err := queue.Receive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := queue.Settle(context.Background(), queueworker.Settlement{Retry: messages}); err != nil {
		t.Fatal(err)
	}
	if client.visibilityInput == nil ||
		client.visibilityInput.Entries[0].VisibilityTimeout != 0 ||
		aws.ToString(client.visibilityInput.Entries[0].ReceiptHandle) != "receipt-1" {
		t.Fatalf("visibility input = %#v", client.visibilityInput)
	}
}

type fakeClient struct {
	messages        []types.Message
	receiveInput    *awssqs.ReceiveMessageInput
	deleteInput     *awssqs.DeleteMessageBatchInput
	deleteOutput    *awssqs.DeleteMessageBatchOutput
	visibilityInput *awssqs.ChangeMessageVisibilityBatchInput
	sendInput       *awssqs.SendMessageBatchInput
	sendOutput      *awssqs.SendMessageBatchOutput
}

func (client *fakeClient) ChangeMessageVisibilityBatch(
	_ context.Context,
	input *awssqs.ChangeMessageVisibilityBatchInput,
	_ ...func(*awssqs.Options),
) (*awssqs.ChangeMessageVisibilityBatchOutput, error) {
	client.visibilityInput = input
	return &awssqs.ChangeMessageVisibilityBatchOutput{}, nil
}

func (client *fakeClient) SendMessageBatch(
	_ context.Context,
	input *awssqs.SendMessageBatchInput,
	_ ...func(*awssqs.Options),
) (*awssqs.SendMessageBatchOutput, error) {
	client.sendInput = input
	if client.sendOutput != nil {
		return client.sendOutput, nil
	}
	return &awssqs.SendMessageBatchOutput{}, nil
}

func (client *fakeClient) ReceiveMessage(
	_ context.Context,
	input *awssqs.ReceiveMessageInput,
	_ ...func(*awssqs.Options),
) (*awssqs.ReceiveMessageOutput, error) {
	client.receiveInput = input
	return &awssqs.ReceiveMessageOutput{Messages: client.messages}, nil
}

func (client *fakeClient) DeleteMessageBatch(
	_ context.Context,
	input *awssqs.DeleteMessageBatchInput,
	_ ...func(*awssqs.Options),
) (*awssqs.DeleteMessageBatchOutput, error) {
	client.deleteInput = input
	if client.deleteOutput != nil {
		return client.deleteOutput, nil
	}
	return &awssqs.DeleteMessageBatchOutput{}, nil
}

type foreignMessage struct{}

func (foreignMessage) ID() string   { return "foreign" }
func (foreignMessage) Body() []byte { return nil }
