package queueworker

import (
	"context"
	"errors"
	"fmt"
)

type Processor interface {
	Process(context.Context, Message) ([]Publication, error)
}

type ProcessorFunc func(context.Context, Message) ([]Publication, error)

func (processor ProcessorFunc) Process(
	ctx context.Context,
	message Message,
) ([]Publication, error) {
	return processor(ctx, message)
}

type PipelineHandler struct {
	processor Processor
	publisher Publisher
}

func NewPipelineHandler(processor Processor, publisher Publisher) (*PipelineHandler, error) {
	if processor == nil {
		return nil, errors.New("processor is required")
	}
	return &PipelineHandler{processor: processor, publisher: publisher}, nil
}

func (handler *PipelineHandler) Handle(ctx context.Context, message Message) error {
	publications, err := handler.processor.Process(ctx, message)
	if err != nil {
		return err
	}
	if len(publications) == 0 {
		return nil
	}
	if handler.publisher == nil {
		return errors.New("processor returned publications without an output queue")
	}
	if err := handler.publisher.Publish(ctx, publications); err != nil {
		return fmt.Errorf("publish processor output: %w", err)
	}
	return nil
}
