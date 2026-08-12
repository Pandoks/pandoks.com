package queueworker

import (
	"context"
	"fmt"
	"strings"
)

type Publication struct {
	ID   string
	Body []byte
}

type Publisher interface {
	Publish(context.Context, []Publication) error
}

type PublishFailure struct {
	Index int
	ID    string
	Err   error
}

type PublishError struct {
	Failures []PublishFailure
}

func (err *PublishError) Error() string {
	parts := make([]string, 0, len(err.Failures))
	for _, failure := range err.Failures {
		parts = append(parts, fmt.Sprintf(
			"message %d (%q): %v",
			failure.Index,
			failure.ID,
			failure.Err,
		))
	}
	return "publish messages: " + strings.Join(parts, "; ")
}

func (err *PublishError) Unwrap() []error {
	causes := make([]error, 0, len(err.Failures))
	for _, failure := range err.Failures {
		causes = append(causes, failure.Err)
	}
	return causes
}
