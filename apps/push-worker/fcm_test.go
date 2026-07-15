package main

import (
	"testing"
	"time"
)

func TestFCMMessageUsesInstallationID(t *testing.T) {
	t.Parallel()

	message := toFCMMessage(FCMJob{
		FID: "installation-id",
		Notification: &Notification{
			Title: "Focus",
			Body:  "Five minutes left",
		},
		Data: map[string]string{"sessionId": "42"},
		Android: &AndroidOptions{
			Priority:    "high",
			CollapseKey: "focus-42",
			TTLSeconds:  60,
		},
	})

	if message.Fid != "installation-id" || message.Token != "" {
		t.Fatalf("targets = fid:%q token:%q", message.Fid, message.Token)
	}
	if message.Notification.Title != "Focus" || message.Notification.Body != "Five minutes left" {
		t.Fatalf("notification = %#v", message.Notification)
	}
	if message.Data["sessionId"] != "42" {
		t.Fatalf("data = %#v", message.Data)
	}
	if message.Android.Priority != "high" || message.Android.CollapseKey != "focus-42" {
		t.Fatalf("android = %#v", message.Android)
	}
	if message.Android.TTL == nil || *message.Android.TTL != time.Minute {
		t.Fatalf("ttl = %v", message.Android.TTL)
	}
}

func TestFCMMessageSupportsLegacyRegistrationToken(t *testing.T) {
	t.Parallel()

	message := toFCMMessage(FCMJob{Token: "registration-token"})
	if message.Token != "registration-token" || message.Fid != "" {
		t.Fatalf("targets = fid:%q token:%q", message.Fid, message.Token)
	}
	if message.Notification != nil || message.Android != nil {
		t.Fatalf("unexpected optional config: %#v", message)
	}
}
