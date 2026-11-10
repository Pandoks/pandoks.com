package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/queues"
)

const (
	cloudflareBatchCount     = 100
	cloudflareBatchBytes     = 256_000
	cloudflareMetadataBytes  = 100
	cloudflareEmptyPollDelay = time.Second
)

// cloudflareQueue is a Cloudflare queue with an HTTP pull consumer. Credentials come from
// CLOUDFLARE_API_TOKEN, a token with Queues Edit.
type cloudflareQueue struct {
	client  *cloudflare.Client
	account string
	id      string
	lease   time.Duration
}

func cloudflareQueues(parsed *url.URL, allowed ...string) ([]*cloudflareQueue, map[string]string, error) {
	params, err := queryParams(parsed, allowed...)
	if err != nil {
		return nil, nil, err
	}
	if os.Getenv("CLOUDFLARE_API_TOKEN") == "" {
		return nil, nil, errors.New("cloudflare URL: CLOUDFLARE_API_TOKEN is not set")
	}
	ids := strings.Split(strings.TrimPrefix(parsed.Path, "/"), ",")
	if parsed.Host == "" || slices.Contains(ids, "") {
		return nil, nil, fmt.Errorf("cloudflare URL %q must be cloudflare://<account_id>/<queue_id>[,<queue_id>…]", parsed)
	}
	client := cloudflare.NewClient()
	queueList := make([]*cloudflareQueue, len(ids))
	for index, id := range ids {
		queueList[index] = &cloudflareQueue{client: client, account: parsed.Host, id: id}
	}
	return queueList, params, nil
}

func openCloudflare(parsed *url.URL) (*cloudflareQueue, error) {
	queueList, params, err := cloudflareQueues(parsed, "lease")
	if err != nil {
		return nil, err
	}
	if len(queueList) != 1 {
		return nil, errors.New("cloudflare URL: a queue has one queue id; a list is a topic")
	}
	if queueList[0].lease, err = parseLease(params); err != nil {
		return nil, fmt.Errorf("cloudflare URL: %w", err)
	}
	return queueList[0], nil
}

func cloudflareEntries(messages []Message, sentAt time.Time) ([]queues.MessageBulkPushParamsMessageUnion, error) {
	entries := make([]queues.MessageBulkPushParamsMessageUnion, len(messages))
	for index, message := range messages {
		body, err := encode(message, sentAt)
		if err != nil {
			return nil, err
		}
		entries[index] = queues.MessageBulkPushParamsMessagesMqQueueMessageText{
			Body:         cloudflare.F(string(body)),
			ContentType:  cloudflare.F(queues.MessageBulkPushParamsMessagesMqQueueMessageTextContentTypeText),
			DelaySeconds: cloudflare.F(float64(delaySeconds(message.Delay))),
		}
	}
	return entries, nil
}

func (queue *cloudflareQueue) push(ctx context.Context, entries []queues.MessageBulkPushParamsMessageUnion) error {
	size := func(entry queues.MessageBulkPushParamsMessageUnion) int {
		return len(entry.(queues.MessageBulkPushParamsMessagesMqQueueMessageText).Body.Value) + cloudflareMetadataBytes
	}
	for _, batch := range batches(entries, size, cloudflareBatchCount, cloudflareBatchBytes) {
		params := queues.MessageBulkPushParams{AccountID: cloudflare.F(queue.account), Messages: cloudflare.F(batch)}
		if _, err := queue.client.Queues.Messages.BulkPush(ctx, queue.id, params); err != nil {
			return fmt.Errorf("send to Cloudflare queue %s: %w", queue.id, err)
		}
	}
	return nil
}

func (queue *cloudflareQueue) Send(ctx context.Context, messages ...Message) error {
	entries, err := cloudflareEntries(messages, time.Now())
	if err != nil {
		return err
	}
	return queue.push(ctx, entries)
}

