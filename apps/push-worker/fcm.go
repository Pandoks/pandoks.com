package main

import (
	"context"
	"fmt"
	"time"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/messaging"
)

type FCMClient struct {
	client *messaging.Client
}

func NewFCMClient(ctx context.Context, projectID string) (*FCMClient, error) {
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID})
	if err != nil {
		return nil, fmt.Errorf("initialize Firebase: %w", err)
	}
	client, err := app.Messaging(ctx)
	if err != nil {
		return nil, fmt.Errorf("initialize FCM: %w", err)
	}
	return &FCMClient{client: client}, nil
}

func (client *FCMClient) Send(ctx context.Context, job FCMJob) error {
	if _, err := client.client.Send(ctx, toFCMMessage(job)); err != nil {
		sendError := fmt.Errorf("send FCM message: %w", err)
		if messaging.IsUnregistered(err) {
			return newPermanentError(sendError)
		}
		return sendError
	}
	return nil
}

func toFCMMessage(job FCMJob) *messaging.Message {
	message := &messaging.Message{
		Fid:   job.FID,
		Token: job.Token,
		Data:  job.Data,
	}
	if job.Notification != nil {
		message.Notification = &messaging.Notification{
			Title: job.Notification.Title,
			Body:  job.Notification.Body,
		}
	}
	if job.Android != nil {
		message.Android = &messaging.AndroidConfig{
			Priority:    job.Android.Priority,
			CollapseKey: job.Android.CollapseKey,
		}
		if job.Android.TTLSeconds != 0 {
			ttl := time.Duration(job.Android.TTLSeconds) * time.Second
			message.Android.TTL = &ttl
		}
	}
	return message
}
