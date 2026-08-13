package valkey

import (
	"context"
	"errors"
	"fmt"
	"queueworker"
	"strconv"
	"strings"
	"sync"
	"time"

	valkeygo "github.com/valkey-io/valkey-go"
)

const bodyField = "body"

type Options struct {
	Stream            string
	Group             string
	Consumer          string
	BatchSize         int
	BlockTime         time.Duration
	VisibilityTimeout time.Duration
	DeleteOnAck       bool
	MaxDeliveries     int64
	DeadLetterStream  string
	StartID           string
	PublishBatchSize  int
}

func DefaultOptions(stream, group, consumer string) Options {
	return Options{
		Stream:            stream,
		Group:             group,
		Consumer:          consumer,
		BatchSize:         100,
		BlockTime:         5 * time.Second,
		VisibilityTimeout: 60 * time.Second,
		DeleteOnAck:       true,
		MaxDeliveries:     5,
		DeadLetterStream:  stream + ":dlq",
		StartID:           "0",
		PublishBatchSize:  100,
	}
}

func New(client valkeygo.Client, options Options) (*Queue, error) {
	if client == nil {
		return nil, errors.New("valkey client is required")
	}
	if options.Stream == "" {
		return nil, errors.New("valkey stream is required")
	}
	if (options.Group == "") != (options.Consumer == "") {
		return nil, errors.New("valkey group and consumer must be configured together")
	}
	if options.BatchSize < 1 || options.PublishBatchSize < 1 {
		return nil, errors.New("valkey batch sizes must be positive")
	}
	if options.BlockTime <= 0 || options.BlockTime%time.Millisecond != 0 {
		return nil, errors.New("valkey block time must be positive whole milliseconds")
	}
	if options.VisibilityTimeout <= 0 ||
		options.VisibilityTimeout%time.Millisecond != 0 {
		return nil, errors.New(
			"valkey visibility timeout must be positive whole milliseconds",
		)
	}
	if options.StartID == "" {
		return nil, errors.New("valkey consumer group start ID is required")
	}
	if (options.MaxDeliveries > 0) != (options.DeadLetterStream != "") {
		return nil, errors.New(
			"valkey max deliveries and dead-letter stream must be configured together",
		)
	}
	return &Queue{client: client, options: options}, nil
}

type Queue struct {
	client     valkeygo.Client
	options    Options
	groupMu    sync.Mutex
	groupReady bool
}

type delivery struct {
	queue    *Queue
	id       string
	body     []byte
	attempts int
}

func (message *delivery) ID() string   { return message.id }
func (message *delivery) Body() []byte { return message.body }
func (message *delivery) Attempts() int {
	return message.attempts
}

func (queue *Queue) Receive(ctx context.Context) ([]queueworker.Message, error) {
	if queue.options.Group == "" {
		return nil, errors.New("receive Valkey messages: group and consumer are required")
	}
	if err := queue.ensureGroup(ctx); err != nil {
		return nil, err
	}
	claimed, err := queue.claimExpired(ctx)
	if err != nil {
		return nil, err
	}
	if len(claimed) != 0 {
		return queue.deliver(ctx, claimed)
	}
	command := queue.client.B().Xreadgroup().
		Group(queue.options.Group, queue.options.Consumer).
		Count(int64(queue.options.BatchSize)).
		Block(queue.options.BlockTime.Milliseconds()).
		Streams().Key(queue.options.Stream).Id(">").Build()
	streams, err := queue.client.Do(ctx, command).AsXRead()
	if valkeygo.IsValkeyNil(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read Valkey stream: %w", err)
	}
	return queue.deliver(ctx, streams[queue.options.Stream])
}

func (queue *Queue) ensureGroup(ctx context.Context) error {
	queue.groupMu.Lock()
	defer queue.groupMu.Unlock()
	if queue.groupReady {
		return nil
	}
	command := queue.client.B().XgroupCreate().Key(queue.options.Stream).
		Group(queue.options.Group).Id(queue.options.StartID).Mkstream().Build()
	if err := queue.client.Do(ctx, command).Error(); err != nil &&
		!strings.Contains(err.Error(), "BUSYGROUP") {
		return fmt.Errorf("create Valkey consumer group: %w", err)
	}
	queue.groupReady = true
	return nil
}

func (queue *Queue) claimExpired(ctx context.Context) ([]valkeygo.XRangeEntry, error) {
	command := queue.client.B().Xautoclaim().Key(queue.options.Stream).
		Group(queue.options.Group).Consumer(queue.options.Consumer).
		MinIdleTime(strconv.FormatInt(queue.options.VisibilityTimeout.Milliseconds(), 10)).
		Start("0-0").Count(int64(queue.options.BatchSize)).Build()
	values, err := queue.client.Do(ctx, command).ToArray()
	if err != nil {
		return nil, fmt.Errorf("claim expired Valkey messages: %w", err)
	}
	if len(values) < 2 {
		return nil, errors.New("claim expired Valkey messages: malformed response")
	}
	entries, err := values[1].AsXRange()
	if err != nil {
		return nil, fmt.Errorf("claim expired Valkey messages: %w", err)
	}
	return entries, nil
}

func (queue *Queue) deliver(
	ctx context.Context,
	entries []valkeygo.XRangeEntry,
) ([]queueworker.Message, error) {
	deliveryCounts, err := queue.deliveryCounts(ctx, entries)
	if err != nil {
		return nil, err
	}
	messages := make([]queueworker.Message, 0, len(entries))
	for index, entry := range entries {
		body, ok := entry.FieldValues[bodyField]
		if !ok {
			return nil, fmt.Errorf(
				"read Valkey message %q: body field is missing",
				entry.ID,
			)
		}
		deliveries := deliveryCounts[index]
		if queue.options.MaxDeliveries > 0 && deliveries > queue.options.MaxDeliveries {
			if err := queue.deadLetter(ctx, entry.ID, body, deliveries); err != nil {
				return nil, err
			}
			continue
		}
		messages = append(messages, &delivery{
			queue:    queue,
			id:       entry.ID,
			body:     []byte(body),
			attempts: int(deliveries),
		})
	}
	return messages, nil
}

