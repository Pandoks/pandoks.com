package main

import (
	"strings"
	"testing"
)

func TestDecodeJob(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		body     string
		provider Provider
	}{
		{
			name: "APNs Live Activity",
			body: `{
                "id":"activity-42",
                "provider":"apns",
                "apns":{
                  "token":"device-token",
                  "topic":"com.pandoks.mobile-template.push-type.liveactivity",
                  "pushType":"liveactivity",
                  "priority":10,
                  "collapseId":"focus-42",
                  "payload":{"aps":{"event":"update","content-state":{"name":"Focus","props":"{}"}}}
                }
              }`,
			provider: ProviderAPNs,
		},
		{
			name: "FCM installation",
			body: `{
                "id":"android-42",
                "provider":"fcm",
                "fcm":{
                  "fid":"installation-id",
                  "notification":{"title":"Focus","body":"Five minutes left"},
                  "data":{"sessionId":"42"},
                  "android":{"priority":"high","collapseKey":"focus-42","ttlSeconds":60}
                }
              }`,
			provider: ProviderFCM,
		},
		{
			name: "legacy FCM registration token",
			body: `{
                "id":"legacy-42",
                "provider":"fcm",
                "fcm":{"token":"registration-token","data":{"sessionId":"42"}}
              }`,
			provider: ProviderFCM,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			job, err := DecodeJob([]byte(test.body))
			if err != nil {
				t.Fatal(err)
			}
			if job.Provider != test.provider {
				t.Fatalf("provider = %q, want %q", job.Provider, test.provider)
			}
		})
	}
}

func TestDecodeJobRejectsInvalidJobs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		body string
		want string
	}{
		{name: "empty id", body: `{"provider":"fcm","fcm":{"fid":"x"}}`, want: "id"},
		{name: "unknown provider", body: `{"id":"1","provider":"web"}`, want: "provider"},
		{
			name: "APNs payload missing",
			body: `{"id":"1","provider":"apns"}`,
			want: "apns",
		},
		{
			name: "both provider payloads",
			body: `{"id":"1","provider":"apns","apns":{"token":"x","topic":"x","pushType":"alert","priority":10,"payload":{"aps":{}}},"fcm":{"fid":"x"}}`,
			want: "exactly one",
		},
		{
			name: "invalid APNs priority",
			body: `{"id":"1","provider":"apns","apns":{"token":"x","topic":"x","pushType":"alert","priority":7,"payload":{"aps":{}}}}`,
			want: "priority",
		},
		{
			name: "both FCM targets",
			body: `{"id":"1","provider":"fcm","fcm":{"fid":"x","token":"y"}}`,
			want: "exactly one",
		},
		{
			name: "invalid FCM priority",
			body: `{"id":"1","provider":"fcm","fcm":{"fid":"x","android":{"priority":"urgent"}}}`,
			want: "priority",
		},
		{
			name: "negative FCM TTL",
			body: `{"id":"1","provider":"fcm","fcm":{"fid":"x","android":{"ttlSeconds":-1}}}`,
			want: "ttlSeconds",
		},
		{
			name: "FCM content missing",
			body: `{"id":"1","provider":"fcm","fcm":{"fid":"x"}}`,
			want: "notification or data",
		},
		{
			name: "unknown field",
			body: `{"id":"1","provider":"fcm","fcm":{"fid":"x"},"extra":true}`,
			want: "unknown field",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			_, err := DecodeJob([]byte(test.body))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want it to contain %q", err, test.want)
			}
		})
	}
}
