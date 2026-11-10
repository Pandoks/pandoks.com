package queue

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestCloudflareRequests checks what the adapter sends Cloudflare's API, which has no emulator;
// the CI job's live queues prove how Cloudflare answers.
func TestCloudflareRequests(t *testing.T) {
	var mutex sync.Mutex
	requests := map[string][]map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		var decoded map[string]any
		_ = json.Unmarshal(body, &decoded)
		mutex.Lock()
		requests[request.URL.Path] = append(requests[request.URL.Path], decoded)
		pushed := requests["/accounts/acct/queues/q1/messages/batch"]
		mutex.Unlock()
		result := map[string]any{}
		switch {
		case strings.HasSuffix(request.URL.Path, "/pull") && len(pushed) > 0:
			first := pushed[0]["messages"].([]any)[0].(map[string]any)
			result["messages"] = []map[string]any{{"id": "m1", "body": first["body"], "lease_id": "lease-1", "attempts": 1}}
		case strings.HasSuffix(request.URL.Path, "/ack"):
			result["ackCount"] = len(decoded["acks"].([]any))
			result["retryCount"] = len(decoded["retries"].([]any))
			if result["retryCount"] != 0 {
				result["warnings"] = map[string]string{"m1": cloudflareDeadLettered}
			}
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"success": true, "errors": []any{}, "messages": []any{}, "result": result})
	}))
	defer server.Close()
	t.Setenv("CLOUDFLARE_BASE_URL", server.URL)
	t.Setenv("CLOUDFLARE_API_TOKEN", "test")

	queue := openQueue(t, "cloudflare://acct/q1?lease=90s")
	empty := time.Now()
	if deliveries, err := queue.Receive(t.Context(), 500); err != nil || len(deliveries) != 0 {
		t.Fatalf("got %v, %v from an empty queue", deliveries, err)
	}
	if time.Since(empty) < cloudflareEmptyPollDelay {
		t.Error("an empty pull returned without waiting")
	}

	messages := make([]Message, 150)
	for index := range messages {
		messages[index] = testMessage("cloudflare")
	}
	messages[0].Delay = 1500 * time.Millisecond
	if err := queue.Send(t.Context(), messages...); err != nil {
		t.Fatal(err)
	}
	deliveries, err := queue.Receive(t.Context(), 500)
	if err != nil || len(deliveries) != 1 || deliveries[0].ID != messages[0].ID || deliveries[0].Attempt != 2 {
		t.Fatalf("got %+v, %v", deliveries, err)
	}
	if err := queue.Retry(t.Context(), 3*time.Second, deliveries...); err != nil {
		t.Fatal(err)
	}
	if err := queue.Ack(t.Context(), deliveries...); err != nil {
		t.Fatal(err)
	}
	topic := openTopic(t, "cloudflare://acct/q1,q2")
	if err := topic.Publish(t.Context(), testMessage("fanout")); err != nil {
		t.Fatal(err)
	}

	batches := requests["/accounts/acct/queues/q1/messages/batch"]
	if len(batches) != 3 || len(batches[0]["messages"].([]any)) != 100 || len(batches[1]["messages"].([]any)) != 50 {
		t.Fatalf("pushed %d batches, want 100 and 50 messages then the topic's", len(batches))
	}
	first := batches[0]["messages"].([]any)[0].(map[string]any)
	if first["content_type"] != "text" || first["delay_seconds"] != 2.0 {
		t.Errorf("first message %v, want text with its delay rounded up to 2 s", first)
	}
	if len(requests["/accounts/acct/queues/q2/messages/batch"]) != 1 {
		t.Error("the topic skipped its second queue")
	}
	pull := requests["/accounts/acct/queues/q1/messages/pull"][0]
	if pull["batch_size"] != 100.0 || pull["visibility_timeout_ms"] != 90_000.0 {
		t.Errorf("pull %v, want batch 100 and a 90 s lease", pull)
	}
	acks := requests["/accounts/acct/queues/q1/messages/ack"]
	retry := acks[0]["retries"].([]any)[0].(map[string]any)
	ack := acks[1]["acks"].([]any)[0].(map[string]any)
	if retry["lease_id"] != "lease-1" || retry["delay_seconds"] != 3.0 || ack["lease_id"] != "lease-1" {
		t.Errorf("settled with %v", acks)
	}
}
