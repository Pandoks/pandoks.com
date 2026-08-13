package sqs

import (
	"context"
	"errors"
	"fmt"
	"queueworker"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

type PublisherOptions struct {
	BatchSize                        int
	MessageGroupID                   string
	UsePublicationIDForDeduplication bool
}

type PublisherClient interface {
	SendMessageBatch(
		context.Context,
		*awssqs.SendMessageBatchInput,
		...func(*awssqs.Options),
	) (*awssqs.SendMessageBatchOutput, error)
}

func DefaultPublisherOptions() PublisherOptions {
	return PublisherOptions{BatchSize: maxBatchSize}
}

func (options PublisherOptions) validate() error {
	if options.BatchSize < 1 || options.BatchSize > maxBatchSize {
		return errors.New("publish batch size must be between 1 and 10")
	}
	if options.UsePublicationIDForDeduplication && options.MessageGroupID == "" {
		return errors.New("message group ID is required when publication IDs are used for deduplication")
	}
	return nil
}

func (queue *Queue) Publish(ctx context.Context, messages []queueworker.Publication) error {
	if queue.publisherClient == nil {
		return errors.New("publish SQS messages: publisher is not configured")
	}
	for start := 0; start < len(messages); start += queue.publisherOptions.BatchSize {
		end := min(start+queue.publisherOptions.BatchSize, len(messages))
		entries := make([]types.SendMessageBatchRequestEntry, 0, end-start)
		for index, message := range messages[start:end] {
			entry := types.SendMessageBatchRequestEntry{
				Id:          aws.String(strconv.Itoa(index)),
				MessageBody: aws.String(string(message.Body)),
			}
			if queue.publisherOptions.MessageGroupID != "" {
				entry.MessageGroupId = aws.String(queue.publisherOptions.MessageGroupID)
			}
			if queue.publisherOptions.UsePublicationIDForDeduplication {
				if message.ID == "" {
					return fmt.Errorf("publish SQS message %d: publication ID is required for deduplication", start+index)
				}
				entry.MessageDeduplicationId = aws.String(message.ID)
			}
			entries = append(entries, entry)
		}
		output, err := queue.publisherClient.SendMessageBatch(ctx, &awssqs.SendMessageBatchInput{
			QueueUrl: aws.String(queue.queueURL),
			Entries:  entries,
		})
		if err != nil {
			return fmt.Errorf("publish SQS messages %d-%d: %w", start, end-1, err)
		}
		if len(output.Failed) == 0 {
			continue
		}
		failures := make([]queueworker.PublishFailure, 0, len(output.Failed))
		for _, failure := range output.Failed {
			relativeIndex, parseErr := strconv.Atoi(aws.ToString(failure.Id))
			if parseErr != nil || relativeIndex < 0 || relativeIndex >= end-start {
				return fmt.Errorf(
					"publish SQS messages: provider returned invalid failure ID %q",
					aws.ToString(failure.Id),
				)
			}
			index := start + relativeIndex
			failures = append(failures, queueworker.PublishFailure{
				Index: index,
				ID:    messages[index].ID,
				Err: fmt.Errorf(
					"%s: %s",
					aws.ToString(failure.Code),
					aws.ToString(failure.Message),
				),
			})
		}
		return &queueworker.PublishError{Failures: failures}
	}
	return nil
}
