package runtime

import (
	"context"
	"errors"
	"fmt"
	"math"
	"queueworker"

	runtimev1 "queueworker/runtime/v1"
)

type RemoteHandler struct {
	client    runtimev1.HandlerClient
	publisher queueworker.Publisher
}

func NewRemoteHandler(
	client runtimev1.HandlerClient,
	publisher queueworker.Publisher,
) (*RemoteHandler, error) {
	if client == nil {
		return nil, errors.New("handler client is required")
	}
	return &RemoteHandler{client: client, publisher: publisher}, nil
}

func (handler *RemoteHandler) Handle(
	ctx context.Context,
	message queueworker.Message,
) error {
	attempts := queueworker.Attempts(message)
	if attempts > math.MaxInt32 {
		attempts = math.MaxInt32
	}
	response, err := handler.client.Handle(ctx, &runtimev1.HandleRequest{
		Id:      message.ID(),
		Body:    message.Body(),
		Attempt: int32(attempts), //nolint:gosec // Clamped to the protobuf field range.
	})
	if err != nil {
		return fmt.Errorf("call worker handler: %w", err)
	}
	switch response.GetOutcome() {
	case runtimev1.Outcome_OUTCOME_SUCCESS:
		return handler.publish(ctx, response.GetPublications())
	case runtimev1.Outcome_OUTCOME_RETRY:
		return responseError(response.GetError(), "worker handler requested retry")
	case runtimev1.Outcome_OUTCOME_DISCARD:
		return queueworker.Discard(responseError(
			response.GetError(),
			"worker handler discarded message",
		))
	default:
		return fmt.Errorf(
			"worker handler returned invalid outcome %s",
			response.GetOutcome(),
		)
	}
}

func (handler *RemoteHandler) publish(
	ctx context.Context,
	messages []*runtimev1.Publication,
) error {
	if len(messages) == 0 {
		return nil
	}
	if handler.publisher == nil {
		return errors.New("worker handler returned publications without an output queue")
	}
	publications := make([]queueworker.Publication, 0, len(messages))
	for _, message := range messages {
		publications = append(publications, queueworker.Publication{
			ID:   message.GetId(),
			Body: message.GetBody(),
		})
	}
	if err := handler.publisher.Publish(ctx, publications); err != nil {
		return fmt.Errorf("publish worker output: %w", err)
	}
	return nil
}

func responseError(reason, fallback string) error {
	if reason == "" {
		reason = fallback
	}
	return errors.New(reason)
}
