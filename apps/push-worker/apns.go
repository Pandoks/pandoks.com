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
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const providerTokenLifetime = 50 * time.Minute

type APNsConfig struct {
	TeamID     string
	KeyID      string
	PrivateKey []byte
	Endpoint   string
}

type APNsClient struct {
	teamID     string
	keyID      string
	privateKey *ecdsa.PrivateKey
	endpoint   string
	httpClient *http.Client
	now        func() time.Time

	mu          sync.Mutex
	token       string
	tokenIssued time.Time
}

func NewAPNsClient(config APNsConfig) (*APNsClient, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ForceAttemptHTTP2 = true
	transport.MaxIdleConnsPerHost = 100

	return newAPNsClient(config, &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}, time.Now)
}

func newAPNsClient(
	config APNsConfig,
	httpClient *http.Client,
	now func() time.Time,
) (*APNsClient, error) {
	if config.TeamID == "" || config.KeyID == "" || config.Endpoint == "" {
		return nil, errors.New("APNs team ID, key ID, and endpoint are required")
	}

	block, _ := pem.Decode(config.PrivateKey)
	if block == nil {
		return nil, errors.New("decode APNs private key PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse APNs private key: %w", err)
	}
	privateKey, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("APNs private key is not ECDSA")
	}

	return &APNsClient{
		teamID:     config.TeamID,
		keyID:      config.KeyID,
		privateKey: privateKey,
		endpoint:   strings.TrimRight(config.Endpoint, "/"),
		httpClient: httpClient,
		now:        now,
	}, nil
}

func (client *APNsClient) Send(ctx context.Context, job APNsJob) error {
	providerToken, err := client.providerToken()
	if err != nil {
		return err
	}

	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		client.endpoint+"/3/device/"+url.PathEscape(job.Token),
		bytes.NewReader(job.Payload),
	)
	if err != nil {
		return fmt.Errorf("create APNs request: %w", err)
	}
	request.Header.Set("Authorization", "bearer "+providerToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("apns-topic", job.Topic)
	request.Header.Set("apns-push-type", job.PushType)
	request.Header.Set("apns-priority", strconv.Itoa(job.Priority))
	if job.Expiration != 0 {
		request.Header.Set("apns-expiration", strconv.FormatInt(job.Expiration, 10))
	}
	if job.CollapseID != "" {
		request.Header.Set("apns-collapse-id", job.CollapseID)
	}

	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("send APNs request: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode == http.StatusOK {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}

	var rejection struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&rejection)
	rejectionError := fmt.Errorf(
		"apns rejected notification: %d %s",
		response.StatusCode,
		rejection.Reason,
	)
	switch rejection.Reason {
	case "BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered":
		return newPermanentError(rejectionError)
	default:
		return rejectionError
	}
}

func (client *APNsClient) providerToken() (string, error) {
	client.mu.Lock()
	defer client.mu.Unlock()

	now := client.now()
	if client.token != "" && now.Sub(client.tokenIssued) < providerTokenLifetime {
		return client.token, nil
	}

	header, err := encodeJWTPart(map[string]any{
		"alg": "ES256",
		"kid": client.keyID,
	})
	if err != nil {
		return "", err
	}
	claims, err := encodeJWTPart(map[string]any{
		"iss": client.teamID,
		"iat": now.Unix(),
	})
	if err != nil {
		return "", err
	}

	signingInput := header + "." + claims
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, client.privateKey, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign APNs provider token: %w", err)
	}
	signature := joseSignature(r, s, client.privateKey.Curve.Params().BitSize)

	client.token = signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
	client.tokenIssued = now
	return client.token, nil
}

func encodeJWTPart(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode APNs provider token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func joseSignature(r, s *big.Int, bitSize int) []byte {
	size := (bitSize + 7) / 8
	signature := make([]byte, size*2)
	r.FillBytes(signature[:size])
	s.FillBytes(signature[size:])
	return signature
}
