package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/valkey-io/valkey-go"
)

type providerRequest struct {
	provider      string
	authorization string
	topic         string
	pushType      string
	priority      string
	body          map[string]any
}

// fakeProvider speaks the APNs and FCM HTTP/2 wire formats. Tokens starting with "gone-" are
// unregistered and tokens starting with "busy-" are throttled on their first request.
type fakeProvider struct {
	url              string
	mutex            sync.Mutex
	requests         map[string][]providerRequest
	oauthTokenIssued int
}

func startFakeProvider(t *testing.T, apnsPublicKey *ecdsa.PublicKey) *fakeProvider {
	provider := &fakeProvider{requests: map[string][]providerRequest{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /3/device/{token}", func(writer http.ResponseWriter, request *http.Request) {
		if !validProviderToken(strings.TrimPrefix(request.Header.Get("authorization"), "bearer "), apnsPublicKey) {
			writer.WriteHeader(http.StatusForbidden)
			_, _ = writer.Write([]byte(`{"reason":"InvalidProviderToken"}`))
			return
		}
		token := request.PathValue("token")
		attempt := provider.record(token, request, providerRequest{
			provider:      "apns",
			authorization: request.Header.Get("authorization"),
			topic:         request.Header.Get("apns-topic"),
			pushType:      request.Header.Get("apns-push-type"),
			priority:      request.Header.Get("apns-priority"),
		})
		writer.Header().Set("apns-id", "00000000-0000-0000-0000-00000000000"+strconv.Itoa(attempt%10))
		switch {
		case strings.HasPrefix(token, "gone-"):
			writer.WriteHeader(http.StatusGone)
			_, _ = writer.Write([]byte(`{"reason":"Unregistered","timestamp":1700000000000}`))
		case strings.HasPrefix(token, "busy-") && attempt == 1:
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(`{"reason":"TooManyRequests"}`))
		}
	})
	mux.HandleFunc("POST /token", func(writer http.ResponseWriter, _ *http.Request) {
		provider.mutex.Lock()
		provider.oauthTokenIssued++
		provider.mutex.Unlock()
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"fake-access-token","token_type":"Bearer","expires_in":3600}`))
	})
	mux.HandleFunc("POST /v1/projects/test-project/messages:send", func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "Bearer fake-access-token" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		token := body["message"].(map[string]any)["token"].(string)
		attempt := provider.record(token, request, providerRequest{provider: "fcm", body: body})
		switch {
		case strings.HasPrefix(token, "gone-"):
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`))
		case strings.HasPrefix(token, "busy-") && attempt == 1:
			writer.Header().Set("retry-after", "1")
			writer.WriteHeader(http.StatusServiceUnavailable)
			_, _ = writer.Write([]byte(`{"error":{"code":503,"status":"UNAVAILABLE"}}`))
		default:
			_, _ = writer.Write([]byte(`{"name":"projects/test-project/messages/` + strconv.Itoa(attempt) + `"}`))
		}
	})

	server := &http.Server{Handler: mux, ReadHeaderTimeout: time.Second, Protocols: new(http.Protocols)}
	server.Protocols.SetHTTP1(true)
	server.Protocols.SetUnencryptedHTTP2(true)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	provider.url = "http://" + listener.Addr().String()
	return provider
}

func (provider *fakeProvider) record(token string, request *http.Request, providerRequest providerRequest) int {
	if request.ProtoMajor != 2 {
		panic("provider request did not use HTTP/2")
	}
	if providerRequest.body == nil {
		_ = json.NewDecoder(request.Body).Decode(&providerRequest.body)
	}
	provider.mutex.Lock()
	defer provider.mutex.Unlock()
	provider.requests[token] = append(provider.requests[token], providerRequest)
	return len(provider.requests[token])
}

func (provider *fakeProvider) requestsFor(token string) []providerRequest {
	provider.mutex.Lock()
	defer provider.mutex.Unlock()
	return provider.requests[token]
}

func validProviderToken(token string, publicKey *ecdsa.PublicKey) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	header, _ := base64.RawURLEncoding.DecodeString(parts[0])
	claims, _ := base64.RawURLEncoding.DecodeString(parts[1])
	signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
	var decodedHeader, decodedClaims map[string]any
	if json.Unmarshal(header, &decodedHeader) != nil || json.Unmarshal(claims, &decodedClaims) != nil || len(signature) != 64 {
		return false
	}
	issuedAt, _ := decodedClaims["iat"].(float64)
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	return decodedHeader["alg"] == "ES256" && decodedHeader["kid"] == "TESTKEYID1" && decodedClaims["iss"] == "TESTTEAMID" &&
		time.Since(time.Unix(int64(issuedAt), 0)) < time.Hour &&
		ecdsa.Verify(publicKey, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:]))
}

