package runtime_test

import (
	"context"
	"errors"
	"queueworker"
	queueruntime "queueworker/runtime"
	runtimev1 "queueworker/runtime/v1"
	"testing"

	"google.golang.org/grpc"
)

func TestRemoteHandlerPublishesSuccessfulOutput(t *testing.T) {
	t.Parallel()

	publisher := &fakePublisher{}
	handler, err := queueruntime.NewRemoteHandler(&fakeHandlerClient{
		response: &runtimev1.HandleResponse{
			Outcome: runtimev1.Outcome_OUTCOME_SUCCESS,
			Publications: []*runtimev1.Publication{{
				Id: "output-1", Body: []byte("output"),
			}},
		},
	}, publisher)
	if err != nil {
		t.Fatal(err)
	}
	if err := handler.Handle(context.Background(), message{id: "input", body: []byte("input")}); err != nil {
		t.Fatal(err)
	}
	if len(publisher.messages) != 1 || publisher.messages[0].ID != "output-1" {
		t.Fatalf("publications = %#v", publisher.messages)
	}
}

func TestRemoteHandlerRetriesWhenOutputPublishFails(t *testing.T) {
	t.Parallel()

	handler, err := queueruntime.NewRemoteHandler(&fakeHandlerClient{
		response: &runtimev1.HandleResponse{
			Outcome:      runtimev1.Outcome_OUTCOME_SUCCESS,
			Publications: []*runtimev1.Publication{{Body: []byte("output")}},
		},
	}, &fakePublisher{err: errors.New("queue unavailable")})
	if err != nil {
		t.Fatal(err)
	}
	err = handler.Handle(context.Background(), message{id: "input"})
	if err == nil {
		t.Fatal("Handle returned nil after output publish failed")
	}
}

func TestRemoteHandlerMapsDiscard(t *testing.T) {
	t.Parallel()

	handler, err := queueruntime.NewRemoteHandler(&fakeHandlerClient{
		response: &runtimev1.HandleResponse{
			Outcome: runtimev1.Outcome_OUTCOME_DISCARD,
			Error:   "invalid job",
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = handler.Handle(context.Background(), message{id: "input"})
	if err == nil {
		t.Fatal("Handle returned nil for discarded message")
	}
}

type fakeHandlerClient struct {
	response *runtimev1.HandleResponse
	err      error
}

func (client *fakeHandlerClient) Handle(
	context.Context,
	*runtimev1.HandleRequest,
	...grpc.CallOption,
) (*runtimev1.HandleResponse, error) {
	return client.response, client.err
}

type fakePublisher struct {
	messages []queueworker.Publication
	err      error
}

func (publisher *fakePublisher) Publish(
	_ context.Context,
	messages []queueworker.Publication,
) error {
	publisher.messages = append(publisher.messages, messages...)
	return publisher.err
}

type message struct {
	id   string
	body []byte
}

func (message message) ID() string   { return message.id }
func (message message) Body() []byte { return message.body }
