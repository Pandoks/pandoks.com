package queue

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/valkey-io/valkey-go"
)

const (
	valkeyGroup          = "workers"
	valkeyEmptyPollDelay = 100 * time.Millisecond
)

var (
	//go:embed valkey/receive.lua
	receiveSource string
	//go:embed valkey/retry.lua
	retrySource string
	//go:embed valkey/publish.lua
	publishSource string

	receiveScript = valkey.NewLuaScript(receiveSource)
	retryScript   = valkey.NewLuaScript(retrySource)
	publishScript = valkey.NewLuaScript(publishSource)
)

// valkeyClient connects to the cluster in a valkey://[user:password@]host:port/<name> URL.
func valkeyClient(parsed *url.URL) (valkey.Client, string, error) {
	name := strings.TrimPrefix(parsed.Path, "/")
	if parsed.Host == "" || name == "" || strings.ContainsAny(name, "{}/") {
		return nil, "", fmt.Errorf("valkey URL %q must be valkey://[user:password@]host:port/<name>", parsed.Redacted())
	}
	password, _ := parsed.User.Password()
	client, err := valkey.NewClient(valkey.ClientOption{
		InitAddress:  []string{parsed.Host},
		Username:     parsed.User.Username(),
		Password:     password,
		DisableCache: true,
	})
	if err != nil {
		return nil, "", fmt.Errorf("connect to Valkey: %w", err)
	}
	return client, name, nil
}

// valkeyQueue keeps a queue's stream, delayed retries, and dead letters under one hash tag.
type valkeyQueue struct {
	client      valkey.Client
	keys        []string
	consumer    string
	lease       time.Duration
	maxAttempts int
}

func openValkey(ctx context.Context, parsed *url.URL) (*valkeyQueue, error) {
	params, err := queryParams(parsed, "lease", "max_attempts", "subscription")
	if err != nil {
		return nil, err
	}
	lease, err := parseLease(params)
	if err != nil {
		return nil, fmt.Errorf("valkey URL: %w", err)
	}
	maxAttempts, err := strconv.Atoi(params["max_attempts"])
	if err != nil || maxAttempts < 1 {
		return nil, fmt.Errorf("valkey URL: max_attempts %q must be at least 1", params["max_attempts"])
	}
	client, name, err := valkeyClient(parsed)
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
		keys:        []string{prefix + ":stream", prefix + ":delayed", prefix + ":dlq"},
		consumer:    rand.Text(),
		lease:       lease,
		maxAttempts: maxAttempts,
	}, nil
}

func (queue *valkeyQueue) Send(ctx context.Context, messages ...Message) error {
	sentAt := time.Now()
	commands := make(valkey.Commands, len(messages))
	for index, message := range messages {
		body, err := encode(message, sentAt)
		if err != nil {
			return err
		}
		if message.Delay == 0 {
			commands[index] = queue.client.B().Xadd().Key(queue.keys[0]).Id("*").FieldValue().
				FieldValue("envelope", string(body)).FieldValue("attempt", "0").Build()
			continue
		}
		member, err := json.Marshal(map[string]any{"envelope": string(body), "attempt": 0})
		if err != nil {
			return fmt.Errorf("send to Valkey: %w", err)
		}
		due := sentAt.Add(message.Delay).UnixMilli()
		commands[index] = queue.client.B().Zadd().Key(queue.keys[1]).ScoreMember().ScoreMember(float64(due), string(member)).Build()
	}
	for _, result := range queue.client.DoMulti(ctx, commands...) {
		if err := result.Error(); err != nil {
			return fmt.Errorf("send to Valkey: %w", err)
		}
	}
	return nil
}

func (queue *valkeyQueue) Receive(ctx context.Context, max int) ([]*Delivery, error) {
	if max < 1 {
		return nil, fmt.Errorf("receive from Valkey: max %d must be at least 1", max)
	}
	deadline := time.Now().Add(queue.lease)
	args := []string{valkeyGroup, queue.consumer, strconv.Itoa(max), strconv.FormatInt(queue.lease.Milliseconds(), 10), strconv.Itoa(queue.maxAttempts)}
	rows, err := receiveScript.Exec(ctx, queue.client, queue.keys, args).ToArray()
	if err != nil {
		return nil, fmt.Errorf("receive from Valkey: %w", err)
	}
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
	queue.client.Close()
	return nil
}

// valkeyTopic fans each message out to every subscription registered in {<topic>}:subscriptions.
type valkeyTopic struct {
	client valkey.Client
	name   string
}

func openValkeyTopic(_ context.Context, parsed *url.URL) (*valkeyTopic, error) {
	if _, err := queryParams(parsed); err != nil {
		return nil, err
	}
	client, name, err := valkeyClient(parsed)
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