func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", description)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestPush runs the service against real Postgres (PG* env) and Valkey (VALKEY_ADDRESS).
func TestPush(t *testing.T) {
	apnsKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	apnsKeyDER, _ := x509.MarshalPKCS8PrivateKey(apnsKey)
	fcmKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	fcmKeyDER, _ := x509.MarshalPKCS8PrivateKey(fcmKey)
	provider := startFakeProvider(t, &apnsKey.PublicKey)
	serviceAccount, _ := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   "test-project",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: fcmKeyDER})),
		"client_email": "push@test-project.iam.gserviceaccount.com",
		"token_uri":    provider.url + "/token",
	})
	t.Setenv("APNS_URL", provider.url)
	t.Setenv("APNS_KEY_ID", "TESTKEYID1")
	t.Setenv("APNS_TEAM_ID", "TESTTEAMID")
	t.Setenv("APNS_KEY", string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: apnsKeyDER})))
	t.Setenv("FCM_URL", provider.url)
	t.Setenv("FCM_SERVICE_ACCOUNT", string(serviceAccount))

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan error)
	go func() { stopped <- run(ctx, listener) }()
	t.Cleanup(func() {
		cancel()
		if err := <-stopped; err != nil {
			t.Error(err)
		}
	})
	api := "http://" + listener.Addr().String()
	database, err := pgxpool.New(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	waitFor(t, "the API to start", func() bool {
		response, err := http.Get(api + "/healthz")
		if err == nil {
			_ = response.Body.Close()
		}
		return err == nil
	})

	// Unique per run so reruns against the same database don't see old devices
	app := "com.pandoks.test" + strconv.FormatInt(time.Now().UnixNano(), 36)
	call := func(method, path string, body any) (int, string) {
		t.Helper()
		encoded, _ := json.Marshal(body)
		request, _ := http.NewRequest(method, api+path, bytes.NewReader(encoded))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		var responseBody bytes.Buffer
		_, _ = responseBody.ReadFrom(response.Body)
		return response.StatusCode, responseBody.String()
	}
	register := func(token, platform, kind, userID string) {
		t.Helper()
		status, body := call(http.MethodPut, "/devices/"+token+app, map[string]string{"platform": platform, "kind": kind, "app": app, "user_id": userID})
		if status != http.StatusNoContent {
			t.Fatalf("register %s: %d %s", token, status, body)
		}
	}
	send := func(notification map[string]any) (int, string) {
		t.Helper()
		notification["app"] = app
		return call(http.MethodPost, "/notifications", notification)
	}
	alert := map[string]any{"push_type": "alert", "apns": map[string]any{"aps": map[string]any{"alert": "hi"}}, "fcm": map[string]any{"notification": map[string]any{"title": "hi"}}}
	deviceExists := func(token string) bool {
		var exists bool
		if err := database.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM push_devices WHERE token = $1)`, token+app).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		return exists
	}
	sentTo := func(token string) []providerRequest { return provider.requestsFor(token + app) }

	t.Run("fans out to every device of the users and removes unregistered tokens", func(t *testing.T) {
		register("ios-", "ios", "", "user-1")
		register("android-", "android", "", "user-1")
		register("live-", "ios", "liveactivity", "user-1")
		register("gone-ios-", "ios", "", "user-2")
		register("gone-android-", "android", "", "user-2")
		alert["user_ids"] = []string{"user-1", "user-2"}
		if status, body := send(alert); status != http.StatusAccepted {
			t.Fatalf("send: %d %s", status, body)
		}

		waitFor(t, "unregistered tokens to be removed", func() bool { return !deviceExists("gone-ios-") && !deviceExists("gone-android-") })
		waitFor(t, "delivery", func() bool { return len(sentTo("ios-")) == 1 && len(sentTo("android-")) == 1 })
		apns := sentTo("ios-")[0]
		if apns.topic != app || apns.pushType != "alert" || apns.priority != "10" || apns.body["aps"].(map[string]any)["alert"] != "hi" {
			t.Errorf("unexpected APNs request %+v", apns)
		}
		message := sentTo("android-")[0].body["message"].(map[string]any)
		if message["token"] != "android-"+app || message["notification"].(map[string]any)["title"] != "hi" {
			t.Errorf("unexpected FCM message %+v", message)
		}
		if len(sentTo("live-")) != 0 || !deviceExists("ios-") || !deviceExists("android-") {
			t.Error("alert reached a live activity token or removed a registered device")
		}
	})

	t.Run("sends live activities to the liveactivity topic", func(t *testing.T) {
		status, body := send(map[string]any{
			"push_type": "liveactivity", "user_ids": []string{"user-1"},
			"apns": map[string]any{"aps": map[string]any{"event": "update", "timestamp": 1, "content-state": map[string]any{}}},
		})
		if status != http.StatusAccepted {
			t.Fatalf("send: %d %s", status, body)
		}
		waitFor(t, "live activity delivery", func() bool { return len(sentTo("live-")) == 1 })
		if request := sentTo("live-")[0]; request.topic != app+".push-type.liveactivity" || request.pushType != "liveactivity" {
			t.Errorf("unexpected live activity request %+v", request)
		}
	})

	t.Run("retries throttled sends", func(t *testing.T) {
		register("busy-ios-", "ios", "", "user-3")
		register("busy-android-", "android", "", "user-3")
		alert["user_ids"] = []string{"user-3"}
		if status, body := send(alert); status != http.StatusAccepted {
			t.Fatalf("send: %d %s", status, body)
		}
		waitFor(t, "throttled sends to be retried", func() bool { return len(sentTo("busy-ios-")) == 2 && len(sentTo("busy-android-")) == 2 })
	})

	t.Run("sends scheduled notifications unless cancelled", func(t *testing.T) {
		register("scheduled-", "ios", "", "user-4")
		register("cancelled-", "ios", "", "user-5")
		schedule := func(userID string) string {
			alert["user_ids"] = []string{userID}
			alert["send_at"] = time.Now().Add(2 * time.Second).Format(time.RFC3339Nano)
			status, body := send(alert)
			if status != http.StatusCreated {
				t.Fatalf("schedule: %d %s", status, body)
			}
			var created struct{ ID string }
			_ = json.Unmarshal([]byte(body), &created)
			return created.ID
		}
		schedule("user-4")
		cancelledID := schedule("user-5")
		delete(alert, "send_at")
		if status, _ := call(http.MethodDelete, "/notifications/"+cancelledID, nil); status != http.StatusNoContent {
			t.Fatalf("cancel: %d", status)
		}
		if status, _ := call(http.MethodDelete, "/notifications/"+cancelledID, nil); status != http.StatusNotFound {
			t.Fatalf("second cancel: %d", status)
		}
		if len(sentTo("scheduled-")) != 0 {
			t.Fatal("scheduled notification was sent early")
		}
		waitFor(t, "scheduled delivery", func() bool { return len(sentTo("scheduled-")) == 1 })
		time.Sleep(2 * time.Second)
		if len(sentTo("cancelled-")) != 0 {
			t.Error("cancelled notification was sent")
		}
	})

	t.Run("recovers when Valkey loses the job stream", func(t *testing.T) {
		valkeyClient, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{os.Getenv("VALKEY_ADDRESS")}, DisableCache: true})
		if err != nil {
			t.Fatal(err)
		}
		defer valkeyClient.Close()
		if err := valkeyClient.Do(ctx, valkeyClient.B().Del().Key(jobStream).Build()).Error(); err != nil {
			t.Fatal(err)
		}
		register("restarted-", "ios", "", "user-6")
		alert["user_ids"] = []string{"user-6"}
		if status, body := send(alert); status != http.StatusAccepted {
			t.Fatalf("send: %d %s", status, body)
		}
		waitFor(t, "delivery after the stream was lost", func() bool { return len(sentTo("restarted-")) == 1 })
	})

	t.Run("reuses provider credentials", func(t *testing.T) {
		authorizations := map[string]bool{}
		for _, token := range []string{"ios-", "live-", "busy-ios-", "scheduled-"} {
			for _, request := range sentTo(token) {
				authorizations[request.authorization] = true
			}
		}
		provider.mutex.Lock()
		defer provider.mutex.Unlock()
		if len(authorizations) != 1 || provider.oauthTokenIssued != 1 {
			t.Errorf("signed %d APNs tokens and fetched %d FCM tokens, want 1 each", len(authorizations), provider.oauthTokenIssued)
		}
	})
}
