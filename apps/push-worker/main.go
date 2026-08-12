package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"queueworker"
	"queueworker/adapter"
	"syscall"
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
	apnsClient, err := NewAPNsClient(workerConfig.APNs)
	if err != nil {
		return err
	}
	fcmClient, err := NewFCMClient(ctx, workerConfig.FirebaseProjectID)
	if err != nil {
		return err
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	queue, err := adapter.Open(ctx, workerConfig.Queue)
	if err != nil {
		return err
	}
	defer func() {
		if err := queue.Close(); err != nil {
			logger.Error("close queue adapter", "error", err)
		}
	}()
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
