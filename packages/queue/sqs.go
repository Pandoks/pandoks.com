package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

const (
	sqsBatchCount = 10
	sqsBatchBytes = 1 << 20
	sqsWait       = 20
)

var (
	sqsHost = regexp.MustCompile(`^sqs\.([a-z0-9-]+)\.amazonaws\.com$`)
	sqsPath = regexp.MustCompile(`^/[^/]+/[^/]+$`)
)

type sqsQueue struct {
	client *sqs.Client
	url    string
	lease  time.Duration
}

// awsConfig loads the default credential chain for region, pointed at endpoint when set.
func awsConfig(ctx context.Context, region, endpoint string) (aws.Config, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return cfg, fmt.Errorf("load AWS config: %w", err)
	}
	if endpoint != "" {
		cfg.BaseEndpoint = aws.String(endpoint)
	}
	return cfg, nil
}

func openSQS(ctx context.Context, parsed *url.URL) (*sqsQueue, error) {
	region := sqsHost.FindStringSubmatch(parsed.Host)
	if region == nil || parsed.User != nil || !sqsPath.MatchString(parsed.Path) {
		return nil, errors.New("awssqs URL must be awssqs://sqs.<region>.amazonaws.com/<account>/<name>")
	}
	params, err := queryParams(parsed, "lease", "endpoint")
	if err != nil {
		return nil, err
	}
	lease, err := parseLease(params)
	if err != nil {
		return nil, fmt.Errorf("awssqs URL: %w", err)
	}
	if lease%time.Second != 0 {
		return nil, fmt.Errorf("awssqs URL: lease %s must be whole seconds", lease)
	}
	cfg, err := awsConfig(ctx, region[1], params["endpoint"])
	if err != nil {
		return nil, err
	}
	return &sqsQueue{client: sqs.NewFromConfig(cfg), url: "https://" + parsed.Host + parsed.Path, lease: lease}, nil
}

func (queue *sqsQueue) Send(ctx context.Context, messages ...Message) error {
	sentAt := time.Now()
	entries := make([]types.SendMessageBatchRequestEntry, len(messages))
	for index, message := range messages {
		body, err := encode(message, sentAt)
		if err != nil {
			return err
		}
		entries[index] = types.SendMessageBatchRequestEntry{
			Id:           aws.String(strconv.Itoa(index)),
			MessageBody:  aws.String(string(body)),
			DelaySeconds: delaySeconds(message.Delay),
		}
	}
	size := func(entry types.SendMessageBatchRequestEntry) int { return len(*entry.MessageBody) }
	for _, batch := range batches(entries, size, sqsBatchCount, sqsBatchBytes) {
		output, err := queue.client.SendMessageBatch(ctx, &sqs.SendMessageBatchInput{QueueUrl: &queue.url, Entries: batch})
		if err != nil {
			return fmt.Errorf("send to SQS: %w", err)
		}
		if len(output.Failed) > 0 {
			return fmt.Errorf("send to SQS: %d failed: %s", len(output.Failed), aws.ToString(output.Failed[0].Message))
		}
	}
	return nil
}

func (queue *sqsQueue) Receive(ctx context.Context, max int) ([]*Delivery, error) {
	if max < 1 {
		return nil, fmt.Errorf("receive from SQS: max %d must be at least 1", max)
	}
	output, err := queue.client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:                    &queue.url,
		MaxNumberOfMessages:         int32(min(max, sqsBatchCount)),
		WaitTimeSeconds:             sqsWait,
		VisibilityTimeout:           int32(queue.lease / time.Second), //nolint:gosec // parseLease caps it at 12h
		MessageSystemAttributeNames: []types.MessageSystemAttributeName{types.MessageSystemAttributeNameApproximateReceiveCount},
	})
	if err != nil {
		return nil, fmt.Errorf("receive from SQS: %w", err)
	}
	// NOTE: the visibility timeout starts when the long poll returns a message
	deadline := time.Now().Add(queue.lease)
	deliveries := make([]*Delivery, 0, len(output.Messages))
	var malformed []*Delivery
	for _, message := range output.Messages {
		delivery := &Delivery{Deadline: deadline, handle: aws.ToString(message.ReceiptHandle)}
		count := message.Attributes[string(types.MessageSystemAttributeNameApproximateReceiveCount)]
		if delivery.Attempt, err = strconv.Atoi(count); err != nil {
			return nil, fmt.Errorf("receive from SQS: receive count %q: %w", count, err)
		}
		if err := decode([]byte(aws.ToString(message.Body)), delivery); err != nil {
			slog.Error("queue dropped a malformed message", "message_id", aws.ToString(message.MessageId), "error", err)
			malformed = append(malformed, delivery)
			continue
		}
		deliveries = append(deliveries, delivery)
	}
	// NOTE: a malformed message whose ack fails returns and is dropped again
	if err := queue.Ack(ctx, malformed...); err != nil {
		slog.Error("queue failed to ack malformed messages", "error", err)
	}
	return deliveries, nil
}

func (queue *sqsQueue) Ack(ctx context.Context, deliveries ...*Delivery) error {
	for batch := range slices.Chunk(deliveries, sqsBatchCount) {
		entries := make([]types.DeleteMessageBatchRequestEntry, len(batch))
		for index, delivery := range batch {
			entries[index] = types.DeleteMessageBatchRequestEntry{
				Id:            aws.String(strconv.Itoa(index)),
				ReceiptHandle: aws.String(delivery.handle.(string)),
			}
		}
		output, err := queue.client.DeleteMessageBatch(ctx, &sqs.DeleteMessageBatchInput{QueueUrl: &queue.url, Entries: entries})
		if err != nil {
			return fmt.Errorf("ack SQS messages: %w", err)
		}
		if len(output.Failed) > 0 {
			return fmt.Errorf("ack SQS messages: %d failed: %s", len(output.Failed), aws.ToString(output.Failed[0].Message))
		}
	}
	return nil
}

func (queue *sqsQueue) Retry(ctx context.Context, delay time.Duration, deliveries ...*Delivery) error {
	if err := checkDelay(delay); err != nil {
		return fmt.Errorf("retry SQS messages: %w", err)
	}
	for batch := range slices.Chunk(deliveries, sqsBatchCount) {
		entries := make([]types.ChangeMessageVisibilityBatchRequestEntry, len(batch))
		for index, delivery := range batch {
			entries[index] = types.ChangeMessageVisibilityBatchRequestEntry{
				Id:                aws.String(strconv.Itoa(index)),
				ReceiptHandle:     aws.String(delivery.handle.(string)),
				VisibilityTimeout: delaySeconds(delay),
			}
		}
		output, err := queue.client.ChangeMessageVisibilityBatch(ctx, &sqs.ChangeMessageVisibilityBatchInput{QueueUrl: &queue.url, Entries: entries})
		if err != nil {
			return fmt.Errorf("retry SQS messages: %w", err)
		}
		if len(output.Failed) > 0 {
			return fmt.Errorf("retry SQS messages: %d failed: %s", len(output.Failed), aws.ToString(output.Failed[0].Message))
		}
	}
	return nil
}

func (*sqsQueue) Close() error { return nil }
