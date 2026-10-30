package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

type fcmClient struct {
	httpClient *http.Client
	sendURL    string
}

func newFCMClient(transport http.RoundTripper, fcmURL string, serviceAccount []byte) (*fcmClient, error) {
	// NOTE: the token source fetches with the context's client, otherwise http.DefaultClient with no timeout
	tokenContext := context.WithValue(context.Background(), oauth2.HTTPClient, &http.Client{Transport: transport, Timeout: 30 * time.Second})
	credentials, err := google.CredentialsFromJSONWithType(tokenContext, serviceAccount, google.ServiceAccount, "https://www.googleapis.com/auth/firebase.messaging")
	if err != nil {
		return nil, fmt.Errorf("parse FCM_SERVICE_ACCOUNT: %w", err)
	}
	return &fcmClient{
		// NOTE: the token source caches the OAuth2 access token until shortly before it expires
		httpClient: &http.Client{
			Transport: &oauth2.Transport{Source: credentials.TokenSource, Base: transport},
			Timeout:   30 * time.Second,
		},
		sendURL: fcmURL + "/v1/projects/" + credentials.ProjectID + "/messages:send",
	}, nil
}

func (client *fcmClient) send(ctx context.Context, device device, job notification) result {
	var fields map[string]any
	if err := json.Unmarshal(job.FCM, &fields); err != nil {
		return result{outcome: failed, reason: err.Error()}
	}
	fields["token"] = device.Token
	body, err := json.Marshal(map[string]any{"message": fields})
	if err != nil {
		return result{outcome: failed, reason: err.Error()}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.sendURL, bytes.NewReader(body))
	if err != nil {
		return result{outcome: failed, reason: err.Error()}
	}
	request.Header.Set("content-type", "application/json")

	response, err := client.httpClient.Do(request)
	if err != nil {
		return result{outcome: retryable, reason: err.Error()}
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusOK {
		return result{outcome: delivered}
	}

	var rejection struct {
		Error struct {
			Status  string `json:"status"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.NewDecoder(response.Body).Decode(&rejection)
	reason := fmt.Sprintf("fcm %d %s", response.StatusCode, rejection.Error.Status)
	retryAfterSeconds, _ := strconv.Atoi(response.Header.Get("retry-after"))
	retryAfter := time.Duration(retryAfterSeconds) * time.Second
	for _, detail := range rejection.Error.Details {
		switch detail.ErrorCode {
		case "UNREGISTERED":
			return result{outcome: unregistered, reason: reason}
		case "INVALID_ARGUMENT":
			return result{outcome: invalidArgument, reason: reason}
		}
	}
	switch {
	case response.StatusCode == http.StatusTooManyRequests:
		// FCM asks for exponential backoff starting at one minute after QUOTA_EXCEEDED
		return result{outcome: retryable, reason: reason, retryAfter: max(retryAfter, time.Minute)}
	case response.StatusCode >= http.StatusInternalServerError:
		return result{outcome: retryable, reason: reason, retryAfter: retryAfter}
	default:
		return result{outcome: failed, reason: reason}
	}
}
