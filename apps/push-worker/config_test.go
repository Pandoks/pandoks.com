package main

import (
	"errors"
	"strings"
	"testing"
)

func TestLoadConfig(t *testing.T) {
	t.Parallel()

	environment := map[string]string{
		"SQS_QUEUE_URL":         "https://sqs.example/queue",
		"FIREBASE_PROJECT_ID":   "firebase-project",
		"APNS_TEAM_ID":          "TEAMID1234",
		"APNS_KEY_ID":           "KEYID12345",
		"APNS_PRIVATE_KEY_PATH": "/secrets/AuthKey.p8",
		"STAGE":                 "prod",
	}
	config, err := loadConfig(
		func(name string) string { return environment[name] },
		func(path string) ([]byte, error) {
			if path != "/secrets/AuthKey.p8" {
				t.Fatalf("path = %q", path)
			}
			return []byte("private-key"), nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if config.APNs.Endpoint != "https://api.push.apple.com" {
		t.Fatalf("endpoint = %q", config.APNs.Endpoint)
	}
	if string(config.APNs.PrivateKey) != "private-key" {
		t.Fatal("private key was not loaded")
	}
}

func TestLoadConfigUsesAPNsSandboxOutsideProduction(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	environment["STAGE"] = "dev"
	config, err := loadConfig(
		func(name string) string { return environment[name] },
		func(string) ([]byte, error) { return []byte("private-key"), nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if config.APNs.Endpoint != "https://api.sandbox.push.apple.com" {
		t.Fatalf("endpoint = %q", config.APNs.Endpoint)
	}
}

func TestLoadConfigRejectsMissingValues(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	delete(environment, "FIREBASE_PROJECT_ID")
	_, err := loadConfig(
		func(name string) string { return environment[name] },
		func(string) ([]byte, error) { return []byte("private-key"), nil },
	)
	if err == nil || !strings.Contains(err.Error(), "FIREBASE_PROJECT_ID") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadConfigReturnsPrivateKeyReadError(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	_, err := loadConfig(
		func(name string) string { return environment[name] },
		func(string) ([]byte, error) { return nil, errors.New("not found") },
	)
	if err == nil || !strings.Contains(err.Error(), "APNs private key") {
		t.Fatalf("error = %v", err)
	}
}

func validEnvironment() map[string]string {
	return map[string]string{
		"SQS_QUEUE_URL":         "https://sqs.example/queue",
		"FIREBASE_PROJECT_ID":   "firebase-project",
		"APNS_TEAM_ID":          "TEAMID1234",
		"APNS_KEY_ID":           "KEYID12345",
		"APNS_PRIVATE_KEY_PATH": "/secrets/AuthKey.p8",
		"STAGE":                 "dev",
	}
}
