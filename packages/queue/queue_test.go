package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixtures(t *testing.T, directory string) map[string][]byte {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join("testdata", directory, "*.json"))
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
	for name, body := range fixtures(t, "envelopes") {
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
			if strings.ContainsAny(string(encoded), "\uFFFE\uFFFF") {
				t.Fatalf("SQS rejects the raw U+FFFE or U+FFFF in %s", encoded)
			}
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
		"invalid utf-8":    {Source: "//test", Type: "test", Data: []byte("\"\xff\"")},
		"leading bom":      {Source: "//test", Type: "test", Data: []byte("\uFEFF{}")},
		"infinite number":  {Source: "//test", Type: "test", Data: []byte("1e400")},
		"nesting depth":    {Source: "//test", Type: "test", Data: []byte(strings.Repeat("[", maxDepth) + strings.Repeat("]", maxDepth))},
		"utf-8 id":         {ID: "\xff", Source: "//test", Type: "test"},
		"utf-8 type":       {Source: "//test", Type: "\xe2\x82"},
		"utf-8 extension":  {Source: "//test", Type: "test", Extensions: map[string]string{"ext": "\xff"}},
	} {
		if _, err := encode(message, time.Now()); err == nil {
			t.Errorf("%s: encode accepted %+v", name, message)
		}
	}
	if _, err := encode(valid, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeRejectsBothDataMembers(t *testing.T) {
	body := []byte(`{"specversion":"1.0","id":"x","source":"//test","type":"test","time":"2026-11-09T18:00:00.000Z","data":{},"data_base64":"e30="}`)
	if err := decode(body, &Delivery{}); err == nil {
		t.Fatal("decode accepted both data and data_base64")
	}
}

func TestDecodeRejectsMalformedEnvelopes(t *testing.T) {
	for name, body := range fixtures(t, "malformed") {
		if err := decode(body, &Delivery{}); err == nil {
			t.Errorf("%s: decode accepted %.200s", name, body)
		}
	}
}

func TestDecodeKeepsAnEmptyContentType(t *testing.T) {
	var delivery Delivery
	if err := decode([]byte(`{"specversion":"1.0","id":"x","source":"//test","type":"test","time":"2026-11-09T18:00:00.000Z","datacontenttype":""}`), &delivery); err != nil {
		t.Fatal(err)
	}
	if delivery.ContentType != "" {
		t.Fatalf("content type %q, want the envelope's empty one", delivery.ContentType)
	}
}

func TestDecodeRejectsWhatPythonAndTSReject(t *testing.T) {
	envelope := `{"specversion":"1.0","id":"x","source":"//test","type":"test","time":"%s"%s}`
	for name, body := range map[string]string{
		"invalid utf-8":       fmt.Sprintf(envelope, "2026-11-09T18:00:00.000Z", `,"ext":"`+"\xff"+`"`),
		"offset +24:00":       fmt.Sprintf(envelope, "2026-11-09T18:00:00+24:00", ""),
		"offset +00:60":       fmt.Sprintf(envelope, "2026-11-09T18:00:00+00:60", ""),
		"comma fraction":      fmt.Sprintf(envelope, "2026-11-09T18:00:00,123Z", ""),
		"year 0000":           fmt.Sprintf(envelope, "0000-01-01T00:00:00Z", ""),
		"base64 line break":   fmt.Sprintf(envelope, "2026-11-09T18:00:00.000Z", `,"data_base64":"e3\r\n0="`),
		"base64 padding bits": fmt.Sprintf(envelope, "2026-11-09T18:00:00.000Z", `,"data_base64":"e31="`),
	} {
		if err := decode([]byte(body), &Delivery{}); err == nil {
			t.Errorf("%s: decode accepted %q", name, body)
		}
	}
}

func TestEncodeWritesHTMLUnescaped(t *testing.T) {
	html := Message{Source: "//test", Type: "test", Data: []byte(`"` + strings.Repeat("<&>", (MaxEnvelopeBytes-300)/3) + `"`)}
	body, err := encode(html, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "<&>") {
		t.Fatalf("escaped HTML in %.200s", body)
	}
}

func TestEncodeWritesLineSeparatorsUnescaped(t *testing.T) {
	// 20,000 separators are 60,000 bytes unescaped and 120,000 escaped
	separators := strings.Repeat("\u2028\u2029", 5_000)
	data := `"\\u2028` + separators + `"`
	body, err := encode(Message{Source: "//test", Type: "test", Extensions: map[string]string{"note": separators}, Data: []byte(data)}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var delivery Delivery
	if err := decode(body, &delivery); err != nil {
		t.Fatal(err)
	}
	if delivery.Extensions["note"] != separators || string(delivery.Data) != data {
		t.Fatalf("decoded %.100q and %.100q", delivery.Extensions["note"], delivery.Data)
	}
}

func TestOpenRejectsMalformedURLs(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "malformed-urls.json"))
	if err != nil {
		t.Fatal(err)
	}
	var urls struct{ Queues, Topics []string }
	if err := json.Unmarshal(body, &urls); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLOUDFLARE_API_TOKEN", "test")
	check := func(rawURL string, closer io.Closer, err error) {
		if err == nil {
			_ = closer.Close()
		}
		if err == nil || !strings.Contains(err.Error(), "URL") || strings.Contains(err.Error(), "xq1") || strings.Contains(err.Error(), "zq2") {
			t.Errorf("%s: error %v, want a URL error without the password", rawURL, err)
		}
	}
	for _, rawURL := range urls.Queues {
		queue, err := Open(t.Context(), rawURL)
		check(rawURL, queue, err)
	}
	for _, rawURL := range urls.Topics {
		topic, err := OpenTopic(t.Context(), rawURL)
		check(rawURL, topic, err)
	}
	if _, err := OpenTopic(t.Context(), "valkey://127.0.0.1/t"); err == nil || !strings.Contains(err.Error(), "host:port") {
		t.Errorf("OpenTopic without a port: error %v, want the URL format", err)
	}
}

