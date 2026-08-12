package main

import (
	"fmt"
	"os"
	"queueworker"
	"queueworker/adapter"
	"strconv"
	"time"
)

type runtimeConfig struct {
	Input               adapter.Config
	Output              *adapter.Config
	HandlerAddress      string
	HandlerReadyTimeout time.Duration
	Runner              queueworker.Options
}

func loadRuntimeConfig() (runtimeConfig, error) {
	return parseRuntimeConfig(os.LookupEnv)
}

func parseRuntimeConfig(lookup adapter.LookupEnv) (runtimeConfig, error) {
	input, err := adapter.LoadConfig("QUEUE_INPUT_", lookup)
	if err != nil {
		return runtimeConfig{}, err
	}
	var output *adapter.Config
	if _, ok := lookup("QUEUE_OUTPUT_TRANSPORT"); ok {
		configured, configErr := adapter.LoadConfig("QUEUE_OUTPUT_", lookup)
		if configErr != nil {
			return runtimeConfig{}, configErr
		}
		output = &configured
	}
	handlerAddress := envValue(lookup, "HANDLER_GRPC_ADDRESS", "127.0.0.1:9000")
	readyTimeout, err := envDuration(
		lookup,
		"HANDLER_READY_TIMEOUT",
		30*time.Second,
	)
	if err != nil {
		return runtimeConfig{}, err
	}
	concurrency, err := envInt(lookup, "WORKER_CONCURRENCY", 10)
	if err != nil {
		return runtimeConfig{}, err
	}
	handlerTimeout, err := envDuration(
		lookup,
		"WORKER_HANDLER_TIMEOUT",
		30*time.Second,
	)
	if err != nil {
		return runtimeConfig{}, err
	}
	pollErrorDelay, err := envDuration(
		lookup,
		"WORKER_POLL_ERROR_DELAY",
		time.Second,
	)
	if err != nil {
		return runtimeConfig{}, err
	}
	settleTimeout, err := envDuration(
		lookup,
		"WORKER_SETTLE_TIMEOUT",
		10*time.Second,
	)
	if err != nil {
		return runtimeConfig{}, err
	}
	if handlerAddress == "" {
		return runtimeConfig{}, fmt.Errorf("HANDLER_GRPC_ADDRESS cannot be empty")
	}
	if readyTimeout <= 0 || concurrency <= 0 || handlerTimeout <= 0 ||
		pollErrorDelay <= 0 || settleTimeout <= 0 {
		return runtimeConfig{}, fmt.Errorf("worker timeouts, delays, and concurrency must be positive")
	}
	return runtimeConfig{
		Input:               input,
		Output:              output,
		HandlerAddress:      handlerAddress,
		HandlerReadyTimeout: readyTimeout,
		Runner: queueworker.Options{
			Concurrency:    concurrency,
			HandlerTimeout: handlerTimeout,
			PollErrorDelay: pollErrorDelay,
			SettleTimeout:  settleTimeout,
		},
	}, nil
}

func envValue(lookup adapter.LookupEnv, name, fallback string) string {
	if configured, ok := lookup(name); ok {
		return configured
	}
	return fallback
}

func envDuration(
	lookup adapter.LookupEnv,
	name string,
	fallback time.Duration,
) (time.Duration, error) {
	configured, ok := lookup(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(configured)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", name, err)
	}
	return parsed, nil
}

func envInt(lookup adapter.LookupEnv, name string, fallback int) (int, error) {
	configured, ok := lookup(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(configured)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", name, err)
	}
	return parsed, nil
}
