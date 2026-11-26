package utils

import (
	"reflect"
	"strings"
	"testing"
)

func TestLoadConfig(t *testing.T) {
	tests := []struct {
		name           string
		usersACL       string
		clientPassword string
		wantUsers      []ACLUser
		wantErr        string
	}{
		{
			name:           "password set",
			clientPassword: "pa$$word",
			wantUsers:      []ACLUser{{Name: "client", Rules: []string{"on", ">pa$$word", "~*", "+@read"}}},
		},
		{
			// ">" with nothing after it is a valid empty password
			name:    "password empty",
			wantErr: "unset environment variables",
		},
		{
			// Valkey splits aclfile lines on spaces, so the node would get the rule "word"
			name:           "password with a space",
			clientPassword: "pass word",
			wantErr:        "with a space, tab, carriage return or newline",
		},
		{
			// SetUsers would apply the line up to the newline before failing on the rest
			name:           "password with a newline",
			clientPassword: "pass\nword",
			wantErr:        "with a space, tab, carriage return or newline",
		},
		{
			// A restarted pod's aclfile load trims it, so the node would accept only "password"
			name:           "password ending in a carriage return",
			clientPassword: "password\r",
			wantErr:        "with a space, tab, carriage return or newline",
		},
		{
			name:           "password ending in a tab",
			clientPassword: "password\t",
			wantErr:        "with a space, tab, carriage return or newline",
		},
		{
			// apply-config retries every error that isn't Valkey's for its whole timeout
			name:           "line without user",
			usersACL:       "client on >${CLIENT_PASSWORD}\n",
			clientPassword: "password",
			wantErr:        "doesn't start with user",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			usersACL := test.usersACL
			if usersACL == "" {
				usersACL = "user client on >${CLIENT_PASSWORD} ~* +@read\n"
			}
			t.Setenv("PARAMETERS", `{"maxmemory":"100mb"}`)
			t.Setenv("USERS_ACL", usersACL)
			t.Setenv("CLIENT_PASSWORD", test.clientPassword)

			config, err := LoadConfig()
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("LoadConfig() error = %v", err)
				}
			} else if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("LoadConfig() error = %v, want one containing %q", err, test.wantErr)
			}
			if !reflect.DeepEqual(config.Users, test.wantUsers) {
				t.Errorf("LoadConfig() Users = %q, want %q", config.Users, test.wantUsers)
			}
		})
	}
}
