package utils

import (
	"os"
	"reflect"
	"testing"
)

func TestLoadConfig(t *testing.T) {
	tests := []struct {
		name           string
		usersACL       string
		clientPassword string
		unset          bool
		wantUsers      []ACLUser
		wantErr        bool
	}{
		{
			name:           "password set",
			clientPassword: "pa$$word",
			wantUsers:      []ACLUser{{Name: "client", Rules: []string{"on", ">pa$$word", "~*", "+@read"}}},
		},
		{
			// ">" with nothing after it is a valid empty password
			name:    "password unset",
			unset:   true,
			wantErr: true,
		},
		{
			// Valkey splits aclfile lines on spaces, so the node would get the rule "word"
			name:           "password with a space",
			clientPassword: "pass word",
			wantErr:        true,
		},
		{
			// SetUsers would apply the line up to the newline before failing on the rest
			name:           "password with a newline",
			clientPassword: "pass\nword",
			wantErr:        true,
		},
		{
			// A restarted pod's aclfile load trims it, so the node would accept only "password"
			name:           "password ending in a carriage return",
			clientPassword: "password\r",
			wantErr:        true,
		},
		{
			name:           "password ending in a tab",
			clientPassword: "password\t",
			wantErr:        true,
		},
		{
			// apply-config retries every error that isn't Valkey's for its whole timeout
			name:           "line without user",
			usersACL:       "client on >${CLIENT_PASSWORD}\n",
			clientPassword: "password",
			wantErr:        true,
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
			if test.unset {
				if err := os.Unsetenv("CLIENT_PASSWORD"); err != nil {
					t.Fatal(err)
				}
			}

			config, err := LoadConfig()
			if (err != nil) != test.wantErr {
				t.Fatalf("LoadConfig() error = %v, wantErr %v", err, test.wantErr)
			}
			if !reflect.DeepEqual(config.Users, test.wantUsers) {
				t.Errorf("LoadConfig() Users = %q, want %q", config.Users, test.wantUsers)
			}
		})
	}
}
