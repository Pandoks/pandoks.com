package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"queueworker"
	"syscall"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	sqsqueue "queueworker/sqs"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	workerConfig, err := LoadConfig()
	if err != nil {
		return err
	}
	awsConfig, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS configuration: %w", err)
	}
	apnsClient, err := NewAPNsClient(workerConfig.APNs)
	if err != nil {
		return err
	}
	fcmClient, err := NewFCMClient(ctx, workerConfig.FirebaseProjectID)
	if err != nil {
		return err
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	queue := sqsqueue.New(sqs.NewFromConfig(awsConfig), workerConfig.QueueURL)
	handler := NewPushHandler(Dispatcher{APNs: apnsClient, FCM: fcmClient}, logger)
	runner := queueworker.New(
		queue,
		handler,
		queueworker.Options{Logger: logger},
	)
	logger.Info("push worker started")
	if err := runner.Run(ctx); err != nil {
		return err
	}
	logger.Info("push worker stopped")
	return nil
}
