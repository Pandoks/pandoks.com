package main

import (
	"errors"
	"fmt"
	"os"
)

const (
	apnsProductionEndpoint = "https://api.push.apple.com"
	apnsSandboxEndpoint    = "https://api.sandbox.push.apple.com"
)

type Config struct {
	QueueURL          string
	FirebaseProjectID string
	APNs              APNsConfig
}

func LoadConfig() (Config, error) {
	return loadConfig(os.Getenv, os.ReadFile)
}

func loadConfig(
	getenv func(string) string,
	readFile func(string) ([]byte, error),
) (Config, error) {
	queueURL := getenv("SQS_QUEUE_URL")
	firebaseProjectID := getenv("FIREBASE_PROJECT_ID")
	teamID := getenv("APNS_TEAM_ID")
	keyID := getenv("APNS_KEY_ID")
	privateKeyPath := getenv("APNS_PRIVATE_KEY_PATH")
	stage := getenv("STAGE")

	required := map[string]string{
		"SQS_QUEUE_URL":         queueURL,
		"FIREBASE_PROJECT_ID":   firebaseProjectID,
		"APNS_TEAM_ID":          teamID,
		"APNS_KEY_ID":           keyID,
		"APNS_PRIVATE_KEY_PATH": privateKeyPath,
		"STAGE":                 stage,
	}
	for name, value := range required {
		if value == "" {
			return Config{}, fmt.Errorf("%s is required", name)
		}
	}

	privateKey, err := readFile(privateKeyPath)
	if err != nil {
		return Config{}, fmt.Errorf("read APNs private key: %w", err)
	}
	if len(privateKey) == 0 {
		return Config{}, errors.New("APNs private key is empty")
	}

	endpoint := getenv("APNS_ENDPOINT")
	if endpoint == "" {
		endpoint = apnsSandboxEndpoint
		if stage == "prod" || stage == "production" {
			endpoint = apnsProductionEndpoint
		}
	}

	return Config{
		QueueURL:          queueURL,
		FirebaseProjectID: firebaseProjectID,
		APNs: APNsConfig{
			TeamID:     teamID,
			KeyID:      keyID,
			PrivateKey: privateKey,
			Endpoint:   endpoint,
		},
	}, nil
}
