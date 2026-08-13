package adapter

import (
	"errors"
	"fmt"
	"os"
	"queueworker/cloudflare"
	"queueworker/sqs"
	"queueworker/valkey"
	"strconv"
	"strings"
	"time"
)

const (
	TransportSQS        = "sqs"
	TransportValkey     = "valkey"
	TransportCloudflare = "cloudflare"
)

type LookupEnv func(string) (string, bool)

type Config struct {
	Transport  string
	SQS        SQSConfig
	Valkey     ValkeyConfig
	Cloudflare cloudflare.Options
}

type SQSConfig struct {
	QueueURL         string
	Region           string
	EndpointURL      string
	Options          sqs.Options
	PublisherOptions sqs.PublisherOptions
}

type ValkeyConfig struct {
	Addresses []string
	Username  string
	Password  string
	Options   valkey.Options
}

func ConfigFromEnv(prefix string) (Config, error) {
	return LoadConfig(prefix, os.LookupEnv)
}

func LoadConfig(prefix string, lookup LookupEnv) (Config, error) {
	transport := strings.ToLower(strings.TrimSpace(value(lookup, prefix+"TRANSPORT")))
	switch transport {
	case TransportSQS:
		return loadSQSConfig(prefix, lookup)
	case TransportValkey:
		return loadValkeyConfig(prefix, lookup)
	case TransportCloudflare:
		return loadCloudflareConfig(prefix, lookup)
	case "":
		return Config{}, fmt.Errorf("%sTRANSPORT is required", prefix)
	default:
		return Config{}, fmt.Errorf("%sTRANSPORT %q is not supported", prefix, transport)
	}
}

func loadSQSConfig(prefix string, lookup LookupEnv) (Config, error) {
	options := sqs.DefaultOptions()
	publisherOptions := sqs.DefaultPublisherOptions()
	var err error
	if options.MaxMessages, err = int32Value(
		lookup,
		prefix+"SQS_MAX_MESSAGES",
		options.MaxMessages,
	); err != nil {
		return Config{}, err
	}
	if options.WaitTime, err = durationValue(
		lookup,
		prefix+"SQS_WAIT_TIME",
		options.WaitTime,
	); err != nil {
		return Config{}, err
	}
	if options.VisibilityTimeout, err = durationValue(
		lookup,
		prefix+"SQS_VISIBILITY_TIMEOUT",
		options.VisibilityTimeout,
	); err != nil {
		return Config{}, err
	}
	if _, ok := lookup(prefix + "SQS_RETRY_DELAY"); ok {
		delay, parseErr := durationValue(lookup, prefix+"SQS_RETRY_DELAY", 0)
		if parseErr != nil {
			return Config{}, parseErr
		}
		options.RetryDelay = &delay
	}
	if publisherOptions.BatchSize, err = intValue(
		lookup,
		prefix+"SQS_PUBLISH_BATCH_SIZE",
		publisherOptions.BatchSize,
	); err != nil {
		return Config{}, err
	}
	publisherOptions.MessageGroupID = value(lookup, prefix+"SQS_MESSAGE_GROUP_ID")
	if publisherOptions.UsePublicationIDForDeduplication, err = boolValue(
		lookup,
		prefix+"SQS_DEDUPLICATE_BY_ID",
		false,
	); err != nil {
		return Config{}, err
	}
	queueURL := value(lookup, prefix+"SQS_QUEUE_URL")
	if queueURL == "" {
		return Config{}, fmt.Errorf("%sSQS_QUEUE_URL is required", prefix)
	}
	return Config{
		Transport: TransportSQS,
		SQS: SQSConfig{
			QueueURL:         queueURL,
			Region:           value(lookup, prefix+"SQS_REGION"),
			EndpointURL:      value(lookup, prefix+"SQS_ENDPOINT_URL"),
			Options:          options,
			PublisherOptions: publisherOptions,
		},
	}, nil
}