func (queue *Queue) deliveryCounts(
	ctx context.Context,
	entries []valkeygo.XRangeEntry,
) ([]int64, error) {
	commands := make([]valkeygo.Completed, 0, len(entries))
	for _, entry := range entries {
		commands = append(commands, queue.client.B().Xpending().
			Key(queue.options.Stream).Group(queue.options.Group).
			Start(entry.ID).End(entry.ID).Count(1).Build())
	}
	responses := queue.client.DoMulti(ctx, commands...)
	counts := make([]int64, len(entries))
	for index, response := range responses {
		id := entries[index].ID
		rows, err := response.ToArray()
		if err != nil {
			return nil, fmt.Errorf("inspect Valkey message %q: %w", id, err)
		}
		if len(rows) != 1 {
			return nil, fmt.Errorf("inspect Valkey message %q: pending entry is missing", id)
		}
		columns, err := rows[0].ToArray()
		if err != nil || len(columns) != 4 {
			return nil, fmt.Errorf("inspect Valkey message %q: malformed pending entry", id)
		}
		counts[index], err = columns[3].ToInt64()
		if err != nil {
			return nil, fmt.Errorf(
				"inspect Valkey message %q delivery count: %w",
				id,
				err,
			)
		}
	}
	return counts, nil
}

func (queue *Queue) deadLetter(
	ctx context.Context,
	id, body string,
	deliveries int64,
) error {
	add := queue.client.B().Xadd().Key(queue.options.DeadLetterStream).
		Id("*").FieldValue().
		FieldValue(bodyField, body).
		FieldValue("source_id", id).
		FieldValue("deliveries", strconv.FormatInt(deliveries, 10)).Build()
	if _, err := queue.client.Do(ctx, add).ToString(); err != nil {
		return fmt.Errorf(
			"write Valkey message %q to dead-letter stream: %w",
			id,
			err,
		)
	}
	return queue.acknowledge(ctx, []string{id}, true)
}

func (queue *Queue) Settle(ctx context.Context, settlement queueworker.Settlement) error {
	acknowledge, err := queue.deliveryIDs(settlement.Acknowledge)
	if err != nil {
		return err
	}
	if _, err := queue.deliveryIDs(settlement.Retry); err != nil {
		return err
	}
	return queue.acknowledge(ctx, acknowledge, false)
}

func (queue *Queue) deliveryIDs(messages []queueworker.Message) ([]string, error) {
	ids := make([]string, 0, len(messages))
	for _, message := range messages {
		item, ok := message.(*delivery)
		if !ok || item.queue != queue {
			return nil, fmt.Errorf(
				"settle Valkey message %q: message belongs to another queue",
				message.ID(),
			)
		}
		ids = append(ids, item.id)
	}
	return ids, nil
}

func (queue *Queue) acknowledge(ctx context.Context, ids []string, deadLetter bool) error {
	if len(ids) == 0 {
		return nil
	}
	acknowledged, err := queue.client.Do(
		ctx,
		queue.client.B().Xack().Key(queue.options.Stream).
			Group(queue.options.Group).Id(ids...).Build(),
	).ToInt64()
	if err != nil {
		return fmt.Errorf("acknowledge Valkey messages: %w", err)
	}
	if acknowledged != int64(len(ids)) {
		return fmt.Errorf(
			"acknowledge Valkey messages: acknowledged %d of %d",
			acknowledged,
			len(ids),
		)
	}
	if !queue.options.DeleteOnAck {
		return nil
	}
	deleted, err := queue.client.Do(
		ctx,
		queue.client.B().Xdel().Key(queue.options.Stream).Id(ids...).Build(),
	).ToInt64()
	if err != nil {
		return fmt.Errorf("delete acknowledged Valkey messages: %w", err)
	}
	if deleted != int64(len(ids)) {
		label := "acknowledged"
		if deadLetter {
			label = "dead-lettered"
		}
		return fmt.Errorf(
			"delete %s Valkey messages: deleted %d of %d",
			label,
			deleted,
			len(ids),
		)
	}
	return nil
}

func (queue *Queue) Publish(ctx context.Context, messages []queueworker.Publication) error {
	for start := 0; start < len(messages); start += queue.options.PublishBatchSize {
		end := min(start+queue.options.PublishBatchSize, len(messages))
		commands := make([]valkeygo.Completed, 0, end-start)
		for _, message := range messages[start:end] {
			builder := queue.client.B().Xadd().Key(queue.options.Stream).Id("*").
				FieldValue().FieldValue(bodyField, valkeygo.BinaryString(message.Body))
			if message.ID != "" {
				builder = builder.FieldValue("message_id", message.ID)
			}
			commands = append(commands, builder.Build())
		}
		responses := queue.client.DoMulti(ctx, commands...)
		failures := make([]queueworker.PublishFailure, 0)
		for index, response := range responses {
			if err := response.Error(); err != nil {
				absolute := start + index
				failures = append(failures, queueworker.PublishFailure{
					Index: absolute,
					ID:    messages[absolute].ID,
					Err:   err,
				})
			}
		}
		if len(failures) != 0 {
			return &queueworker.PublishError{Failures: failures}
		}
	}
	return nil
}

func (queue *Queue) Close() error {
	queue.client.Close()
	return nil
}
