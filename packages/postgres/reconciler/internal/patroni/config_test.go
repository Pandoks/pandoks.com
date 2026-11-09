package patroni

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPatchConfig(t *testing.T) {
	tests := []struct {
		name          string
		status        int
		stopped       bool
		wantErr       bool
		wantRetryable bool
	}{
		{
			name:   "config updated",
			status: http.StatusOK,
		},
		{
			name:          "config not in the DCS yet",
			status:        http.StatusServiceUnavailable,
			wantErr:       true,
			wantRetryable: true,
		},
		{
			name:          "concurrent config edit",
			status:        http.StatusConflict,
			wantErr:       true,
			wantRetryable: true,
		},
		{
			name:          "member not answering",
			stopped:       true,
			wantErr:       true,
			wantRetryable: true,
		},
		{
			name:    "wrong password",
			status:  http.StatusUnauthorized,
			wantErr: true,
		},
		{
			name:    "rejected config",
			status:  http.StatusBadRequest,
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(test.status)
			}))
			if test.stopped {
				server.Close()
			} else {
				defer server.Close()
			}

			err := PatchConfig(server.URL, "password", []byte("{}"))
			if (err != nil) != test.wantErr {
				t.Fatalf("PatchConfig() error = %v, wantErr %v", err, test.wantErr)
			}
			if err != nil && IsRetryable(err) != test.wantRetryable {
				t.Errorf("IsRetryable(%v) = %v, want %v", err, !test.wantRetryable, test.wantRetryable)
			}
		})
	}
}
