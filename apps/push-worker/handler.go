package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"queueworker"
)

type permanentError struct {
	err error
}

func newPermanentError(err error) error {
	return permanentError{err: err}
}

func (err permanentError) Error() string {
	return err.err.Error()
}

func (err permanentError) Unwrap() error {
	return err.err
}

func isPermanent(err error) bool {
	var target permanentError
	return errors.As(err, &target)
}

type JobSender interface {
	Send(context.Context, Job) error
}

type APNsSender interface {
	Send(context.Context, APNsJob) error
}

type FCMSender interface {
	Send(context.Context, FCMJob) error
}

type Dispatcher struct {
	APNs APNsSender
	FCM  FCMSender
}

func (dispatcher Dispatcher) Send(ctx context.Context, job Job) error {
	switch job.Provider {
	case ProviderAPNs:
		return dispatcher.APNs.Send(ctx, *job.APNs)
	case ProviderFCM:
		return dispatcher.FCM.Send(ctx, *job.FCM)
	default:
		return fmt.Errorf("provider %q is not supported", job.Provider)
	}
}

type PushHandler struct {
	sender JobSender
	logger *slog.Logger
}

func NewPushHandler(sender JobSender, logger *slog.Logger) *PushHandler {
	return &PushHandler{sender: sender, logger: logger}
}

func (handler *PushHandler) Handle(ctx context.Context, body []byte) error {
	job, err := DecodeJob(body)
	if err != nil {
		handler.logger.Warn("push rejected permanently", "error", err)
		return queueworker.Discard(err)
	}

	err = handler.sender.Send(ctx, job)
	if err == nil {
		handler.logger.Info("push delivered", "jobId", job.ID, "provider", job.Provider)
		return nil
	}
	if isPermanent(err) {
		handler.logger.Warn(
			"push rejected permanently",
			"jobId", job.ID,
			"provider", job.Provider,
			"error", err,
		)
		return queueworker.Discard(err)
	}
	handler.logger.Error(
		"push failed",
		"jobId", job.ID,
		"provider", job.Provider,
		"error", err,
	)
	return err
}
