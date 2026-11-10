package queue

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sns/types"
)

const snsBatchBytes = 256 << 10

// snsTopic publishes to an SNS topic whose subscriptions are SQS queues with raw delivery on.
type snsTopic struct {
	client *sns.Client
	arn    string
}

func openSNS(ctx context.Context, parsed *url.URL) (*snsTopic, error) {
	arn := strings.TrimPrefix(parsed.Path, "/")
	fields := strings.Split(arn, ":")
	if parsed.Host != "" || parsed.User != nil || len(fields) != 6 || fields[0] != "arn" || fields[2] != "sns" ||
		slices.Contains(fields, "") {
		return nil, errors.New("awssns URL must be awssns:///arn:aws:sns:<region>:<account>:<name>")
	}
	params, err := queryParams(parsed, "endpoint")
	if err != nil {
		return nil, err
	}
	cfg, err := awsConfig(ctx, fields[3], params["endpoint"])
	if err != nil {
		return nil, err
	}
	return &snsTopic{client: sns.NewFromConfig(cfg), arn: arn}, nil
}

func (topic *snsTopic) Publish(ctx context.Context, messages ...Message) error {
	sentAt := time.Now()
	entries := make([]types.PublishBatchRequestEntry, len(messages))
	for index, message := range messages {
		if message.Delay != 0 {
			return errors.New("publish to SNS: topics take no delay")
		}
		body, err := encode(message, sentAt)
		if err != nil {
			return err
		}
		entries[index] = types.PublishBatchRequestEntry{Id: aws.String(strconv.Itoa(index)), Message: aws.String(string(body))}
	}
	size := func(entry types.PublishBatchRequestEntry) int { return len(*entry.Message) }
	for _, batch := range batches(entries, size, sqsBatchCount, snsBatchBytes) {
		output, err := topic.client.PublishBatch(ctx, &sns.PublishBatchInput{TopicArn: &topic.arn, PublishBatchRequestEntries: batch})
		if err != nil {
			return fmt.Errorf("publish to SNS: %w", err)
		}
		if len(output.Failed) > 0 {
			return fmt.Errorf("publish to SNS: %d failed: %s", len(output.Failed), aws.ToString(output.Failed[0].Message))
		}
	}
	return nil
}

func (*snsTopic) Close() error { return nil }
