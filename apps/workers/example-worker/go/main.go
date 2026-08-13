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
	ctx, stop := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer stop()
	inputConfig, err := adapter.ConfigFromEnv("QUEUE_INPUT_")
	if err != nil {
		return err
	}
	outputConfig, err := adapter.ConfigFromEnv("QUEUE_OUTPUT_")
	if err != nil {
		return err
	}
	input, err := adapter.Open(ctx, inputConfig)
	if err != nil {
		return err
	}
	defer func() { _ = input.Close() }()
	output, err := adapter.Open(ctx, outputConfig)
	if err != nil {
		return err
	}
	defer func() { _ = output.Close() }()
	handler, err := queueworker.NewPipelineHandler(
		queueworker.ProcessorFunc(func(
			_ context.Context,
			message queueworker.Message,
		) ([]queueworker.Publication, error) {
			return []queueworker.Publication{{
				ID:   message.ID() + ":example",
				Body: message.Body(),
			}}, nil
		}),
		output,
	)
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	return queueworker.New(
		input,
		handler,
		queueworker.Options{Logger: logger},
	).Run(ctx)
}
