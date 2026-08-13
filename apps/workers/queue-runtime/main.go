package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"queueworker"
	"queueworker/adapter"
	queueruntime "queueworker/runtime"
	runtimev1 "queueworker/runtime/v1"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
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
	config, err := loadRuntimeConfig()
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	connection, err := grpc.NewClient(
		config.HandlerAddress,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return fmt.Errorf("configure worker handler connection: %w", err)
	}
	defer func() { _ = connection.Close() }()
	if err := waitForHandler(ctx, connection, config.HandlerReadyTimeout); err != nil {
		return err
	}
	input, err := adapter.Open(ctx, config.Input)
	if err != nil {
		return fmt.Errorf("open input queue: %w", err)
	}
	defer closeAdapter(logger, "input", input)
	var publisher queueworker.Publisher
	if config.Output != nil {
		output, openErr := adapter.Open(ctx, *config.Output)
		if openErr != nil {
			return fmt.Errorf("open output queue: %w", openErr)
		}
		defer closeAdapter(logger, "output", output)
		publisher = output
	}
	handler, err := queueruntime.NewRemoteHandler(
		runtimev1.NewHandlerClient(connection),
		publisher,
	)
	if err != nil {
		return err
	}
	config.Runner.Logger = logger
	runner := queueworker.New(input, handler, config.Runner)
	logger.Info(
		"queue runtime started",
		"input_transport", config.Input.Transport,
		"handler_address", config.HandlerAddress,
	)
	if err := runner.Run(ctx); err != nil {
		return err
	}
	logger.Info("queue runtime stopped")
	return nil
}

func waitForHandler(
	ctx context.Context,
	connection *grpc.ClientConn,
	timeout time.Duration,
) error {
	readyContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		state := connection.GetState()
		if state == connectivity.Ready {
			return nil
		}
		connection.Connect()
		if !connection.WaitForStateChange(readyContext, state) {
			return fmt.Errorf("wait for worker handler: %w", readyContext.Err())
		}
	}
}

func closeAdapter(logger *slog.Logger, name string, adapter adapter.Adapter) {
	if err := adapter.Close(); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("close queue adapter", "adapter", name, "error", err)
	}
}
