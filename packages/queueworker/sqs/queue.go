package sqs

import (
	"context"
	"fmt"
	"queueworker"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

const (
	maxMessages       = 10
	waitTimeSeconds   = 20
	visibilityTimeout = 60
)

type Client interface {
	ReceiveMessage(
		context.Context,
		*awssqs.ReceiveMessageInput,
		...func(*awssqs.Options),
	) (*awssqs.ReceiveMessageOutput, error)
	DeleteMessageBatch(
		context.Context,
		*awssqs.DeleteMessageBatchInput,
		...func(*awssqs.Options),
	) (*awssqs.DeleteMessageBatchOutput, error)
}

type Queue struct {
	client   Client
	queueURL string
}

func New(client Client, queueURL string) *Queue {
	return &Queue{client: client, queueURL: queueURL}
}

func (queue *Queue) Receive(ctx context.Context) ([]queueworker.Message, error) {
	output, err := queue.client.ReceiveMessage(ctx, &awssqs.ReceiveMessageInput{
		QueueUrl:            aws.String(queue.queueURL),
		MaxNumberOfMessages: maxMessages,
		WaitTimeSeconds:     waitTimeSeconds,
		VisibilityTimeout:   visibilityTimeout,
	})
	if err != nil {
		return nil, fmt.Errorf("receive SQS messages: %w", err)
	}

	messages := make([]queueworker.Message, 0, len(output.Messages))
	for _, message := range output.Messages {
		receiptHandle := aws.ToString(message.ReceiptHandle)
		if receiptHandle == "" {
			return nil, fmt.Errorf("receive SQS message %q: receipt handle is missing", aws.ToString(message.MessageId))
		}
		messages = append(messages, &delivery{
			queue:         queue,
			id:            aws.ToString(message.MessageId),
			body:          []byte(aws.ToString(message.Body)),
			receiptHandle: receiptHandle,
		})
	}
	return messages, nil
}

func (queue *Queue) Acknowledge(ctx context.Context, messages []queueworker.Message) error {
	if len(messages) == 0 {
		return nil
	}
	entries := make([]types.DeleteMessageBatchRequestEntry, 0, len(messages))
	for index, message := range messages {
		item, ok := message.(*delivery)
		if !ok || item.queue != queue {
			return fmt.Errorf("acknowledge SQS message %q: message belongs to another queue", message.ID())
		}
		entries = append(entries, types.DeleteMessageBatchRequestEntry{
			Id:            aws.String(strconv.Itoa(index)),
			ReceiptHandle: aws.String(item.receiptHandle),
		})
	}

	output, err := queue.client.DeleteMessageBatch(ctx, &awssqs.DeleteMessageBatchInput{
		QueueUrl: aws.String(queue.queueURL),
		Entries:  entries,
	})
	if err != nil {
		return fmt.Errorf("delete SQS messages: %w", err)
	}
	if len(output.Failed) != 0 {
		return fmt.Errorf("delete SQS messages: %d batch entries failed", len(output.Failed))
	}
	return nil
}

type delivery struct {
	queue         *Queue
	id            string
	body          []byte
	receiptHandle string
}

func (message *delivery) ID() string   { return message.id }
func (message *delivery) Body() []byte { return message.body }
