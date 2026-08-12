package adapter_test

import (
	"queueworker/adapter"
	"testing"
	"time"
)

func TestLoadConfigAppliesEconomicalSQSDefaults(t *testing.T) {
	t.Parallel()

	config, err := adapter.LoadConfig("QUEUE_INPUT_", environment(map[string]string{
		"QUEUE_INPUT_TRANSPORT":     "sqs",
		"QUEUE_INPUT_SQS_QUEUE_URL": "http://localstack:4566/queue/input",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if config.SQS.Options.MaxMessages != 10 ||
		config.SQS.Options.WaitTime != 20*time.Second ||
		config.SQS.Options.RetryDelay != nil ||
		config.SQS.PublisherOptions.BatchSize != 10 {
		t.Fatalf("SQS config = %#v", config.SQS)
	}
}

func TestLoadConfigParsesValkeySettings(t *testing.T) {
	t.Parallel()

	config, err := adapter.LoadConfig("QUEUE_INPUT_", environment(map[string]string{
		"QUEUE_INPUT_TRANSPORT":                 "valkey",
		"QUEUE_INPUT_VALKEY_ADDRESSES":          "valkey-0:6379, valkey-1:6379",
		"QUEUE_INPUT_VALKEY_STREAM":             "pipeline:{jobs}:input",
		"QUEUE_INPUT_VALKEY_GROUP":              "example-worker",
		"QUEUE_INPUT_VALKEY_CONSUMER":           "pod-1",
		"QUEUE_INPUT_VALKEY_VISIBILITY_TIMEOUT": "45s",
		"QUEUE_INPUT_VALKEY_MAX_DELIVERIES":     "7",
		"QUEUE_INPUT_VALKEY_PUBLISH_BATCH_SIZE": "50",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(config.Valkey.Addresses) != 2 ||
		config.Valkey.Options.VisibilityTimeout != 45*time.Second ||
		config.Valkey.Options.MaxDeliveries != 7 ||
		config.Valkey.Options.PublishBatchSize != 50 {
		t.Fatalf("Valkey config = %#v", config.Valkey)
	}
}

func TestLoadConfigParsesCloudflareSettings(t *testing.T) {
	t.Parallel()

	config, err := adapter.LoadConfig("QUEUE_OUTPUT_", environment(map[string]string{
		"QUEUE_OUTPUT_TRANSPORT":                     "cloudflare",
		"QUEUE_OUTPUT_CLOUDFLARE_ACCOUNT_ID":         "account",
		"QUEUE_OUTPUT_CLOUDFLARE_QUEUE_ID":           "queue",
		"QUEUE_OUTPUT_CLOUDFLARE_API_TOKEN":          "token",
		"QUEUE_OUTPUT_CLOUDFLARE_PUBLISH_BATCH_SIZE": "25",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if config.Cloudflare.PublishBatchSize != 25 {
		t.Fatalf("Cloudflare config = %#v", config.Cloudflare)
	}
}

func environment(values map[string]string) adapter.LookupEnv {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}
