package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

type SQSClient interface {
	ReceiveMessage(
		context.Context,
		*sqs.ReceiveMessageInput,
		...func(*sqs.Options),
	) (*sqs.ReceiveMessageOutput, error)
	DeleteMessageBatch(
		context.Context,
		*sqs.DeleteMessageBatchInput,
		...func(*sqs.Options),
	) (*sqs.DeleteMessageBatchOutput, error)
}

type JobSender interface {
	Send(context.Context, Job) error
}

type APNsSender interface {
	Send(context.Context, APNsJob) error
}

type FCMSender interface {
	Send(context.Context, FCMJob) error
}

type Dispatcher struct {
	APNs APNsSender
	FCM  FCMSender
}

func (dispatcher Dispatcher) Send(ctx context.Context, job Job) error {
	switch job.Provider {
	case ProviderAPNs:
		return dispatcher.APNs.Send(ctx, *job.APNs)
	case ProviderFCM:
		return dispatcher.FCM.Send(ctx, *job.FCM)
	default:
		return fmt.Errorf("provider %q is not supported", job.Provider)
	}
}

type Worker struct {
	queue    SQSClient
	queueURL string
	sender   JobSender
	logger   *slog.Logger
}

func NewWorker(queue SQSClient, queueURL string, sender JobSender, logger *slog.Logger) *Worker {
	return &Worker{
		queue:    queue,
		queueURL: queueURL,
		sender:   sender,
		logger:   logger,
	}
}

func (worker *Worker) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		if err := worker.poll(ctx); err != nil {
			if errors.Is(err, context.Canceled) || ctx.Err() != nil {
				return nil
			}
			worker.logger.Error("poll failed", "error", err)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
			}
		}
	}
	return nil
}

func (worker *Worker) poll(ctx context.Context) error {
	output, err := worker.queue.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:            aws.String(worker.queueURL),
		MaxNumberOfMessages: 10,
		WaitTimeSeconds:     20,
		VisibilityTimeout:   60,
	})
	if err != nil {
		return fmt.Errorf("receive SQS messages: %w", err)
	}
	if len(output.Messages) == 0 {
		return nil
	}

	type result struct {
		entry *types.DeleteMessageBatchRequestEntry
	}
	results := make(chan result, len(output.Messages))
	for index, message := range output.Messages {
		go func() {
			job, err := DecodeJob([]byte(aws.ToString(message.Body)))
			if err == nil {
				err = worker.sender.Send(ctx, job)
			}
			if err != nil {
				worker.logger.Error(
					"push failed",
					"messageId", aws.ToString(message.MessageId),
					"error", err,
				)
				results <- result{}
				return
			}
			if aws.ToString(message.ReceiptHandle) == "" {
				worker.logger.Error(
					"push receipt missing",
					"messageId", aws.ToString(message.MessageId),
				)
				results <- result{}
				return
			}
			worker.logger.Info(
				"push delivered",
				"jobId", job.ID,
				"provider", job.Provider,
				"messageId", aws.ToString(message.MessageId),
			)
			results <- result{entry: &types.DeleteMessageBatchRequestEntry{
				Id:            aws.String(strconv.Itoa(index)),
				ReceiptHandle: message.ReceiptHandle,
			}}
		}()
	}

	entries := make([]types.DeleteMessageBatchRequestEntry, 0, len(output.Messages))
	for range output.Messages {
		if item := <-results; item.entry != nil {
			entries = append(entries, *item.entry)
		}
	}
	if len(entries) == 0 {
		return nil
	}

	deleted, err := worker.queue.DeleteMessageBatch(ctx, &sqs.DeleteMessageBatchInput{
		QueueUrl: aws.String(worker.queueURL),
		Entries:  entries,
	})
	if err != nil {
		return fmt.Errorf("delete SQS messages: %w", err)
	}
	if len(deleted.Failed) != 0 {
		return fmt.Errorf("delete SQS messages: %d batch entries failed", len(deleted.Failed))
	}
	return nil
}
