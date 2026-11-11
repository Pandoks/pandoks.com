package utils

import "testing"

func TestLoadConfig(t *testing.T) {
	tests := []struct {
		name           string
		clientPassword string
		wantUsersACL   string
		wantErr        bool
	}{
		{
			name:           "password set",
			clientPassword: "pa$$word",
			wantUsersACL:   "user client on >pa$$word ~* +@read\n",
		},
		{
			// ">" with nothing after it is a valid empty password
			name:    "password unset",
			wantErr: true,
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
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("PARAMETERS", `{"maxmemory":"100mb"}`)
			t.Setenv("USERS_ACL", "user client on >${CLIENT_PASSWORD} ~* +@read\n")
			t.Setenv("CLIENT_PASSWORD", test.clientPassword)

			config, err := LoadConfig()
			if (err != nil) != test.wantErr {
				t.Fatalf("LoadConfig() error = %v, wantErr %v", err, test.wantErr)
			}
			if config.UsersACL != test.wantUsersACL {
				t.Errorf("LoadConfig() UsersACL = %q, want %q", config.UsersACL, test.wantUsersACL)
			}
		})
	}
}
