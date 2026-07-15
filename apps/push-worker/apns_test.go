package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAPNsClientSend(t *testing.T) {
	t.Parallel()

	var (
		mu             sync.Mutex
		authorizations []string
	)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
		}

		mu.Lock()
		authorizations = append(authorizations, request.Header.Get("Authorization"))
		mu.Unlock()

		if request.URL.Path != "/3/device/device-token" {
			t.Errorf("path = %q", request.URL.Path)
		}
		if request.Header.Get("apns-topic") != "com.example.app" {
			t.Errorf("apns-topic = %q", request.Header.Get("apns-topic"))
		}
		if request.Header.Get("apns-push-type") != "alert" {
			t.Errorf("apns-push-type = %q", request.Header.Get("apns-push-type"))
		}
		if request.Header.Get("apns-priority") != "10" {
			t.Errorf("apns-priority = %q", request.Header.Get("apns-priority"))
		}
		if request.Header.Get("apns-collapse-id") != "message-42" {
			t.Errorf("apns-collapse-id = %q", request.Header.Get("apns-collapse-id"))
		}
		if !strings.HasPrefix(request.Header.Get("Authorization"), "bearer ") {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}

		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Error(err)
		}
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	now := time.Unix(1_800_000_000, 0)
	client, err := newAPNsClient(APNsConfig{
		TeamID:     "TEAMID1234",
		KeyID:      "KEYID12345",
		PrivateKey: testAPNsPrivateKey(t),
		Endpoint:   server.URL,
	}, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}

	job := APNsJob{
		Token:      "device-token",
		Topic:      "com.example.app",
		PushType:   "alert",
		Priority:   10,
		Expiration: 1_800_000_100,
		CollapseID: "message-42",
		Payload:    json.RawMessage(`{"aps":{"alert":{"title":"Hello"}}}`),
	}
	if err := client.Send(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if err := client.Send(context.Background(), job); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	first := authorizations[0]
	second := authorizations[1]
	mu.Unlock()
	if first != second {
		t.Fatal("provider token was not reused")
	}

	now = now.Add(51 * time.Minute)
	if err := client.Send(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	third := authorizations[2]
	mu.Unlock()
	if third == second {
		t.Fatal("provider token was not refreshed")
	}
}

func TestAPNsClientReturnsRejection(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusBadRequest)
		_, _ = response.Write([]byte(`{"reason":"BadDeviceToken"}`))
	}))
	t.Cleanup(server.Close)

	client, err := newAPNsClient(APNsConfig{
		TeamID:     "TEAMID1234",
		KeyID:      "KEYID12345",
		PrivateKey: testAPNsPrivateKey(t),
		Endpoint:   server.URL,
	}, server.Client(), time.Now)
	if err != nil {
		t.Fatal(err)
	}

	err = client.Send(context.Background(), APNsJob{
		Token:    "bad-token",
		Topic:    "com.example.app",
		PushType: "alert",
		Priority: 10,
		Payload:  json.RawMessage(`{"aps":{}}`),
	})
	if err == nil || !strings.Contains(err.Error(), "400 BadDeviceToken") {
		t.Fatalf("error = %v", err)
	}
}

func testAPNsPrivateKey(t *testing.T) []byte {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}
