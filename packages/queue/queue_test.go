package queue

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixtures(t *testing.T) map[string][]byte {
	t.Helper()
	paths, err := filepath.Glob("testdata/envelopes/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("glob fixtures: %v (%d found)", err, len(paths))
	}
	result := map[string][]byte{}
	for _, path := range paths {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		result[filepath.Base(path)] = body
	}
	return result
}

func jsonEqual(t *testing.T, got, want []byte) {
	t.Helper()
	var gotValue, wantValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("envelopes differ:\n got %s\nwant %s", got, want)
	}
}

func TestGoldenEnvelopesRoundTrip(t *testing.T) {
	for name, body := range fixtures(t) {
		t.Run(name, func(t *testing.T) {
			var delivery Delivery
			if err := decode(body, &delivery); err != nil {
				t.Fatal(err)
			}
			encoded, err := encode(delivery.Message, delivery.Time)
			if err != nil {
				t.Fatal(err)
			}
			jsonEqual(t, encoded, body)
		})
	}
}

func TestEncodeRejectsWhatOtherBrokersCannotCarry(t *testing.T) {
	valid := Message{Source: "//test", Type: "test"}
	for name, message := range map[string]Message{
		"extension name":   {Source: "//test", Type: "test", Extensions: map[string]string{"Notification-ID": "1"}},
		"attribute shadow": {Source: "//test", Type: "test", Extensions: map[string]string{"source": "x"}},
		"delay":            {Source: "//test", Type: "test", Delay: MaxDelay + time.Second},
		"size":             {Source: "//test", Type: "test", Data: []byte(`"` + strings.Repeat("x", MaxEnvelopeBytes) + `"`)},
		"invalid json":     {Source: "//test", Type: "test", Data: []byte("{")},
	} {
		if _, err := encode(message, time.Now()); err == nil {
			t.Errorf("%s: encode accepted %+v", name, message)
		}
	}
	if _, err := encode(valid, time.Now()); err != nil {
		t.Fatal(err)
	}
}

// recordingQueue hands out its deliveries once and records how the worker settles them.
type recordingQueue struct {
	mutex      sync.Mutex
	deliveries []*Delivery
	maxes      []int
	acked      []string
	retried    map[string]time.Duration
}

func (queue *recordingQueue) Send(context.Context, ...Message) error { return nil }

func (queue *recordingQueue) Receive(ctx context.Context, max int) ([]*Delivery, error) {
	queue.mutex.Lock()
	defer queue.mutex.Unlock()
	queue.maxes = append(queue.maxes, max)
	count := min(max, len(queue.deliveries))
	result := queue.deliveries[:count]
	queue.deliveries = queue.deliveries[count:]
	if count == 0 {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return result, nil
}

func (queue *recordingQueue) Ack(_ context.Context, deliveries ...*Delivery) error {
	queue.mutex.Lock()
	defer queue.mutex.Unlock()
	for _, delivery := range deliveries {
		queue.acked = append(queue.acked, delivery.ID)
	}
	return nil
}

func (queue *recordingQueue) Retry(ctx context.Context, delay time.Duration, deliveries ...*Delivery) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	queue.mutex.Lock()
	defer queue.mutex.Unlock()
	for _, delivery := range deliveries {
		queue.retried[delivery.ID] = delay
	}
	return nil
}

func (*recordingQueue) Close() error { return nil }

func TestWorkerSettlesEachOutcome(t *testing.T) {
	queue := &recordingQueue{retried: map[string]time.Duration{}}
	deadline := time.Now().Add(time.Minute)
	for _, id := range []string{"ok", "permanent", "retry-after", "failed", "panicked", "shutdown"} {
		queue.deliveries = append(queue.deliveries, &Delivery{
			Message:  Message{ID: id},
			Attempt:  3,
			Deadline: deadline,
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	var handlerDeadline time.Time
	worker := Worker{Queue: queue, Concurrency: 2, Handle: func(ctx context.Context, delivery *Delivery) error {
		switch delivery.ID {
		case "ok":
			handlerDeadline, _ = ctx.Deadline()
			return nil
		case "permanent":
			return Permanent(errors.New("malformed"))
		case "retry-after":
			return RetryAfter(time.Hour, errors.New("rate limited"))
		case "failed":
			return errors.New("transient")
		case "panicked":
			panic("boom")
		}
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}}
	if err := worker.Run(ctx); err != nil {
		t.Fatal(err)
	}

	if !handlerDeadline.Equal(deadline.Add(-handlerMargin)) {
		t.Errorf("handler deadline %v, want 10 s before the lease ends at %v", handlerDeadline, deadline)
	}
	if !reflect.DeepEqual(queue.acked, []string{"ok", "permanent"}) && !reflect.DeepEqual(queue.acked, []string{"permanent", "ok"}) {
		t.Errorf("acked %v, want ok and permanent", queue.acked)
	}
	want := map[string]time.Duration{"retry-after": MaxDelay, "failed": 4 * time.Second, "panicked": 4 * time.Second, "shutdown": 4 * time.Second}
	if !reflect.DeepEqual(queue.retried, want) {
		t.Errorf("retried %v, want %v", queue.retried, want)
	}
	for _, max := range queue.maxes {
		if max < 1 || max > worker.Concurrency {
			t.Errorf("received up to %d with concurrency %d", max, worker.Concurrency)
		}
	}
}

func TestParseLeaseRejectsOverflowingAmounts(t *testing.T) {
	if lease, err := parseLease(map[string]string{"lease": "2251799813685249h"}); err == nil {
		t.Fatalf("accepted an overflowing lease as %s", lease)
	}
}
