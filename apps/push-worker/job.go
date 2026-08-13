package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

type Provider string

const (
	ProviderAPNs Provider = "apns"
	ProviderFCM  Provider = "fcm"
)

type Job struct {
	ID       string   `json:"id"`
	Provider Provider `json:"provider"`
	APNs     *APNsJob `json:"apns,omitempty"`
	FCM      *FCMJob  `json:"fcm,omitempty"`
}

type APNsJob struct {
	Token      string          `json:"token"`
	Topic      string          `json:"topic"`
	PushType   string          `json:"pushType"`
	Priority   int             `json:"priority"`
	Expiration int64           `json:"expiration,omitempty"`
	CollapseID string          `json:"collapseId,omitempty"`
	Payload    json.RawMessage `json:"payload"`
}

type FCMJob struct {
	FID          string            `json:"fid,omitempty"`
	Token        string            `json:"token,omitempty"`
	Notification *Notification     `json:"notification,omitempty"`
	Data         map[string]string `json:"data,omitempty"`
	Android      *AndroidOptions   `json:"android,omitempty"`
}

type Notification struct {
	Title string `json:"title,omitempty"`
	Body  string `json:"body,omitempty"`
}

type AndroidOptions struct {
	Priority    string `json:"priority,omitempty"`
	CollapseKey string `json:"collapseKey,omitempty"`
	TTLSeconds  int64  `json:"ttlSeconds,omitempty"`
}

func DecodeJob(body []byte) (Job, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()

	var job Job
	if err := decoder.Decode(&job); err != nil {
		return Job{}, fmt.Errorf("decode job: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Job{}, errors.New("decode job: trailing JSON")
	}
	if err := job.Validate(); err != nil {
		return Job{}, err
	}
	return job, nil
}

func (job Job) Validate() error {
	if job.ID == "" {
		return errors.New("id is required")
	}

	switch job.Provider {
	case ProviderAPNs:
		if job.APNs == nil {
			return errors.New("apns payload is required")
		}
		if job.FCM != nil {
			return errors.New("exactly one provider payload is required")
		}
		return job.APNs.validate()
	case ProviderFCM:
		if job.FCM == nil {
			return errors.New("fcm payload is required")
		}
		if job.APNs != nil {
			return errors.New("exactly one provider payload is required")
		}
		return job.FCM.validate()
	default:
		return fmt.Errorf("provider %q is not supported", job.Provider)
	}
}

func (job APNsJob) validate() error {
	if job.Token == "" {
		return errors.New("apns token is required")
	}
	if job.Topic == "" {
		return errors.New("apns topic is required")
	}
	if job.PushType == "" {
		return errors.New("apns pushType is required")
	}
	if job.Priority != 5 && job.Priority != 10 {
		return errors.New("apns priority must be 5 or 10")
	}
	if len(job.Payload) == 0 || bytes.TrimSpace(job.Payload)[0] != '{' {
		return errors.New("apns payload must be a JSON object")
	}
	return nil
}

func (job FCMJob) validate() error {
	if (job.FID == "") == (job.Token == "") {
		return errors.New("fcm requires exactly one fid or token")
	}
	if job.Android != nil {
		if job.Android.Priority != "" &&
			job.Android.Priority != "normal" &&
			job.Android.Priority != "high" {
			return errors.New("fcm android priority must be normal or high")
		}
		if job.Android.TTLSeconds < 0 {
			return errors.New("fcm android ttlSeconds cannot be negative")
		}
	}
	if job.Notification == nil && len(job.Data) == 0 {
		return errors.New("fcm notification or data is required")
	}
	return nil
}
