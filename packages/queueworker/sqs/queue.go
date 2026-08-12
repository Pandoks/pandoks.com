package sqs

import (
	"context"
	"errors"
	"fmt"
	"queueworker"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

const maxBatchSize = 10

type Options struct {
	MaxMessages       int32
	WaitTime          time.Duration
	VisibilityTimeout time.Duration
	RetryDelay        *time.Duration
}

func DefaultOptions() Options {
	return Options{
		MaxMessages:       maxBatchSize,
		WaitTime:          20 * time.Second,
		VisibilityTimeout: 60 * time.Second,
	}
}

func (options Options) validate() error {
	if options.MaxMessages < 1 || options.MaxMessages > maxBatchSize {
		return errors.New("max messages must be between 1 and 10")
	}
	if err := validateSeconds("wait time", options.WaitTime, 20*time.Second); err != nil {
		return err
	}
	if err := validateSeconds("visibility timeout", options.VisibilityTimeout, 12*time.Hour); err != nil {
		return err
	}
	if options.RetryDelay != nil {
		if err := validateSeconds("retry delay", *options.RetryDelay, 12*time.Hour); err != nil {
			return err
		}
	}
	return nil
}

func validateSeconds(name string, value, maximum time.Duration) error {
	if value < 0 || value > maximum || value%time.Second != 0 {
		return fmt.Errorf("%s must be whole seconds between 0 and %s", name, maximum)
	}
	return nil
}

type ConsumerClient interface {
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
	ChangeMessageVisibilityBatch(
		context.Context,
		*awssqs.ChangeMessageVisibilityBatchInput,
		...func(*awssqs.Options),
	) (*awssqs.ChangeMessageVisibilityBatchOutput, error)
}

type Client interface {
	ConsumerClient
	PublisherClient
}

type Queue struct {
	consumerClient   ConsumerClient
	publisherClient  PublisherClient
	queueURL         string
	options          Options
	publisherOptions PublisherOptions
}

func New(client ConsumerClient, queueURL string, configured ...Options) (*Queue, error) {
	options := DefaultOptions()
	if len(configured) > 1 {
		return nil, errors.New("at most one SQS options value is allowed")
	}
	if len(configured) == 1 {
		options = configured[0]
	}
	if client == nil {
		return nil, errors.New("SQS consumer client is required")
	}
	if queueURL == "" {
		return nil, errors.New("SQS queue URL is required")
	}
	if err := options.validate(); err != nil {
		return nil, fmt.Errorf("configure SQS queue: %w", err)
	}
	return &Queue{
		consumerClient:   client,
		queueURL:         queueURL,
		options:          options,
		publisherOptions: DefaultPublisherOptions(),
	}, nil
}

func NewPublisher(
	client PublisherClient,
	queueURL string,
	configured ...PublisherOptions,
) (*Queue, error) {
	options := DefaultPublisherOptions()
	if len(configured) > 1 {
		return nil, errors.New("at most one SQS publisher options value is allowed")
	}
	if len(configured) == 1 {
		options = configured[0]
	}
	if client == nil {
		return nil, errors.New("SQS publisher client is required")
	}
	if queueURL == "" {
		return nil, errors.New("SQS queue URL is required")
	}
	if err := options.validate(); err != nil {
		return nil, fmt.Errorf("configure SQS publisher: %w", err)
	}
	return &Queue{
		publisherClient:  client,
		queueURL:         queueURL,
		options:          DefaultOptions(),
		publisherOptions: options,
	}, nil
}

func NewAdapter(
	client Client,
	queueURL string,
	options Options,
	publisherOptions PublisherOptions,
) (*Queue, error) {
	if client == nil {
		return nil, errors.New("SQS client is required")
	}
	if queueURL == "" {
		return nil, errors.New("SQS queue URL is required")
	}
	if err := options.validate(); err != nil {
		return nil, fmt.Errorf("configure SQS queue: %w", err)
	}
	if err := publisherOptions.validate(); err != nil {
		return nil, fmt.Errorf("configure SQS publisher: %w", err)
	}
	return &Queue{
		consumerClient:   client,
		publisherClient:  client,
		queueURL:         queueURL,
		options:          options,
		publisherOptions: publisherOptions,
	}, nil
}

func (queue *Queue) Receive(ctx context.Context) ([]queueworker.Message, error) {
	if queue.consumerClient == nil {
		return nil, errors.New("receive SQS messages: consumer is not configured")
	}
	output, err := queue.consumerClient.ReceiveMessage(ctx, &awssqs.ReceiveMessageInput{
		QueueUrl:            aws.String(queue.queueURL),
		MaxNumberOfMessages: queue.options.MaxMessages,
		// Durations are bounded to SQS limits by Options.validate.
		WaitTimeSeconds:   int32(queue.options.WaitTime / time.Second),          //nolint:gosec
		VisibilityTimeout: int32(queue.options.VisibilityTimeout / time.Second), //nolint:gosec
		MessageSystemAttributeNames: []types.MessageSystemAttributeName{
			types.MessageSystemAttributeNameApproximateReceiveCount,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("receive SQS messages: %w", err)
	}

	messages := make([]queueworker.Message, 0, len(output.Messages))
	for _, message := range output.Messages {
		receiptHandle := aws.ToString(message.ReceiptHandle)
		if receiptHandle == "" {
			return nil, fmt.Errorf(
				"receive SQS message %q: receipt handle is missing",
				aws.ToString(message.MessageId),
			)
		}
		attempts := 1
		if encoded := message.Attributes[string(types.MessageSystemAttributeNameApproximateReceiveCount)]; encoded != "" {
			parsed, parseErr := strconv.Atoi(encoded)
			if parseErr != nil || parsed < 1 {
				return nil, fmt.Errorf(
					"receive SQS message %q: invalid receive count %q",
					aws.ToString(message.MessageId),
					encoded,
				)
			}
			attempts = parsed
		}
		messages = append(messages, &delivery{
			queue:         queue,
			id:            aws.ToString(message.MessageId),
			body:          []byte(aws.ToString(message.Body)),
			receiptHandle: receiptHandle,
			attempts:      attempts,
		})
	}
	return messages, nil
}

func (queue *Queue) Settle(ctx context.Context, settlement queueworker.Settlement) error {
	acknowledge, err := queue.deliveries(settlement.Acknowledge)
	if err != nil {
		return err
	}
	retry, err := queue.deliveries(settlement.Retry)
	if err != nil {
		return err
	}
	var failures []error
	if err := queue.acknowledge(ctx, acknowledge); err != nil {
		failures = append(failures, err)
	}
	if queue.options.RetryDelay != nil {
		if err := queue.retry(ctx, retry, *queue.options.RetryDelay); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (queue *Queue) deliveries(messages []queueworker.Message) ([]*delivery, error) {
	result := make([]*delivery, 0, len(messages))
	for _, message := range messages {
		item, ok := message.(*delivery)
		if !ok || item.queue != queue {
			return nil, fmt.Errorf(
				"settle SQS message %q: message belongs to another queue",
				message.ID(),
			)
		}
		result = append(result, item)
	}
	return result, nil
}

func (queue *Queue) acknowledge(ctx context.Context, messages []*delivery) error {
	for start := 0; start < len(messages); start += maxBatchSize {
		end := min(start+maxBatchSize, len(messages))
		entries := make([]types.DeleteMessageBatchRequestEntry, 0, end-start)
		for index, message := range messages[start:end] {
			entries = append(entries, types.DeleteMessageBatchRequestEntry{
				Id:            aws.String(strconv.Itoa(index)),
				ReceiptHandle: aws.String(message.receiptHandle),
			})
		}
		output, err := queue.consumerClient.DeleteMessageBatch(ctx, &awssqs.DeleteMessageBatchInput{
			QueueUrl: aws.String(queue.queueURL),
			Entries:  entries,
		})
		if err != nil {
			return fmt.Errorf("delete SQS messages: %w", err)
		}
		if len(output.Failed) != 0 {
			return fmt.Errorf("delete SQS messages: %d batch entries failed", len(output.Failed))
		}
	}
	return nil
}

func (queue *Queue) retry(ctx context.Context, messages []*delivery, delay time.Duration) error {
	for start := 0; start < len(messages); start += maxBatchSize {
		end := min(start+maxBatchSize, len(messages))
		entries := make([]types.ChangeMessageVisibilityBatchRequestEntry, 0, end-start)
		for index, message := range messages[start:end] {
			entries = append(entries, types.ChangeMessageVisibilityBatchRequestEntry{
				Id:            aws.String(strconv.Itoa(index)),
				ReceiptHandle: aws.String(message.receiptHandle),
				// Retry delay is bounded to the SQS limit by Options.validate.
				VisibilityTimeout: int32(delay / time.Second), //nolint:gosec
			})
		}
		output, err := queue.consumerClient.ChangeMessageVisibilityBatch(
			ctx,
			&awssqs.ChangeMessageVisibilityBatchInput{
				QueueUrl: aws.String(queue.queueURL),
				Entries:  entries,
			},
		)
		if err != nil {
			return fmt.Errorf("retry SQS messages: %w", err)
		}
		if len(output.Failed) != 0 {
			return fmt.Errorf("retry SQS messages: %d batch entries failed", len(output.Failed))
		}
	}
	return nil
}

func (*Queue) Close() error { return nil }

type delivery struct {
	queue         *Queue
	id            string
	body          []byte
	receiptHandle string
	attempts      int
}

func (message *delivery) ID() string   { return message.id }
func (message *delivery) Body() []byte { return message.body }
func (message *delivery) Attempts() int {
	return message.attempts
}