func loadValkeyConfig(prefix string, lookup LookupEnv) (Config, error) {
	stream := value(lookup, prefix+"VALKEY_STREAM")
	options := valkey.DefaultOptions(
		stream,
		value(lookup, prefix+"VALKEY_GROUP"),
		value(lookup, prefix+"VALKEY_CONSUMER"),
	)
	var err error
	if options.BatchSize, err = intValue(
		lookup,
		prefix+"VALKEY_BATCH_SIZE",
		options.BatchSize,
	); err != nil {
		return Config{}, err
	}
	if options.BlockTime, err = durationValue(
		lookup,
		prefix+"VALKEY_BLOCK_TIME",
		options.BlockTime,
	); err != nil {
		return Config{}, err
	}
	if options.VisibilityTimeout, err = durationValue(
		lookup,
		prefix+"VALKEY_VISIBILITY_TIMEOUT",
		options.VisibilityTimeout,
	); err != nil {
		return Config{}, err
	}
	if options.DeleteOnAck, err = boolValue(
		lookup,
		prefix+"VALKEY_DELETE_ON_ACK",
		options.DeleteOnAck,
	); err != nil {
		return Config{}, err
	}
	if options.MaxDeliveries, err = int64Value(
		lookup,
		prefix+"VALKEY_MAX_DELIVERIES",
		options.MaxDeliveries,
	); err != nil {
		return Config{}, err
	}
	if configured, ok := lookup(prefix + "VALKEY_DLQ_STREAM"); ok {
		options.DeadLetterStream = strings.TrimSpace(configured)
	}
	if configured, ok := lookup(prefix + "VALKEY_START_ID"); ok {
		options.StartID = strings.TrimSpace(configured)
	}
	if options.PublishBatchSize, err = intValue(
		lookup,
		prefix+"VALKEY_PUBLISH_BATCH_SIZE",
		options.PublishBatchSize,
	); err != nil {
		return Config{}, err
	}
	addresses, err := splitRequired(
		value(lookup, prefix+"VALKEY_ADDRESSES"),
		prefix+"VALKEY_ADDRESSES",
	)
	if err != nil {
		return Config{}, err
	}
	return Config{
		Transport: TransportValkey,
		Valkey: ValkeyConfig{
			Addresses: addresses,
			Username:  value(lookup, prefix+"VALKEY_USERNAME"),
			Password:  value(lookup, prefix+"VALKEY_PASSWORD"),
			Options:   options,
		},
	}, nil
}

func loadCloudflareConfig(prefix string, lookup LookupEnv) (Config, error) {
	options := cloudflare.DefaultOptions(
		value(lookup, prefix+"CLOUDFLARE_ACCOUNT_ID"),
		value(lookup, prefix+"CLOUDFLARE_QUEUE_ID"),
		value(lookup, prefix+"CLOUDFLARE_API_TOKEN"),
	)
	if configured, ok := lookup(prefix + "CLOUDFLARE_BASE_URL"); ok {
		options.BaseURL = strings.TrimSpace(configured)
	}
	var err error
	if options.PullBatchSize, err = intValue(
		lookup,
		prefix+"CLOUDFLARE_PULL_BATCH_SIZE",
		options.PullBatchSize,
	); err != nil {
		return Config{}, err
	}
	if options.VisibilityTimeout, err = durationValue(
		lookup,
		prefix+"CLOUDFLARE_VISIBILITY_TIMEOUT",
		options.VisibilityTimeout,
	); err != nil {
		return Config{}, err
	}
	if options.EmptyPollDelay, err = durationValue(
		lookup,
		prefix+"CLOUDFLARE_EMPTY_POLL_DELAY",
		options.EmptyPollDelay,
	); err != nil {
		return Config{}, err
	}
	if options.RetryDelay, err = durationValue(
		lookup,
		prefix+"CLOUDFLARE_RETRY_DELAY",
		options.RetryDelay,
	); err != nil {
		return Config{}, err
	}
	if options.PublishBatchSize, err = intValue(
		lookup,
		prefix+"CLOUDFLARE_PUBLISH_BATCH_SIZE",
		options.PublishBatchSize,
	); err != nil {
		return Config{}, err
	}
	return Config{Transport: TransportCloudflare, Cloudflare: options}, nil
}

func value(lookup LookupEnv, name string) string {
	result, _ := lookup(name)
	return strings.TrimSpace(result)
}

func durationValue(
	lookup LookupEnv,
	name string,
	fallback time.Duration,
) (time.Duration, error) {
	encoded, ok := lookup(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(strings.TrimSpace(encoded))
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", name, err)
	}
	return parsed, nil
}

func intValue(lookup LookupEnv, name string, fallback int) (int, error) {
	encoded, ok := lookup(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(encoded))
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", name, err)
	}
	return parsed, nil
}

func int32Value(lookup LookupEnv, name string, fallback int32) (int32, error) {
	parsed, err := int64Value(lookup, name, int64(fallback))
	if err != nil {
		return 0, err
	}
	if parsed < -1<<31 || parsed > 1<<31-1 {
		return 0, fmt.Errorf("parse %s: value is outside int32 range", name)
	}
	return int32(parsed), nil
}

func int64Value(lookup LookupEnv, name string, fallback int64) (int64, error) {
	encoded, ok := lookup(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(encoded), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", name, err)
	}
	return parsed, nil
}

func boolValue(lookup LookupEnv, name string, fallback bool) (bool, error) {
	encoded, ok := lookup(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(strings.TrimSpace(encoded))
	if err != nil {
		return false, fmt.Errorf("parse %s: %w", name, err)
	}
	return parsed, nil
}

func splitRequired(encoded, name string) ([]string, error) {
	var values []string
	for _, item := range strings.Split(encoded, ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			values = append(values, trimmed)
		}
	}
	if len(values) == 0 {
		return nil, errors.New(name + " is required")
	}
	return values, nil
}
