package queueworker_test

import (
	"context"
	"errors"
	"queueworker"
	"testing"
)

func TestPipelineHandlerPublishesBeforeSuccess(t *testing.T) {
	t.Parallel()

	publisher := &pipelinePublisher{}
	handler, err := queueworker.NewPipelineHandler(
		queueworker.ProcessorFunc(func(
			context.Context,
			queueworker.Message,
		) ([]queueworker.Publication, error) {
			return []queueworker.Publication{{ID: "output", Body: []byte("body")}}, nil
		}),
		publisher,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := handler.Handle(context.Background(), fakeMessage{id: "input"}); err != nil {
		t.Fatal(err)
	}
	if len(publisher.messages) != 1 || publisher.messages[0].ID != "output" {
		t.Fatalf("messages = %#v", publisher.messages)
	}
}

func TestPipelineHandlerReturnsPublishFailure(t *testing.T) {
	t.Parallel()

	publisher := &pipelinePublisher{err: errors.New("output unavailable")}
	handler, err := queueworker.NewPipelineHandler(
		queueworker.ProcessorFunc(func(
			context.Context,
			queueworker.Message,
		) ([]queueworker.Publication, error) {
			return []queueworker.Publication{{Body: []byte("body")}}, nil
		}),
		publisher,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := handler.Handle(context.Background(), fakeMessage{id: "input"}); err == nil {
		t.Fatal("Handle returned nil after publish failure")
	}
}

type pipelinePublisher struct {
	messages []queueworker.Publication
	err      error
}

func (publisher *pipelinePublisher) Publish(
	_ context.Context,
	messages []queueworker.Publication,
) error {
	publisher.messages = append(publisher.messages, messages...)
	return publisher.err
}
