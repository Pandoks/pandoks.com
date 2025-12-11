package valkey

import (
	"strings"
	"testing"
)

func TestClusterNode_Index(t *testing.T) {
	tests := []struct {
		name     string
		hostname string
		want     int
	}{
		{
			name:     "valid hostname with index 0",
			hostname: "valkey-0.valkey.default.svc.cluster.local",
			want:     0,
		},
		{
			name:     "valid hostname with index 5",
			hostname: "valkey-5.valkey.default.svc.cluster.local",
			want:     5,
		},
		{
			name:     "valid hostname with index 123",
			hostname: "valkey-123.valkey.default.svc.cluster.local",
			want:     123,
		},
		{
			name:     "empty hostname",
			hostname: "",
			want:     -1,
		},
		{
			name:     "hostname without index",
			hostname: "valkey.default.svc.cluster.local",
			want:     -1,
		},
		{
			name:     "hostname with invalid index",
			hostname: "valkey-abc.valkey.default.svc.cluster.local",
			want:     -1,
		},
		{
			name:     "hostname with negative index",
			hostname: "valkey--5.valkey.default.svc.cluster.local",
			want:     5,
		},
		{
			name:     "short hostname",
			hostname: "valkey-7",
			want:     7,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			node := ClusterNode{
				Hostname: test.hostname,
			}
			got := node.Index()
			if got != test.want {
				t.Errorf("Index() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestAddressParts(t *testing.T) {
	tests := []struct {
		name        string
		address     string
		wantIP      string
		wantClient  uint16
		wantBus     uint16
		wantHost    string
		wantErr     bool
		errContains string
	}{
		{
			name:       "valid IPv4 with hostname",
			address:    "10.0.0.1:6379@16379,valkey-0.valkey.default.svc.cluster.local",
			wantIP:     "10.0.0.1",
			wantClient: 6379,
			wantBus:    16379,
			wantHost:   "valkey-0.valkey.default.svc.cluster.local",
			wantErr:    false,
		},
		{
			name:       "valid IPv4 without hostname",
			address:    "192.168.1.100:6379@16379",
			wantIP:     "192.168.1.100",
			wantClient: 6379,
			wantBus:    16379,
			wantHost:   "",
			wantErr:    false,
		},
		{
			name:       "valid IPv6 with hostname",
			address:    "::1:6379@16379,valkey-0.valkey.default.svc.cluster.local",
			wantIP:     "::1",
			wantClient: 6379,
			wantBus:    16379,
			wantHost:   "valkey-0.valkey.default.svc.cluster.local",
			wantErr:    false,
		},
		{
			name:        "missing colon",
			address:     "10.0.0.1",
			wantErr:     true,
			errContains: "invalid parsing \":\"",
		},
		{
			name:        "missing bus port",
			address:     "10.0.0.1:6379",
			wantErr:     true,
			errContains: "client and bus ports should both be specified",
		},
		{
			name:        "invalid client port",
			address:     "10.0.0.1:abc@16379",
			wantErr:     true,
			errContains: "client port should be a number",
		},
		{
			name:        "invalid bus port",
			address:     "10.0.0.1:6379@xyz",
			wantErr:     true,
			errContains: "bus port should be a number",
		},
		{
			name:        "port out of range",
			address:     "10.0.0.1:99999@16379",
			wantErr:     true,
			errContains: "client port should be a number",
		},
		{
			name:       "hostname with special characters",
			address:    "10.0.0.1:6379@16379,valkey-0_test.namespace-prod.svc.cluster.local",
			wantIP:     "10.0.0.1",
			wantClient: 6379,
			wantBus:    16379,
			wantHost:   "valkey-0_test.namespace-prod.svc.cluster.local",
			wantErr:    false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ip, clientPort, busPort, hostname, err := addressParts(test.address)

			if test.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if test.errContains != "" && !strings.Contains(err.Error(), test.errContains) {
					t.Errorf("expected error containing %q, got %q", test.errContains, err.Error())
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if ip != test.wantIP {
				t.Errorf("ip = %q, want %q", ip, test.wantIP)
			}
			if clientPort != test.wantClient {
				t.Errorf("clientPort = %d, want %d", clientPort, test.wantClient)
			}
			if busPort != test.wantBus {
				t.Errorf("busPort = %d, want %d", busPort, test.wantBus)
			}
			if hostname != test.wantHost {
				t.Errorf("hostname = %q, want %q", hostname, test.wantHost)
			}
		})
	}
}

func TestFlags(t *testing.T) {
	tests := []struct {
		name        string
		flagString  string
		want        []Flag
		wantErr     bool
		errContains string
	}{
		{
			name:       "single flag myself",
			flagString: "myself",
			want:       []Flag{Myself},
			wantErr:    false,
		},
		{
			name:       "master flag",
			flagString: "master",
			want:       []Flag{Master},
			wantErr:    false,
		},
		{
			name:       "multiple flags",
			flagString: "myself,master",
			want:       []Flag{Myself, Master},
			wantErr:    false,
		},
		{
			name:       "slave flag",
			flagString: "slave",
			want:       []Flag{Slave},
			wantErr:    false,
		},
		{
			name:       "fail flags",
			flagString: "fail?,fail",
			want:       []Flag{Pfail, Fail},
			wantErr:    false,
		},
		{
			name:       "all valid flags",
			flagString: "myself,master,fail?,handshake",
			want:       []Flag{Myself, Master, Pfail, Handshake},
			wantErr:    false,
		},
		{
			name:       "noflags",
			flagString: "noflags",
			want:       []Flag{NoFlags},
			wantErr:    false,
		},
		{
			name:        "invalid flag",
			flagString:  "invalid",
			wantErr:     true,
			errContains: "unknown flag: invalid",
		},
		{
			name:        "mixed valid and invalid",
			flagString:  "master,invalid,slave",
			wantErr:     true,
			errContains: "unknown flag: invalid",
		},
		{
			name:        "empty string",
			flagString:  "",
			wantErr:     true,
			errContains: "unknown flag: ",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := flags(test.flagString)

			if test.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if test.errContains != "" && !strings.Contains(err.Error(), test.errContains) {
					t.Errorf("expected error containing %q, got %q", test.errContains, err.Error())
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if len(got) != len(test.want) {
				t.Fatalf("got %d flags, want %d", len(got), len(test.want))
			}

			for i, flag := range got {
				if flag != test.want[i] {
					t.Errorf("flag[%d] = %q, want %q", i, flag, test.want[i])
				}
			}
		})
	}
}

func TestParseSlots(t *testing.T) {
	tests := []struct {
		name          string
		slots         []string
		wantRanges    []SlotRange
		wantImporting []ImportingSlot
		wantMigrating []MigratingSlot
		wantErr       bool
		errContains   string
	}{
		{
			name:  "single slot",
			slots: []string{"100"},
			wantRanges: []SlotRange{
				{StartSlot: 100, EndSlot: 100},
			},
			wantImporting: []ImportingSlot{},
			wantMigrating: []MigratingSlot{},
			wantErr:       false,
		},
		{
			name:  "slot range",
			slots: []string{"0-5460"},
			wantRanges: []SlotRange{
				{StartSlot: 0, EndSlot: 5460},
			},
			wantImporting: []ImportingSlot{},
			wantMigrating: []MigratingSlot{},
			wantErr:       false,
		},
		{
			name:  "multiple ranges",
			slots: []string{"0-100", "200-300", "500"},
			wantRanges: []SlotRange{
				{StartSlot: 0, EndSlot: 100},
				{StartSlot: 200, EndSlot: 300},
				{StartSlot: 500, EndSlot: 500},
			},
			wantImporting: []ImportingSlot{},
			wantMigrating: []MigratingSlot{},
			wantErr:       false,
		},
		{
			name:       "importing slot",
			slots:      []string{"[100-<-abc123]"},
			wantRanges: []SlotRange{},
			wantImporting: []ImportingSlot{
				{Slot: 100, ImportingNodeID: "abc123"},
			},
			wantMigrating: []MigratingSlot{},
			wantErr:       false,
		},
		{
			name:          "migrating slot",
			slots:         []string{"[200->-def456]"},
			wantRanges:    []SlotRange{},
			wantImporting: []ImportingSlot{},
			wantMigrating: []MigratingSlot{
				{Slot: 200, MigratingNodeID: "def456"},
			},
			wantErr: false,
		},
		{
			name:  "mixed slots",
			slots: []string{"0-100", "[50-<-node1]", "200", "[300->-node2]"},
			wantRanges: []SlotRange{
				{StartSlot: 0, EndSlot: 100},
				{StartSlot: 200, EndSlot: 200},
			},
			wantImporting: []ImportingSlot{
				{Slot: 50, ImportingNodeID: "node1"},
			},
			wantMigrating: []MigratingSlot{
				{Slot: 300, MigratingNodeID: "node2"},
			},
			wantErr: false,
		},
		{
			name:          "empty slots",
			slots:         []string{},
			wantRanges:    []SlotRange{},
			wantImporting: []ImportingSlot{},
			wantMigrating: []MigratingSlot{},
			wantErr:       false,
		},
		{
			name:        "invalid slot number",
			slots:       []string{"abc"},
			wantErr:     true,
			errContains: "invalid slot range",
		},
		{
			name:        "invalid range format",
			slots:       []string{"0-100-200"},
			wantErr:     true,
			errContains: "invalid slot range",
		},
		{
			name:        "invalid importing format",
			slots:       []string{"[100-node1]"},
			wantErr:     true,
			errContains: "invalid slot range",
		},
		{
			name:  "max slot number",
			slots: []string{"16383"},
			wantRanges: []SlotRange{
				{StartSlot: 16383, EndSlot: 16383},
			},
			wantImporting: []ImportingSlot{},
			wantMigrating: []MigratingSlot{},
			wantErr:       false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ranges, importing, migrating, err := parseSlots(test.slots...)

			if test.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if test.errContains != "" && !strings.Contains(err.Error(), test.errContains) {
					t.Errorf("expected error containing %q, got %q", test.errContains, err.Error())
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if len(ranges) != len(test.wantRanges) {
				t.Fatalf("got %d ranges, want %d", len(ranges), len(test.wantRanges))
			}
			for i, r := range ranges {
				if r != test.wantRanges[i] {
					t.Errorf("range[%d] = %+v, want %+v", i, r, test.wantRanges[i])
				}
			}

			if len(importing) != len(test.wantImporting) {
				t.Fatalf("got %d importing slots, want %d", len(importing), len(test.wantImporting))
			}
			for i, imp := range importing {
				if imp != test.wantImporting[i] {
					t.Errorf("importing[%d] = %+v, want %+v", i, imp, test.wantImporting[i])
				}
			}

			if len(migrating) != len(test.wantMigrating) {
				t.Fatalf("got %d migrating slots, want %d", len(migrating), len(test.wantMigrating))
			}
			for i, mig := range migrating {
				if mig != test.wantMigrating[i] {
					t.Errorf("migrating[%d] = %+v, want %+v", i, mig, test.wantMigrating[i])
				}
			}
		})
	}
}
