package patroni

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

var httpClient = &http.Client{Timeout: 10 * time.Second}

func GetShardConfigURL(db string, shard int) string {
	return fmt.Sprintf("http://patroni-%s-api-shard-%d:8008/config", db, shard)
}

func PatchConfig(configURL string, password string, parameters map[string]any) (retry bool, err error) {
	body, err := json.Marshal(map[string]any{"postgresql": map[string]any{"parameters": parameters}})
	if err != nil {
		return false, err
	}

	request, err := http.NewRequest(http.MethodPatch, configURL, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.SetBasicAuth("patroni", password)

	response, err := httpClient.Do(request)
	if err != nil {
		return true, fmt.Errorf("no answer: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	// NOTE: 503 means still bootstrapping, and bootstrap.dcs already sets these parameters
	if response.StatusCode == http.StatusServiceUnavailable {
		return false, nil
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return response.StatusCode == http.StatusConflict, fmt.Errorf("HTTP %s", response.Status)
	}
	return false, nil
}
