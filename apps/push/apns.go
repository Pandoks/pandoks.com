package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Apple rejects provider tokens older than 60 minutes and refreshes more often than every 20.
const providerTokenLifetime = 50 * time.Minute

type apnsClient struct {
	httpClient *http.Client
	url        string
	keyID      string
	teamID     string
	key        *ecdsa.PrivateKey

	mutex         sync.Mutex
	token         string
	tokenIssuedAt time.Time
}

func newAPNsClient(transport http.RoundTripper, apnsURL, keyID, teamID string, keyPEM []byte) (*apnsClient, error) {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, errors.New("APNS_KEY is not a PEM encoded .p8 key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse APNS_KEY: %w", err)
	}
	return &apnsClient{
		httpClient: &http.Client{Transport: transport, Timeout: 30 * time.Second},
		url:        apnsURL,
		keyID:      keyID,
		teamID:     teamID,
		key:        key.(*ecdsa.PrivateKey),
	}, nil
}

func (client *apnsClient) providerToken() (string, error) {
	client.mutex.Lock()
	defer client.mutex.Unlock()
	if time.Since(client.tokenIssuedAt) < providerTokenLifetime {
		return client.token, nil
	}

	issuedAt := time.Now()
	header, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": client.keyID})
	claims, _ := json.Marshal(map[string]any{"iss": client.teamID, "iat": issuedAt.Unix()})
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signingInput))
	signatureR, signatureS, err := ecdsa.Sign(rand.Reader, client.key, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign APNs provider token: %w", err)
	}
	signature := make([]byte, 64)
	signatureR.FillBytes(signature[:32])
	signatureS.FillBytes(signature[32:])

	client.token = signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
	client.tokenIssuedAt = issuedAt
	return client.token, nil
}

func (client *apnsClient) send(ctx context.Context, deviceToken, topic, pushType, priority string, payload []byte) result {
	providerToken, err := client.providerToken()
	if err != nil {
		return result{outcome: failed, reason: err.Error()}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.url+"/3/device/"+url.PathEscape(deviceToken), bytes.NewReader(payload))
	if err != nil {
		return result{outcome: failed, reason: err.Error()}
	}
	request.Header.Set("authorization", "bearer "+providerToken)
	request.Header.Set("apns-topic", topic)
	request.Header.Set("apns-push-type", pushType)
	request.Header.Set("apns-priority", priority)

	response, err := client.httpClient.Do(request)
	if err != nil {
		return result{outcome: retryable, reason: err.Error()}
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusOK {
		return result{outcome: delivered}
	}

	var rejection struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(response.Body).Decode(&rejection)
	reason := fmt.Sprintf("apns %d %s", response.StatusCode, rejection.Reason)
	switch {
	case response.StatusCode == http.StatusGone || rejection.Reason == "BadDeviceToken":
		return result{outcome: unregistered, reason: reason}
	case response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError:
		return result{outcome: retryable, reason: reason}
	default:
		return result{outcome: failed, reason: reason}
	}
}