func (queue *cloudflareQueue) Receive(ctx context.Context, max int) ([]*Delivery, error) {
	if max < 1 {
		return nil, fmt.Errorf("receive from Cloudflare: max %d must be at least 1", max)
	}
	deadline := time.Now().Add(queue.lease)
	response, err := queue.client.Queues.Messages.Pull(ctx, queue.id, queues.MessagePullParams{
		AccountID:           cloudflare.F(queue.account),
		BatchSize:           cloudflare.F(float64(min(max, cloudflareBatchCount))),
		VisibilityTimeoutMs: cloudflare.F(float64(queue.lease.Milliseconds())),
	})
	if err != nil {
		return nil, fmt.Errorf("receive from Cloudflare queue %s: %w", queue.id, err)
	}
	deliveries := make([]*Delivery, 0, len(response.Messages))
	var malformed []*Delivery
	for _, message := range response.Messages {
		delivery := &Delivery{Attempt: int(message.Attempts) + 1, Deadline: deadline, handle: message.LeaseID}
		if err := decode([]byte(message.Body), delivery); err != nil {
			slog.Error("queue dropped a malformed message", "message_id", message.ID, "error", err)
			malformed = append(malformed, delivery)
			continue
		}
		deliveries = append(deliveries, delivery)
	}
	if err := queue.Ack(ctx, malformed...); err != nil {
		return nil, err
	}
	// NOTE: pulls don't long-poll and every empty one is a billed read
	if len(response.Messages) == 0 {
		select {
		case <-time.After(cloudflareEmptyPollDelay):
		case <-ctx.Done():
		}
	}
	return deliveries, nil
}

func (queue *cloudflareQueue) settle(ctx context.Context, acks []queues.MessageAckParamsAck, retries []queues.MessageAckParamsRetry) error {
	response, err := queue.client.Queues.Messages.Ack(ctx, queue.id, queues.MessageAckParams{
		AccountID: cloudflare.F(queue.account),
		Acks:      cloudflare.F(acks),
		Retries:   cloudflare.F(retries),
	})
	if err != nil {
		return fmt.Errorf("settle Cloudflare queue %s messages: %w", queue.id, err)
	}
	if int(response.AckCount) != len(acks) || int(response.RetryCount) != len(retries) || len(response.Warnings) > 0 {
		return fmt.Errorf("settle Cloudflare queue %s messages: acked %d of %d, retried %d of %d, warnings %v",
			queue.id, int(response.AckCount), len(acks), int(response.RetryCount), len(retries), response.Warnings)
	}
	return nil
}

func (queue *cloudflareQueue) Ack(ctx context.Context, deliveries ...*Delivery) error {
	for batch := range slices.Chunk(deliveries, cloudflareBatchCount) {
		acks := make([]queues.MessageAckParamsAck, len(batch))
		for index, delivery := range batch {
			acks[index] = queues.MessageAckParamsAck{LeaseID: cloudflare.F(delivery.handle.(string))}
		}
		if err := queue.settle(ctx, acks, []queues.MessageAckParamsRetry{}); err != nil {
			return err
		}
	}
	return nil
}

func (queue *cloudflareQueue) Retry(ctx context.Context, delay time.Duration, deliveries ...*Delivery) error {
	if err := checkDelay(delay); err != nil {
		return fmt.Errorf("retry Cloudflare messages: %w", err)
	}
	for batch := range slices.Chunk(deliveries, cloudflareBatchCount) {
		retries := make([]queues.MessageAckParamsRetry, len(batch))
		for index, delivery := range batch {
			retries[index] = queues.MessageAckParamsRetry{
				LeaseID:      cloudflare.F(delivery.handle.(string)),
				DelaySeconds: cloudflare.F(float64(delaySeconds(delay))),
			}
		}
		if err := queue.settle(ctx, []queues.MessageAckParamsAck{}, retries); err != nil {
			return err
		}
	}
	return nil
}

func (*cloudflareQueue) Close() error { return nil }

// cloudflareTopic sends each message to every listed queue. It isn't atomic: a failed publish
// is retried whole, so subscribers dedupe on the envelope id.
type cloudflareTopic struct{ subscriptions []*cloudflareQueue }

func openCloudflareTopic(parsed *url.URL) (*cloudflareTopic, error) {
	queueList, _, err := cloudflareQueues(parsed)
	if err != nil {
		return nil, err
	}
	return &cloudflareTopic{subscriptions: queueList}, nil
}

func (topic *cloudflareTopic) Publish(ctx context.Context, messages ...Message) error {
	for _, message := range messages {
		if message.Delay != 0 {
			return errors.New("publish to Cloudflare: topics take no delay")
		}
	}
	entries, err := cloudflareEntries(messages, time.Now())
	if err != nil {
		return err
	}
	for _, subscription := range topic.subscriptions {
		if err := subscription.push(ctx, entries); err != nil {
			return err
		}
	}
	return nil
}

func (*cloudflareTopic) Close() error { return nil }
