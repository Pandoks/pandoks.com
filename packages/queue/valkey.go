package queue

import (
	"context"
	"crypto/rand"
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/valkey-io/valkey-go"
)

const (
	valkeyGroup          = "workers"
	valkeyEmptyPollDelay = 100 * time.Millisecond
)

var (
	// NOTE: strconv.Atoi also takes a leading +, which Python and TS reject
	maxAttemptsPattern = regexp.MustCompile(`^\d+$`)
	//go:embed valkey/send.lua
	sendSource string
	//go:embed valkey/receive.lua
	receiveSource string
	//go:embed valkey/retry.lua
	retrySource string
	//go:embed valkey/publish.lua
	publishSource string
	//go:embed valkey/close.lua
	closeSource string

	sendScript    = valkey.NewLuaScript(sendSource)
	receiveScript = valkey.NewLuaScript(receiveSource)
	retryScript   = valkey.NewLuaScript(retrySource)
	publishScript = valkey.NewLuaScript(publishSource)
	closeScript   = valkey.NewLuaScript(closeSource)
)

// valkeyName reads <name> from a valkey://[user:password@]host:port/<name> URL. Check it before
// anything that echoes the URL: an unescaped /, ?, or # in the password leaves no valid name.
func valkeyName(parsed *url.URL) (string, error) {
	name := strings.TrimPrefix(parsed.Path, "/")
	password, _ := parsed.User.Password()
	decoded := []string{name, parsed.User.Username(), password}
	if parsed.Hostname() == "" || parsed.Port() == "" || name == "" || strings.ContainsAny(name, "{}/") ||
		slices.ContainsFunc(decoded, func(part string) bool { return !utf8.ValidString(part) }) {
		return "", errors.New("valkey URL must be valkey://[user:password@]host:port/<name>")
	}
	return name, nil
}

func valkeyClient(parsed *url.URL) (valkey.Client, error) {
	password, _ := parsed.User.Password()
	client, err := valkey.NewClient(valkey.ClientOption{
		InitAddress:  []string{parsed.Host},
		Username:     parsed.User.Username(),
		Password:     password,
		DisableCache: true,
	})
	if err != nil {
		return nil, fmt.Errorf("connect to Valkey: %w", err)
	}
	return client, nil
}

// valkeyQueue keeps a queue's stream, delayed retries, dead letters, and reclaim cursor under one
// hash tag.
type valkeyQueue struct {
	client      valkey.Client
	keys        []string
	consumer    string
	lease       time.Duration
	maxAttempts int
}

func openValkey(ctx context.Context, parsed *url.URL) (*valkeyQueue, error) {
	name, err := valkeyName(parsed)
	if err != nil {
		return nil, err
	}
	params, err := queryParams(parsed, "lease", "max_attempts", "subscription")
	if err != nil {
		return nil, err
	}
	lease, err := parseLease(params)
	if err != nil {
		return nil, fmt.Errorf("valkey URL: %w", err)
	}
	maxAttempts, err := strconv.Atoi(params["max_attempts"])
	if err != nil || maxAttempts < 1 || !maxAttemptsPattern.MatchString(params["max_attempts"]) {
		return nil, fmt.Errorf("valkey URL: max_attempts %q must be from 1 to 2^63-1", params["max_attempts"])
	}
	client, err := valkeyClient(parsed)
	if err != nil {
		return nil, err
	}
	prefix := "{" + name + "}"
	if subscription, ok := params["subscription"]; ok {
		if subscription == "" {
			client.Close()
			return nil, errors.New("valkey URL: subscription is empty")
		}
		prefix += ":" + subscription
		if err := client.Do(ctx, client.B().Sadd().Key("{"+name+"}:subscriptions").Member(subscription).Build()).Error(); err != nil {
			client.Close()
			return nil, fmt.Errorf("subscribe to Valkey topic %s: %w", name, err)
		}
	}
	return &valkeyQueue{
		client:      client,
		keys:        []string{prefix + ":stream", prefix + ":delayed", prefix + ":dlq", prefix + ":reclaim"},
		consumer:    rand.Text(),
		lease:       lease,
		maxAttempts: maxAttempts,
	}, nil
}

func (queue *valkeyQueue) Send(ctx context.Context, messages ...Message) error {
	sentAt := time.Now()
	args := make([]string, 0, 2*len(messages))
	for _, message := range messages {
		body, err := encode(message, sentAt)
		if err != nil {
			return err
		}
		args = append(args, strconv.FormatInt(message.Delay.Milliseconds(), 10), string(body))
	}
	if err := sendScript.Exec(ctx, queue.client, queue.keys[:2], args).Error(); err != nil {
		return fmt.Errorf("send to Valkey: %w", err)
	}
	return nil
}

