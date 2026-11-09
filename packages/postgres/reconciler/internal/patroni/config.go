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
	return fmt.Sprintf("http://patroni-%s-shard-%d:8008/config", db, shard)
}

// PatchConfig merges parameters into the cluster config that the Patroni REST API at configURL stores in
// the DCS. retry is true while a member is starting (no answer, or 503 before the config is in the DCS)
// or another config edit is in flight (409).
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

	if response.StatusCode < 200 || response.StatusCode > 299 {
		return response.StatusCode == http.StatusServiceUnavailable || response.StatusCode == http.StatusConflict,
			fmt.Errorf("HTTP %s", response.Status)
	}
	return false, nil
}
