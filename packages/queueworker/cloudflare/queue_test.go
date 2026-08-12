package cloudflare_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"queueworker"
	"strings"
	"sync"
	"testing"
	"time"

	cloudflarequeue "queueworker/cloudflare"
)

func TestQueuePublishesPullsAndSettlesAgainstAPIContract(t *testing.T) {
	t.Parallel()
	stub := newQueueStub(t)
	defer stub.Close()
	options := cloudflarequeue.DefaultOptions("account", "queue", "token")
	options.BaseURL = stub.URL
	options.EmptyPollDelay = 0
	options.PublishBatchSize = 2
	queue, err := cloudflarequeue.New(options)
	if err != nil {
		t.Fatal(err)
	}
	publications := []queueworker.Publication{
		{ID: "a", Body: []byte("a")},
		{ID: "b", Body: []byte("b")},
		{ID: "c", Body: []byte("c")},
	}
	if err := queue.Publish(context.Background(), publications); err != nil {
		t.Fatal(err)
	}
	messages, err := queue.Receive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 3 || string(messages[2].Body()) != "c" {
		t.Fatalf("messages = %#v", messages)
	}
	if err := queue.Settle(context.Background(), queueworker.Settlement{
		Acknowledge: messages[:2],
		Retry:       messages[2:],
	}); err != nil {
		t.Fatal(err)
	}
	stub.state.mu.Lock()
	defer stub.state.mu.Unlock()
	if stub.state.batchCalls != 2 || len(stub.state.acked) != 2 || len(stub.state.retried) != 1 {
		t.Fatalf(
			"batch calls = %d, acks = %#v, retries = %#v",
			stub.state.batchCalls,
			stub.state.acked,
			stub.state.retried,
		)
	}
}

func TestQueueCancelsHTTPPull(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-release
	}))
	defer server.Close()
	defer close(release)
	options := cloudflarequeue.DefaultOptions("account", "queue", "token")
	options.BaseURL = server.URL
	queue, err := cloudflarequeue.New(options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = queue.Receive(ctx)
	if err == nil || !strings.Contains(err.Error(), context.DeadlineExceeded.Error()) {
		t.Fatalf("Receive error = %v", err)
	}
}

type queuedMessage struct {
	id    string
	body  string
	lease string
}

type stubState struct {
	mu         sync.Mutex
	messages   []queuedMessage
	acked      []string
	retried    []string
	batchCalls int
}

type queueStub struct {
	*httptest.Server
	state *stubState
}

func newQueueStub(t *testing.T) *queueStub {
	t.Helper()
	state := &stubState{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer token" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(request.URL.Path, "/messages/batch"):
			var body struct {
				Messages []struct {
					Body string `json:"body"`
				} `json:"messages"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			state.mu.Lock()
			state.batchCalls++
			for _, message := range body.Messages {
				id := fmt.Sprintf("id-%d", len(state.messages)+1)
				state.messages = append(state.messages, queuedMessage{
					id: id, body: message.Body, lease: "lease-" + id,
				})
			}
			state.mu.Unlock()
			writeJSON(writer, map[string]any{"success": true, "result": map[string]any{}})
		case strings.HasSuffix(request.URL.Path, "/messages/pull"):
			state.mu.Lock()
			messages := append([]queuedMessage(nil), state.messages...)
			state.mu.Unlock()
			result := make([]map[string]any, 0, len(messages))
			for _, message := range messages {
				result = append(result, map[string]any{
					"id": message.id, "body": message.body, "lease_id": message.lease,
					"attempts": 1,
				})
			}
			writeJSON(writer, map[string]any{
				"success": true,
				"result":  map[string]any{"messages": result},
			})
		case strings.HasSuffix(request.URL.Path, "/messages/ack"):
			var body struct {
				Acks    []lease `json:"acks"`
				Retries []lease `json:"retries"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			state.mu.Lock()
			for _, ack := range body.Acks {
				state.acked = append(state.acked, ack.LeaseID)
			}
			for _, retry := range body.Retries {
				state.retried = append(state.retried, retry.LeaseID)
			}
			state.mu.Unlock()
			writeJSON(writer, map[string]any{
				"success": true,
				"result": map[string]any{
					"ackCount": len(body.Acks), "retryCount": len(body.Retries),
					"warnings": map[string]string{},
				},
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	return &queueStub{Server: server, state: state}
}

type lease struct {
	LeaseID string `json:"lease_id"`
}

func writeJSON(writer http.ResponseWriter, value any) {
	_ = json.NewEncoder(writer).Encode(value)
}
