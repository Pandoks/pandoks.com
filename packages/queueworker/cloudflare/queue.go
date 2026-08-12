package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"queueworker"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	defaultBaseURL  = "https://api.cloudflare.com/client/v4"
	maxBatchSize    = 100
	maxBatchBytes   = 256_000
	maxMessageBytes = 128_000
	maxErrorBytes   = 8 << 10
)

type Options struct {
	BaseURL           string
	AccountID         string
	QueueID           string
	APIToken          string
	PullBatchSize     int
	VisibilityTimeout time.Duration
	EmptyPollDelay    time.Duration
	RetryDelay        time.Duration
	PublishBatchSize  int
	HTTPClient        *http.Client
}

func DefaultOptions(accountID, queueID, apiToken string) Options {
	return Options{
		BaseURL:           defaultBaseURL,
		AccountID:         accountID,
		QueueID:           queueID,
		APIToken:          apiToken,
		PullBatchSize:     maxBatchSize,
		VisibilityTimeout: 60 * time.Second,
		EmptyPollDelay:    time.Second,
		PublishBatchSize:  maxBatchSize,
		HTTPClient:        &http.Client{Timeout: 30 * time.Second},
	}
}

func New(options Options) (*Queue, error) {
	if options.BaseURL == "" || options.AccountID == "" ||
		options.QueueID == "" || options.APIToken == "" {
		return nil, errors.New(
			"cloudflare base URL, account ID, queue ID, and API token are required",
		)
	}
	baseURL, err := url.Parse(strings.TrimRight(options.BaseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("parse Cloudflare base URL: %w", err)
	}
	if baseURL.Scheme != "http" && baseURL.Scheme != "https" {
		return nil, errors.New("cloudflare base URL must use http or https")
	}
	if options.PullBatchSize < 1 || options.PullBatchSize > maxBatchSize {
		return nil, errors.New("cloudflare pull batch size must be between 1 and 100")
	}
	if options.PublishBatchSize < 1 || options.PublishBatchSize > maxBatchSize {
		return nil, errors.New("cloudflare publish batch size must be between 1 and 100")
	}
	if options.VisibilityTimeout <= 0 || options.VisibilityTimeout > 12*time.Hour ||
		options.VisibilityTimeout%time.Millisecond != 0 {
		return nil, errors.New(
			"cloudflare visibility timeout must be between 1ms and 12 hours",
		)
	}
	if options.EmptyPollDelay < 0 {
		return nil, errors.New("cloudflare empty poll delay cannot be negative")
	}
	if options.RetryDelay < 0 || options.RetryDelay > 24*time.Hour ||
		options.RetryDelay%time.Second != 0 {
		return nil, errors.New(
			"cloudflare retry delay must be whole seconds between 0 and 24 hours",
		)
	}
	if options.HTTPClient == nil {
		return nil, errors.New("cloudflare HTTP client is required")
	}
	return &Queue{options: options, baseURL: baseURL}, nil
}

type Queue struct {
	options Options
	baseURL *url.URL
}

type delivery struct {
	queue    *Queue
	id       string
	body     []byte
	leaseID  string
	attempts int
}

func (message *delivery) ID() string   { return message.id }
func (message *delivery) Body() []byte { return message.body }
func (message *delivery) Attempts() int {
	return message.attempts
}

type envelope[T any] struct {
	Success  bool       `json:"success"`
	Errors   []apiError `json:"errors"`
	Messages []string   `json:"messages"`
	Result   T          `json:"result"`
}

type apiError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type pullResult struct {
	Messages []struct {
		ID       string `json:"id"`
		Body     string `json:"body"`
		LeaseID  string `json:"lease_id"`
		Attempts int    `json:"attempts"`
	} `json:"messages"`
}

func (queue *Queue) Receive(ctx context.Context) ([]queueworker.Message, error) {
	request := struct {
		BatchSize           int   `json:"batch_size"`
		VisibilityTimeoutMS int64 `json:"visibility_timeout_ms"`
	}{queue.options.PullBatchSize, queue.options.VisibilityTimeout.Milliseconds()}
	var response envelope[pullResult]
	if err := queue.post(ctx, "pull", request, &response); err != nil {
		return nil, fmt.Errorf("pull Cloudflare queue messages: %w", err)
	}
	messages := make([]queueworker.Message, 0, len(response.Result.Messages))
	for _, message := range response.Result.Messages {
		if message.ID == "" || message.LeaseID == "" {
			return nil, errors.New(
				"pull Cloudflare queue message: response omitted ID or lease ID",
			)
		}
		attempts := message.Attempts
		if attempts < 1 {
			attempts = 1
		}
		messages = append(messages, &delivery{
			queue:    queue,
			id:       message.ID,
			body:     []byte(message.Body),
			leaseID:  message.LeaseID,
			attempts: attempts,
		})
	}
	if len(messages) == 0 && queue.options.EmptyPollDelay > 0 {
		timer := time.NewTimer(queue.options.EmptyPollDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return messages, nil
}

type lease struct {
	LeaseID      string `json:"lease_id"`
	DelaySeconds int64  `json:"delay_seconds,omitempty"`
}

func (queue *Queue) Settle(ctx context.Context, settlement queueworker.Settlement) error {
	acks, err := queue.leases(settlement.Acknowledge, false)
	if err != nil {
		return err
	}
	retries, err := queue.leases(settlement.Retry, true)
	if err != nil {
		return err
	}
	if len(acks) == 0 && len(retries) == 0 {
		return nil
	}
	request := struct {
		Acks    []lease `json:"acks"`
		Retries []lease `json:"retries"`
	}{acks, retries}
	var response envelope[struct {
		AckCount   int               `json:"ackCount"`
		RetryCount int               `json:"retryCount"`
		Warnings   map[string]string `json:"warnings"`
	}]
	if err := queue.post(ctx, "ack", request, &response); err != nil {
		return fmt.Errorf("settle Cloudflare messages: %w", err)
	}
	if response.Result.AckCount != len(acks) ||
		response.Result.RetryCount != len(retries) ||
		len(response.Result.Warnings) != 0 {
		return fmt.Errorf(
			"settle Cloudflare messages: acknowledged %d of %d, retried %d of %d, warnings %d",
			response.Result.AckCount,
			len(acks),
			response.Result.RetryCount,
			len(retries),
			len(response.Result.Warnings),
		)
	}
	return nil
}

func (queue *Queue) leases(messages []queueworker.Message, retry bool) ([]lease, error) {
	result := make([]lease, 0, len(messages))
	for _, message := range messages {
		item, ok := message.(*delivery)
		if !ok || item.queue != queue {
			return nil, fmt.Errorf(
				"settle Cloudflare message %q: message belongs to another queue",
				message.ID(),
			)
		}
		value := lease{LeaseID: item.leaseID}
		if retry {
			value.DelaySeconds = int64(queue.options.RetryDelay / time.Second)
		}
		result = append(result, value)
	}
	return result, nil
}

func (queue *Queue) Publish(ctx context.Context, messages []queueworker.Publication) error {
	for start := 0; start < len(messages); {
		end := min(start+queue.options.PublishBatchSize, len(messages))
		for end > start {
			encoded, err := encodeBatch(messages[start:end])
			if err != nil {
				return err
			}
			if len(encoded) <= maxBatchBytes || end == start+1 {
				if len(encoded) > maxBatchBytes {
					return fmt.Errorf(
						"publish Cloudflare message %d: encoded request exceeds 256KB",
						start,
					)
				}
				var response envelope[json.RawMessage]
				if err := queue.postBytes(ctx, "batch", encoded, &response); err != nil {
					return fmt.Errorf(
						"publish Cloudflare messages %d-%d: %w",
						start,
						end-1,
						err,
					)
				}
				start = end
				break
			}
			end--
		}
	}
	return nil
}

func encodeBatch(messages []queueworker.Publication) ([]byte, error) {
	type outbound struct {
		Body        string `json:"body"`
		ContentType string `json:"content_type"`
	}
	request := struct {
		Messages []outbound `json:"messages"`
	}{Messages: make([]outbound, 0, len(messages))}
	for index, message := range messages {
		if !utf8.Valid(message.Body) {
			return nil, fmt.Errorf(
				"publish Cloudflare message %d: body is not valid UTF-8",
				index,
			)
		}
		if len(message.Body) > maxMessageBytes {
			return nil, fmt.Errorf(
				"publish Cloudflare message %d: body exceeds 128KB",
				index,
			)
		}
		request.Messages = append(request.Messages, outbound{
			Body:        string(message.Body),
			ContentType: "text",
		})
	}
	return json.Marshal(request)
}

func (queue *Queue) post(ctx context.Context, action string, requestBody, responseBody any) error {
	body, err := json.Marshal(requestBody)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	return queue.postBytes(ctx, action, body, responseBody)
}

func (queue *Queue) postBytes(ctx context.Context, action string, body []byte, responseBody any) error {
	endpoint := *queue.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") +
		"/accounts/" + url.PathEscape(queue.options.AccountID) +
		"/queues/" + url.PathEscape(queue.options.QueueID) +
		"/messages/" + action
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint.String(),
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+queue.options.APIToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := queue.options.HTTPClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, readErr := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes))
		if readErr != nil {
			return fmt.Errorf(
				"HTTP %d (read error body: %v)",
				response.StatusCode,
				readErr,
			)
		}
		return fmt.Errorf(
			"HTTP %d: %s",
			response.StatusCode,
			strings.TrimSpace(string(message)),
		)
	}
	if err := json.NewDecoder(response.Body).Decode(responseBody); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	switch typed := responseBody.(type) {
	case *envelope[pullResult]:
		if !typed.Success {
			return cloudflareErrors(typed.Errors, typed.Messages)
		}
	case *envelope[struct {
		AckCount   int               `json:"ackCount"`
		RetryCount int               `json:"retryCount"`
		Warnings   map[string]string `json:"warnings"`
	}]:
		if !typed.Success {
			return cloudflareErrors(typed.Errors, typed.Messages)
		}
	case *envelope[json.RawMessage]:
		if !typed.Success {
			return cloudflareErrors(typed.Errors, typed.Messages)
		}
	}
	return nil
}

func cloudflareErrors(apiErrors []apiError, messages []string) error {
	parts := append([]string(nil), messages...)
	for _, item := range apiErrors {
		parts = append(parts, fmt.Sprintf("%d: %s", item.Code, item.Message))
	}
	if len(parts) == 0 {
		return errors.New("cloudflare API returned success=false")
	}
	return errors.New(strings.Join(parts, "; "))
}

func (*Queue) Close() error { return nil }
