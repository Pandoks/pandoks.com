// Package queue sends and receives CloudEvents envelopes through SQS and SNS, Cloudflare Queues,
// or Valkey, chosen by URL. See README.md for the spec every language follows.
package queue

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"time"
)

const (
	// MaxDelay is SQS's DelaySeconds maximum, the portable ceiling for every delay.
	MaxDelay = 15 * time.Minute
	// MaxEnvelopeBytes fits Cloudflare's 128 KB message limit with room for its metadata.
	MaxEnvelopeBytes = 120_000
)

// Message is what a producer sends. ID defaults to a random one and ContentType to
// application/json; JSON data goes in the envelope's data member, anything else in data_base64.
type Message struct {
	ID          string
	Source      string
	Type        string
	Data        []byte
	ContentType string
	Extensions  map[string]string
	Delay       time.Duration
}

// Delivery is a received message. Attempt is 1 on the first delivery, and the broker
// redelivers it once Deadline passes unless it is acked or retried first.
type Delivery struct {
	Message
	Time     time.Time
	Attempt  int
	Deadline time.Time
	handle   any
}

type Queue interface {
	Send(ctx context.Context, messages ...Message) error
	Receive(ctx context.Context, max int) ([]*Delivery, error)
	Ack(ctx context.Context, deliveries ...*Delivery) error
	Retry(ctx context.Context, delay time.Duration, deliveries ...*Delivery) error
	Close() error
}

type Topic interface {
	Publish(ctx context.Context, messages ...Message) error
	Close() error
}

// Open opens a queue, or a topic's subscription, from its URL.
func Open(ctx context.Context, rawURL string) (Queue, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("open queue: URL does not parse")
	}
	switch parsed.Scheme {
	case "awssqs":
		return openSQS(ctx, parsed)
	case "cloudflare":
		return openCloudflare(parsed)
	case "valkey":
		return openValkey(ctx, parsed)
	}
	return nil, fmt.Errorf("open queue: unknown scheme %q", parsed.Scheme)
}

// OpenTopic opens a topic from its URL.
func OpenTopic(ctx context.Context, rawURL string) (Topic, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("open topic: URL does not parse")
	}
	switch parsed.Scheme {
	case "awssns":
		return openSNS(ctx, parsed)
	case "cloudflare":
		return openCloudflareTopic(parsed)
	case "valkey":
		return openValkeyTopic(ctx, parsed)
	}
	return nil, fmt.Errorf("open topic: unknown scheme %q", parsed.Scheme)
}

// queryParams returns the URL's query, rejecting parameters outside allowed and repeated ones.
func queryParams(parsed *url.URL, allowed ...string) (map[string]string, error) {
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return nil, fmt.Errorf("%s URL: query does not parse", parsed.Scheme)
	}
	params := map[string]string{}
	for name, values := range query {
		if !slices.Contains(allowed, name) || len(values) != 1 {
			return nil, fmt.Errorf("%s URL: unexpected parameter %q", parsed.Scheme, name)
		}
		params[name] = values[0]
	}
	return params, nil
}

var durationPattern = regexp.MustCompile(`^(\d+)(ms|s|m|h)$`)

// parseLease reads the required lease parameter, written like 500ms, 30s, 2m, or 1h.
func parseLease(params map[string]string) (time.Duration, error) {
	match := durationPattern.FindStringSubmatch(params["lease"])
	if match == nil {
		return 0, fmt.Errorf("lease %q must be a whole number of ms, s, m, or h", params["lease"])
	}
	unit := map[string]time.Duration{"ms": time.Millisecond, "s": time.Second, "m": time.Minute, "h": time.Hour}[match[2]]
	amount, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil || amount < 1 || amount > int64(12*time.Hour/unit) {
		return 0, fmt.Errorf("lease %q must be more than 0 and at most 12h", params["lease"])
	}
	return time.Duration(amount) * unit, nil
}

func checkDelay(delay time.Duration) error {
	if delay < 0 || delay > MaxDelay {
		return fmt.Errorf("delay %s must be between 0 and %s", delay, MaxDelay)
	}
	return nil
}

// delaySeconds rounds a delay checked by checkDelay up to whole seconds.
func delaySeconds(delay time.Duration) int32 {
	return int32((delay + time.Second - 1) / time.Second) //nolint:gosec // checkDelay caps it at 900
}

// backoff is the worker's retry delay after a failed attempt: 1 s, 2 s, 4 s, … up to MaxDelay.
func backoff(attempt int) time.Duration {
	if attempt > 11 {
		return MaxDelay
	}
	return min(time.Second<<max(attempt-1, 0), MaxDelay)
}

// batches splits items into runs of at most maxCount items and maxBytes total size.
func batches[T any](items []T, size func(T) int, maxCount, maxBytes int) [][]T {
	var result [][]T
	start, bytes := 0, 0
	for index, item := range items {
		if index > start && (index-start == maxCount || bytes+size(item) > maxBytes) {
			result = append(result, items[start:index])
			start, bytes = index, 0
		}
		bytes += size(item)
	}
	if start < len(items) {
		result = append(result, items[start:])
	}
	return result
}
