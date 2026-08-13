package main

import (
	"queueworker/adapter"
	"testing"
	"time"
)

func TestParseRuntimeConfig(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"QUEUE_INPUT_TRANSPORT":         "sqs",
		"QUEUE_INPUT_SQS_QUEUE_URL":     "http://localstack/input",
		"QUEUE_OUTPUT_TRANSPORT":        "valkey",
		"QUEUE_OUTPUT_VALKEY_ADDRESSES": "valkey:6379",
		"QUEUE_OUTPUT_VALKEY_STREAM":    "next",
		"WORKER_CONCURRENCY":            "7",
		"WORKER_HANDLER_TIMEOUT":        "2m",
	}
	config, err := parseRuntimeConfig(func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Input.Transport != adapter.TransportSQS ||
		config.Output == nil || config.Output.Transport != adapter.TransportValkey ||
		config.Runner.Concurrency != 7 || config.Runner.HandlerTimeout != 2*time.Minute {
		t.Fatalf("config = %#v", config)
	}
}