func (queue *valkeyQueue) Receive(ctx context.Context, max int) ([]*Delivery, error) {
	if max < 1 {
		return nil, fmt.Errorf("receive from Valkey: max %d must be at least 1", max)
	}
	args := []string{valkeyGroup, queue.consumer, strconv.Itoa(max), strconv.FormatInt(queue.lease.Milliseconds(), 10), strconv.Itoa(queue.maxAttempts)}
	rows, err := receiveScript.Exec(ctx, queue.client, queue.keys, args).ToArray()
	if err != nil {
		return nil, fmt.Errorf("receive from Valkey: %w", err)
	}
	// NOTE: the lease starts when the script runs, which can be well after the call on a busy server
	deadline := time.Now().Add(queue.lease)
	deliveries := make([]*Delivery, 0, len(rows))
	var malformed []*Delivery
	for _, row := range rows {
		fields, err := row.ToArray()
		if err != nil || len(fields) != 3 {
			return nil, fmt.Errorf("receive from Valkey: unexpected row %v", row)
		}
		id, _ := fields[0].ToString()
		body, _ := fields[1].ToString()
		attempt, _ := fields[2].AsInt64()
		delivery := &Delivery{Attempt: int(attempt), Deadline: deadline, handle: id}
		if err := decode([]byte(body), delivery); err != nil {
			slog.Error("queue dropped a malformed message", "stream_id", id, "error", err)
			malformed = append(malformed, delivery)
			continue
		}
		deliveries = append(deliveries, delivery)
	}
	if err := queue.Ack(ctx, malformed...); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		select {
		case <-time.After(valkeyEmptyPollDelay):
		case <-ctx.Done():
		}
	}
	return deliveries, nil
}

func (queue *valkeyQueue) Ack(ctx context.Context, deliveries ...*Delivery) error {
	if len(deliveries) == 0 {
		return nil
	}
	ids := make([]string, len(deliveries))
	for index, delivery := range deliveries {
		ids[index] = delivery.handle.(string)
	}
	for _, result := range queue.client.DoMulti(ctx,
		queue.client.B().Xack().Key(queue.keys[0]).Group(valkeyGroup).Id(ids...).Build(),
		queue.client.B().Xdel().Key(queue.keys[0]).Id(ids...).Build(),
	) {
		if err := result.Error(); err != nil {
			return fmt.Errorf("ack Valkey messages: %w", err)
		}
	}
	return nil
}

func (queue *valkeyQueue) Retry(ctx context.Context, delay time.Duration, deliveries ...*Delivery) error {
	if err := checkDelay(delay); err != nil {
		return fmt.Errorf("retry Valkey messages: %w", err)
	}
	if len(deliveries) == 0 {
		return nil
	}
	args := []string{valkeyGroup, strconv.FormatInt(delay.Milliseconds(), 10), strconv.Itoa(queue.maxAttempts)}
	for _, delivery := range deliveries {
		args = append(args, delivery.handle.(string), strconv.Itoa(delivery.Attempt))
	}
	if err := retryScript.Exec(ctx, queue.client, queue.keys, args).Error(); err != nil {
		return fmt.Errorf("retry Valkey messages: %w", err)
	}
	return nil
}

func (queue *valkeyQueue) Close() error {
	defer queue.client.Close()
	if err := closeScript.Exec(context.Background(), queue.client, queue.keys[:1], []string{valkeyGroup, queue.consumer}).Error(); err != nil {
		return fmt.Errorf("close Valkey queue: %w", err)
	}
	return nil
}

// valkeyTopic fans each message out to every subscription registered in {<topic>}:subscriptions.
type valkeyTopic struct {
	client valkey.Client
	name   string
}

func openValkeyTopic(_ context.Context, parsed *url.URL) (*valkeyTopic, error) {
	name, err := valkeyName(parsed)
	if err != nil {
		return nil, err
	}
	if _, err := queryParams(parsed); err != nil {
		return nil, err
	}
	client, err := valkeyClient(parsed)
	if err != nil {
		return nil, err
	}
	return &valkeyTopic{client: client, name: name}, nil
}

func (topic *valkeyTopic) Publish(ctx context.Context, messages ...Message) error {
	sentAt := time.Now()
	bodies := make([]string, len(messages))
	for index, message := range messages {
		if message.Delay != 0 {
			return errors.New("publish to Valkey: topics take no delay")
		}
		body, err := encode(message, sentAt)
		if err != nil {
			return err
		}
		bodies[index] = string(body)
	}
	for _, body := range bodies {
		if err := topic.publish(ctx, body); err != nil {
			return err
		}
	}
	return nil
}

// publish rereads the subscriptions when publish.lua reports they changed since the last read.
func (topic *valkeyTopic) publish(ctx context.Context, body string) error {
	subscriptionsKey := "{" + topic.name + "}:subscriptions"
	for range 3 {
		subscriptions, err := topic.client.Do(ctx, topic.client.B().Smembers().Key(subscriptionsKey).Build()).AsStrSlice()
		if err != nil {
			return fmt.Errorf("publish to Valkey topic %s: %w", topic.name, err)
		}
		slices.Sort(subscriptions)
		keys := []string{subscriptionsKey}
		for _, subscription := range subscriptions {
			keys = append(keys, "{"+topic.name+"}:"+subscription+":stream")
		}
		err = publishScript.Exec(ctx, topic.client, keys, []string{body}).Error()
		if err == nil {
			return nil
		}
		if !strings.Contains(err.Error(), "STALE") {
			return fmt.Errorf("publish to Valkey topic %s: %w", topic.name, err)
		}
	}
	return fmt.Errorf("publish to Valkey topic %s: subscriptions kept changing", topic.name)
}

func (topic *valkeyTopic) Close() error {
	topic.client.Close()
	return nil
}
