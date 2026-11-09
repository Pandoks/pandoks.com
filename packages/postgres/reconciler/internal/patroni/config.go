package patroni

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"time"
)

const User = "patroni"

var ErrUnreachable = errors.New("no answer")

type StatusError struct {
	StatusCode int
}

func (err StatusError) Error() string {
	return fmt.Sprintf("HTTP %d %s", err.StatusCode, http.StatusText(err.StatusCode))
}

var httpClient = &http.Client{Timeout: 10 * time.Second}

func GetGroupConfigURL(db string, group int) string {
	return fmt.Sprintf("http://patroni-%s-group-%d:8008/config", db, group)
}

// PatchConfig merges body into the cluster config that the Patroni REST API at configURL stores in the DCS
func PatchConfig(configURL string, password string, body []byte) error {
	request, err := http.NewRequest(http.MethodPatch, configURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.SetBasicAuth(User, password)

	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode < 200 || response.StatusCode > 299 {
		return StatusError{StatusCode: response.StatusCode}
	}
	return nil
}

// IsRetryable reports whether a PatchConfig error is temporary: a member that is starting (no answer,
// or 503 before the config is in the DCS) or a concurrent config edit (409)
func IsRetryable(err error) bool {
	var statusError StatusError
	if errors.As(err, &statusError) {
		return statusError.StatusCode == http.StatusServiceUnavailable || statusError.StatusCode == http.StatusConflict
	}
	return errors.Is(err, ErrUnreachable)
}
