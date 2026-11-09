package patroni

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestPatchConfig(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		reason    string
		stopped   bool
		wantErr   bool
		wantRetry bool
	}{
		{
			name:   "config updated",
			status: http.StatusOK,
		},
		{
			name:      "config not in the DCS yet",
			status:    http.StatusServiceUnavailable,
			wantErr:   true,
			wantRetry: true,
		},
		{
			name:      "concurrent config edit",
			status:    http.StatusConflict,
			wantErr:   true,
			wantRetry: true,
		},
		{
			name:      "member not answering",
			stopped:   true,
			wantErr:   true,
			wantRetry: true,
		},
		{
			name:    "wrong password",
			status:  http.StatusUnauthorized,
			wantErr: true,
		},
		{
			name:    "rejected config",
			status:  http.StatusBadRequest,
			reason:  "invalid value for parameter \"max_connections\"",
			wantErr: true,
		},
	}

	parameters := map[string]any{"max_connections": "200", "shared_buffers": "1GB"}
	wantBody := map[string]any{"postgresql": map[string]any{"parameters": parameters}}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.Method != http.MethodPatch || request.URL.Path != "/config" {
					t.Errorf("request = %s %s, want PATCH /config", request.Method, request.URL.Path)
				}
				if contentType := request.Header.Get("Content-Type"); contentType != "application/json" {
					t.Errorf("Content-Type = %q, want application/json", contentType)
				}
				if user, password, ok := request.BasicAuth(); !ok || user != "patroni" || password != "password" {
					t.Errorf("BasicAuth() = %q, %q, %v, want patroni, password, true", user, password, ok)
				}
				var body map[string]any
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil || !reflect.DeepEqual(body, wantBody) {
					t.Errorf("body = %v (%v), want %v", body, err, wantBody)
				}
				writer.WriteHeader(test.status)
				_, _ = writer.Write([]byte(test.reason + "\n"))
			}))
			if test.stopped {
				server.Close()
			} else {
				defer server.Close()
			}

			retry, err := PatchConfig(server.URL+"/config", "password", parameters)
			if (err != nil) != test.wantErr {
				t.Fatalf("PatchConfig() error = %v, wantErr %v", err, test.wantErr)
			}
			if test.reason != "" && !strings.Contains(err.Error(), test.reason) {
				t.Errorf("PatchConfig() error = %v, want it to contain %q", err, test.reason)
			}
			if retry != test.wantRetry {
				t.Errorf("PatchConfig() retry = %v, want %v", retry, test.wantRetry)
			}
		})
	}
}
