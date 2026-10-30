package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type providerRequest struct {
	environment   string
	authorization string
	topic         string
	pushType      string
	priority      string
	body          map[string]any
}

// fakeProvider speaks the APNs and FCM HTTP/2 wire formats over TLS. Tokens starting with "gone-"
// are unregistered, "invalid-" are malformed FCM tokens, "busy-" are throttled on their first
// request, "hang-", "slow-", "stuck-", and "burst-" block their first request until release,
// releaseSlow, releaseStuck, and releaseBurst are closed, and "sandbox-" are valid only on the
// sandbox APNs host while every other APNs token is valid only on production.
type fakeProvider struct {
	mutex            sync.Mutex
	requests         map[string][]providerRequest
	oauthTokenIssued int
	release          chan struct{}
	releaseSlow      chan struct{}
	releaseStuck     chan struct{}
	releaseBurst     chan struct{}
}

func (provider *fakeProvider) serve(t *testing.T, apnsPublicKey *ecdsa.PublicKey, environment string) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /3/device/{token}", func(writer http.ResponseWriter, request *http.Request) {
		if !validProviderToken(strings.TrimPrefix(request.Header.Get("authorization"), "bearer "), apnsPublicKey) {
			writer.WriteHeader(http.StatusForbidden)
			_, _ = writer.Write([]byte(`{"reason":"InvalidProviderToken"}`))
			return
		}
		token := request.PathValue("token")
		attempt := provider.record(token, request, providerRequest{
			environment:   environment,
			authorization: request.Header.Get("authorization"),
			topic:         request.Header.Get("apns-topic"),
			pushType:      request.Header.Get("apns-push-type"),
			priority:      request.Header.Get("apns-priority"),
		})
		writer.Header().Set("apns-id", "00000000-0000-0000-0000-00000000000"+strconv.Itoa(attempt%10))
		switch {
		case strings.HasPrefix(token, "sandbox-") != (environment == "sandbox"):
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = writer.Write([]byte(`{"reason":"BadDeviceToken"}`))
		case strings.HasPrefix(token, "gone-"):
			writer.WriteHeader(http.StatusGone)
			_, _ = writer.Write([]byte(`{"reason":"Unregistered","timestamp":1700000000000}`))
		case strings.HasPrefix(token, "busy-") && attempt == 1:
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(`{"reason":"TooManyRequests"}`))
		case strings.HasPrefix(token, "hang-") && attempt == 1:
			<-provider.release
		case strings.HasPrefix(token, "slow-") && attempt == 1:
			<-provider.releaseSlow
		case strings.HasPrefix(token, "stuck-") && attempt == 1:
			<-provider.releaseStuck
		case strings.HasPrefix(token, "burst-") && attempt == 1:
			<-provider.releaseBurst
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
		attempt := provider.record(token, request, providerRequest{body: body})
		switch {
		case strings.HasPrefix(token, "gone-"):
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`))
		case strings.HasPrefix(token, "invalid-"):
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = writer.Write([]byte(`{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"INVALID_ARGUMENT"}]}}`))
		case strings.HasPrefix(token, "busy-") && attempt == 1:
			writer.Header().Set("retry-after", "1")
			writer.WriteHeader(http.StatusServiceUnavailable)
			_, _ = writer.Write([]byte(`{"error":{"code":503,"status":"UNAVAILABLE"}}`))
		default:
			_, _ = writer.Write([]byte(`{"name":"projects/test-project/messages/` + strconv.Itoa(attempt) + `"}`))
		}
	})

	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
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

func startService(t *testing.T) (string, context.CancelFunc) {
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
	waitFor(t, "the API to start", func() bool {
		response, err := http.Get(api + "/healthz")
		if err == nil {
			_ = response.Body.Close()
		}
		return err == nil
	})
	return api, cancel
}

// TestPush runs the service against real Postgres (PG* env).
func TestPush(t *testing.T) {
	apnsKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	apnsKeyDER, _ := x509.MarshalPKCS8PrivateKey(apnsKey)
	fcmKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	fcmKeyDER, _ := x509.MarshalPKCS8PrivateKey(fcmKey)
	provider := &fakeProvider{requests: map[string][]providerRequest{}, release: make(chan struct{}), releaseSlow: make(chan struct{}), releaseStuck: make(chan struct{}), releaseBurst: make(chan struct{})}
	production := provider.serve(t, &apnsKey.PublicKey, "production")
	sandbox := provider.serve(t, &apnsKey.PublicKey, "sandbox")
	trustedCertificates := x509.NewCertPool()
	trustedCertificates.AddCert(production.Certificate())
	// NOTE: run clones the default transport, so it trusts the fake providers' certificate
	http.DefaultTransport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: trustedCertificates, MinVersion: tls.VersionTLS12}

	serviceAccount, _ := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   "test-project",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: fcmKeyDER})),
		"client_email": "push@test-project.iam.gserviceaccount.com",
		"token_uri":    production.URL + "/token",
	})
	t.Setenv("APNS_PRODUCTION_URL", production.URL)
	t.Setenv("APNS_SANDBOX_URL", sandbox.URL)
	t.Setenv("APNS_KEY_ID", "TESTKEYID1")
	t.Setenv("APNS_TEAM_ID", "TESTTEAMID")
	t.Setenv("APNS_KEY", string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: apnsKeyDER})))
	t.Setenv("FCM_URL", production.URL)
	t.Setenv("FCM_SERVICE_ACCOUNT", string(serviceAccount))

	ctx := context.Background()
	if err := migrate(ctx); err != nil {
		t.Fatal(err)
	}
	database, err := pgxpool.New(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	api, stopService := startService(t)

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
	register := func(token, platform, environment, kind, userID string) {
		t.Helper()
		status, body := call(http.MethodPut, "/devices/"+token+app, map[string]string{
			"platform": platform, "apns_environment": environment, "kind": kind, "app": app, "user_id": userID,
		})
		if status != http.StatusNoContent {
			t.Fatalf("register %s: %d %s", token, status, body)
		}
	}
	send := func(notification map[string]any) string {
		t.Helper()
		notification["app"] = app
		status, body := call(http.MethodPost, "/notifications", notification)
		if status != http.StatusCreated {
			t.Fatalf("send: %d %s", status, body)
		}
		var created struct{ ID string }
		_ = json.Unmarshal([]byte(body), &created)
		return created.ID
	}
	alert := func(recipients map[string]any) map[string]any {
		recipients["push_type"] = "alert"
		recipients["apns"] = map[string]any{"aps": map[string]any{"alert": "hi"}}
		recipients["fcm"] = map[string]any{"notification": map[string]any{"title": "hi"}}
		return recipients
	}
	deviceExists := func(token string) bool {
		var exists bool
		if err := database.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM push_devices WHERE token = $1)`, token+app).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		return exists
	}
	jobsLeft := func(notificationID string) int {
		var count int
		if err := database.QueryRow(ctx, `SELECT count(*) FROM push_jobs WHERE notification_id = $1`, notificationID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	sentTo := func(token string) []providerRequest { return provider.requestsFor(token + app) }

	t.Run("rejects devices without a kind or with the wrong APNs environment", func(t *testing.T) {
		for _, device := range []map[string]string{
			{"platform": "ios", "apns_environment": "production", "app": app, "user_id": "user-0"},
			{"platform": "ios", "kind": "device", "app": app, "user_id": "user-0"},
			{"platform": "android", "apns_environment": "sandbox", "kind": "device", "app": app, "user_id": "user-0"},
		} {
			if status, body := call(http.MethodPut, "/devices/rejected-"+app, device); status != http.StatusBadRequest {
				t.Errorf("register %v: %d %s", device, status, body)
			}
		}
	})

	t.Run("fans out to every device of the users and removes unregistered tokens", func(t *testing.T) {
		register("ios-", "ios", "production", "device", "user-1")
		register("android-", "android", "", "device", "user-1")
		register("live-", "ios", "production", "liveactivity", "user-1")
		register("gone-ios-", "ios", "production", "device", "user-2")
		register("gone-android-", "android", "", "device", "user-2")
		register("invalid-android-", "android", "", "device", "user-2")
		send(alert(map[string]any{"user_ids": []string{"user-1", "user-2"}}))

		waitFor(t, "unregistered tokens to be removed", func() bool {
			return !deviceExists("gone-ios-") && !deviceExists("gone-android-") && !deviceExists("invalid-android-")
		})
		waitFor(t, "delivery", func() bool { return len(sentTo("ios-")) == 1 && len(sentTo("android-")) == 1 })
		apns := sentTo("ios-")[0]
		if apns.environment != "production" || apns.topic != app || apns.pushType != "alert" || apns.priority != "10" ||
			apns.body["aps"].(map[string]any)["alert"] != "hi" {
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

	t.Run("keeps FCM tokens rejected as invalid when no token proved the message valid", func(t *testing.T) {
		register("invalid-only-", "android", "", "device", "user-3")
		id := send(alert(map[string]any{"user_ids": []string{"user-3"}}))
		waitFor(t, "the job to finish", func() bool { return jobsLeft(id) == 0 })
		if len(sentTo("invalid-only-")) != 1 || !deviceExists("invalid-only-") {
			t.Error("removed an FCM token that may have failed because of the message")
		}
	})

	t.Run("sends iOS tokens to the APNs host of their environment", func(t *testing.T) {
		register("sandbox-ios-", "ios", "sandbox", "device", "user-4")
		register("sandbox-registered-as-production-", "ios", "production", "device", "user-4")
		send(alert(map[string]any{"user_ids": []string{"user-4"}}))

		waitFor(t, "the misregistered token to be removed", func() bool { return !deviceExists("sandbox-registered-as-production-") })
		waitFor(t, "sandbox delivery", func() bool { return len(sentTo("sandbox-ios-")) == 1 })
		if request := sentTo("sandbox-ios-")[0]; request.environment != "sandbox" || !deviceExists("sandbox-ios-") {
			t.Errorf("sandbox token went to %s or was removed", request.environment)
		}
		if request := sentTo("sandbox-registered-as-production-")[0]; request.environment != "production" {
			t.Errorf("production token went to %s", request.environment)
		}
	})

	t.Run("sends live activities to the liveactivity topic", func(t *testing.T) {
		send(map[string]any{
			"push_type": "liveactivity", "user_ids": []string{"user-1"},
			"apns": map[string]any{"aps": map[string]any{"event": "update", "timestamp": 1, "content-state": map[string]any{}}},
		})
		waitFor(t, "live activity delivery", func() bool { return len(sentTo("live-")) == 1 })
		if request := sentTo("live-")[0]; request.topic != app+".push-type.liveactivity" || request.pushType != "liveactivity" {
			t.Errorf("unexpected live activity request %+v", request)
		}
	})

	t.Run("retries throttled sends", func(t *testing.T) {
		register("busy-ios-", "ios", "production", "device", "user-5")
		register("busy-android-", "android", "", "device", "user-5")
		send(alert(map[string]any{"user_ids": []string{"user-5"}}))
		waitFor(t, "throttled sends to be retried", func() bool { return len(sentTo("busy-ios-")) == 2 && len(sentTo("busy-android-")) == 2 })
	})

	t.Run("sends scheduled notifications unless cancelled", func(t *testing.T) {
		register("scheduled-", "ios", "production", "device", "user-6")
		register("cancelled-", "ios", "production", "device", "user-7")
		sendAt := time.Now().Add(2 * time.Second).Format(time.RFC3339Nano)
		send(alert(map[string]any{"user_ids": []string{"user-6"}, "send_at": sendAt}))
		cancelledID := send(alert(map[string]any{"user_ids": []string{"user-7"}, "send_at": sendAt}))
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

	t.Run("reuses provider credentials", func(t *testing.T) {
		authorizations := map[string]bool{}
		for _, token := range []string{"ios-", "live-", "busy-ios-", "scheduled-", "sandbox-ios-"} {
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

	t.Run("listens again after losing its connection", func(t *testing.T) {
		var terminated int
		err := database.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE pg_terminate_backend(pid, 5000)) FROM pg_stat_activity
			WHERE datname = current_database() AND query = 'LISTEN push_jobs'`,
		).Scan(&terminated)
		if err != nil || terminated != 1 {
			t.Fatalf("terminated %d connections: %v", terminated, err)
		}
		waitFor(t, "LISTEN to reconnect", func() bool {
			var listening int
			err := database.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN push_jobs'`).Scan(&listening)
			return err == nil && listening == 1
		})
	})

	t.Run("delivers a fan-out exactly once across replicas", func(t *testing.T) {
		startService(t)
		var tokens []string
		for index := range 3 * recipientsPerJob {
			token := fmt.Sprintf("many-%d-", index)
			register(token, "android", "", "device", "user-8")
			tokens = append(tokens, token+app)
		}
		id := send(map[string]any{"push_type": "alert", "tokens": tokens, "fcm": map[string]any{"notification": map[string]any{"title": "hi"}}})
		waitFor(t, "every job to finish", func() bool { return jobsLeft(id) == 0 })
		for _, token := range tokens {
			if requests := provider.requestsFor(token); len(requests) != 1 {
				t.Fatalf("%s got %d requests", token, len(requests))
			}
		}
	})

	t.Run("wakes another replica for a fan-out while every worker of this one is busy", func(t *testing.T) {
		var stuckIDs []string
		for index := range jobWorkers {
			token := fmt.Sprintf("stuck-%d-", index)
			register(token, "ios", "production", "device", "user-11")
			// NOTE: unregistered tokens fill the job, so each stuck send holds a whole worker
			tokens := []string{token + app}
			for filler := range recipientsPerJob - 1 {
				tokens = append(tokens, fmt.Sprintf("unregistered-%d", filler))
			}
			stuckIDs = append(stuckIDs, send(alert(map[string]any{"tokens": tokens})))
		}
		waitFor(t, "every worker to be stuck", func() bool {
			for index := range jobWorkers {
				if len(sentTo(fmt.Sprintf("stuck-%d-", index))) == 0 {
					return false
				}
			}
			return true
		})
		register("woken-user-", "ios", "production", "device", "user-12")
		register("woken-token-", "ios", "production", "device", "user-13")
		startService(t)
		// NOTE: without NOTIFY the new replica takes this on a poll, and the sleep lets the workers it woke go idle
		firstID := send(alert(map[string]any{"user_ids": []string{"user-none"}, "tokens": []string{"none"}}))
		waitFor(t, "the new replica to take the first fan-out", func() bool { return jobsLeft(firstID) == 0 })
		time.Sleep(pollInterval / 5)

		sentAt := time.Now()
		send(alert(map[string]any{"user_ids": []string{"user-12"}, "tokens": []string{"woken-token-" + app}}))
		waitFor(t, "the other replica to deliver", func() bool { return len(sentTo("woken-user-")) == 1 && len(sentTo("woken-token-")) == 1 })
		if elapsed := time.Since(sentAt); elapsed > pollInterval/2 {
			t.Errorf("the other replica delivered after %s instead of being woken", elapsed)
		}
		close(provider.releaseStuck)
		for _, id := range stuckIDs {
			waitFor(t, "the stuck jobs to finish", func() bool { return jobsLeft(id) == 0 })
		}
	})

	t.Run("sends a burst of small notifications at once instead of one per worker", func(t *testing.T) {
		sendAt := time.Now().Add(time.Second).Format(time.RFC3339Nano)
		var ids []string
		for index := range 4 * jobWorkers {
			token := fmt.Sprintf("burst-%d-", index)
			register(token, "ios", "production", "device", "user-14")
			ids = append(ids, send(alert(map[string]any{"tokens": []string{token + app}, "send_at": sendAt})))
		}
		waitFor(t, "every send to be in flight", func() bool {
			for index := range ids {
				if len(sentTo(fmt.Sprintf("burst-%d-", index))) == 0 {
					return false
				}
			}
			return true
		})
		close(provider.releaseBurst)
		for _, id := range ids {
			waitFor(t, "the burst to finish", func() bool { return jobsLeft(id) == 0 })
		}
	})

	t.Run("redelivers a job whose worker died before committing", func(t *testing.T) {
		register("hang-", "ios", "production", "device", "user-9")
		id := send(alert(map[string]any{"user_ids": []string{"user-9"}}))
		waitFor(t, "the first send", func() bool { return len(sentTo("hang-")) == 1 })
		var terminated int
		err := database.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) FROM pg_stat_activity
			WHERE datname = current_database() AND state = 'idle in transaction'`,
		).Scan(&terminated)
		if err != nil || terminated != 1 {
			t.Fatalf("terminated %d connections: %v", terminated, err)
		}
		close(provider.release)
		waitFor(t, "the job to be sent again and finish", func() bool { return len(sentTo("hang-")) == 2 && jobsLeft(id) == 0 })
	})
	t.Run("requeues the sends a stopping replica hasn't started instead of repeating the job", func(t *testing.T) {
		// NOTE: one more unsent device than a job holds
		devices := sendConcurrency + recipientsPerJob + 1
		_, err := database.Exec(ctx, `
			INSERT INTO push_devices (token, platform, kind, app, user_id, apns_environment)
			SELECT 'slow-' || i || $1, 'ios', 'device', $1, 'user-10', 'production' FROM generate_series(1, $2) AS i`,
			app, devices)
		if err != nil {
			t.Fatal(err)
		}
		slowRequests := func() (requests []int) {
			for index := range devices {
				requests = append(requests, len(sentTo(fmt.Sprintf("slow-%d", index+1))))
			}
			return requests
		}
		started := func() (count int) {
			for _, requests := range slowRequests() {
				count += requests
			}
			return count
		}
		id := send(alert(map[string]any{"user_ids": []string{"user-10"}}))
		waitFor(t, "every send slot to be taken", func() bool { return started() == sendConcurrency })

		stopService()
		close(provider.releaseSlow)
		var requeued int
		waitFor(t, "the unstarted sends to be requeued", func() bool {
			err := database.QueryRow(ctx, `SELECT coalesce(sum(jsonb_array_length(job->'tokens')), 0) FROM push_jobs WHERE notification_id = $1`, id).Scan(&requeued)
			return err == nil && requeued > 0
		})
		if requeued != devices-sendConcurrency || started() != sendConcurrency {
			t.Fatalf("requeued %d tokens after starting %d sends", requeued, started())
		}

		startService(t)
		waitFor(t, "the requeued job to finish", func() bool { return jobsLeft(id) == 0 })
		for index, requests := range slowRequests() {
			if requests != 1 {
				t.Fatalf("slow-%d got %d requests", index+1, requests)
			}
		}
	})
}