// recordingQueue hands out its deliveries once and records how the worker settles them.
// cancelOnReceive, when set, is called as a receive returns, like a shutdown racing it.
type recordingQueue struct {
	mutex           sync.Mutex
	deliveries      []*Delivery
	maxes           []int
	acked           []string
	retried         map[string]time.Duration
	cancelOnReceive context.CancelFunc
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
	if queue.cancelOnReceive != nil {
		queue.cancelOnReceive()
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
	for _, id := range []string{"ok", "permanent", "retry-after", "expired", "failed", "panicked", "shutdown"} {
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
		case "expired":
			return RetryAfter(-time.Second, errors.New("retry date passed"))
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
	want := map[string]time.Duration{"retry-after": MaxDelay, "expired": 0, "failed": 4 * time.Second, "panicked": 4 * time.Second, "shutdown": 4 * time.Second}
	if !reflect.DeepEqual(queue.retried, want) {
		t.Errorf("retried %v, want %v", queue.retried, want)
	}
	for _, max := range queue.maxes {
		if max < 1 || max > worker.Concurrency {
			t.Errorf("received up to %d with concurrency %d", max, worker.Concurrency)
		}
	}
}

func TestWorkerReleasesWhatItReceivesAfterShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	queue := &recordingQueue{
		deliveries:      []*Delivery{{Message: Message{ID: "late"}, Attempt: 1, Deadline: time.Now().Add(time.Minute)}},
		retried:         map[string]time.Duration{},
		cancelOnReceive: cancel,
	}
	handled := false
	worker := Worker{Queue: queue, Concurrency: 1, Handle: func(context.Context, *Delivery) error {
		handled = true
		return nil
	}}
	if err := worker.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if handled || len(queue.acked) > 0 || !reflect.DeepEqual(queue.retried, map[string]time.Duration{"late": 0}) {
		t.Errorf("handled %v, acked %v, retried %v; want only a retry after 0", handled, queue.acked, queue.retried)
	}
}

func TestDelayMillisecondsRoundsUp(t *testing.T) {
	for delay, want := range map[time.Duration]int64{0: 0, 500 * time.Microsecond: 1, 1900 * time.Microsecond: 2, 2 * time.Millisecond: 2} {
		if got := delayMilliseconds(delay); got != want {
			t.Errorf("delayMilliseconds(%s) = %d, want %d", delay, got, want)
		}
	}
}

func TestParseLeaseRejectsOverflowingAmounts(t *testing.T) {
	if lease, err := parseLease(map[string]string{"lease": "2251799813685249h"}); err == nil {
		t.Fatalf("accepted an overflowing lease as %s", lease)
	}
}
