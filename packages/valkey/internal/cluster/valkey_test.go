package cluster

import (
	"testing"
	"valkey/operator/internal/slot"
)

func TestParseClusterTopology(t *testing.T) {
	tests := []struct {
		name          string
		input         string
		expectError   bool
		checkTopology func(*testing.T, *ClusterTopology)
	}{
		{
			name: "3 masters with slots assigned",
			input: `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 node2.example.com:6379@16379 master - 0 1538428699000 2 connected 5461-10922
292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f node3.example.com:6379@16379 master - 0 1538428697000 3 connected 10923-16383`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 3 {
					t.Errorf("Masters count = %d, want 3", len(topology.Masters))
				}
				if len(topology.Replicas) != 0 {
					t.Errorf("Replicas count = %d, want 0", len(topology.Replicas))
				}
				if len(topology.Nodes) != 3 {
					t.Errorf("Nodes count = %d, want 3", len(topology.Nodes))
				}

				master0 := topology.Masters[0]
				if master0.ID != "07c37dfeb235213a872192d05877c5d02d9a7e1f" {
					t.Errorf("Master[0].ID = %s, want 07c37dfeb235213a872192d05877c5d02d9a7e1f", master0.ID)
				}
				if master0.Address.Host != "node1.example.com" {
					t.Errorf("Master[0].Address.Host = %s, want node1.example.com", master0.Address.Host)
				}
				if master0.Address.Port != 6379 {
					t.Errorf("Master[0].Address.Port = %d, want 6379", master0.Address.Port)
				}
				if master0.Role != NodeRoleMaster {
					t.Errorf("Master[0].Role = %s, want master", master0.Role)
				}
				if !master0.Connected {
					t.Error("Master[0].Connected = false, want true")
				}
				if len(master0.SlotRanges) != 1 {
					t.Fatalf("Master[0] has %d slot ranges, want 1", len(master0.SlotRanges))
				}
				if master0.SlotRanges[0].Start != 0 || master0.SlotRanges[0].End != 5460 {
					t.Errorf("Master[0] slot range = [%d-%d], want [0-5460]",
						master0.SlotRanges[0].Start, master0.SlotRanges[0].End)
				}

				master2 := topology.Masters[2]
				if len(master2.SlotRanges) != 1 {
					t.Fatalf("Master[2] has %d slot ranges, want 1", len(master2.SlotRanges))
				}
				if master2.SlotRanges[0].Start != 10923 || master2.SlotRanges[0].End != 16383 {
					t.Errorf("Master[2] slot range = [%d-%d], want [10923-16383]",
						master2.SlotRanges[0].Start, master2.SlotRanges[0].End)
				}
			},
		},
		{
			name: "masters with no slots assigned (after CLUSTER MEET)",
			input: `07c37dfeb235213a872192d90877d0cd55635b91 192.168.1.2:7000@17000 master - 0 1507999953498 1 connected
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 192.168.1.2:7001@17001 master - 0 1507999952495 2 connected
292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 192.168.1.2:7002@17002 master - 0 1507999954504 3 connected`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 3 {
					t.Errorf("Masters count = %d, want 3", len(topology.Masters))
				}
				if len(topology.Replicas) != 0 {
					t.Errorf("Replicas count = %d, want 0", len(topology.Replicas))
				}
				if len(topology.Nodes) != 3 {
					t.Errorf("Nodes count = %d, want 3", len(topology.Nodes))
				}

				for i, master := range topology.Masters {
					if master.Role != NodeRoleMaster {
						t.Errorf("Master[%d].Role = %s, want master", i, master.Role)
					}
					if !master.Connected {
						t.Errorf("Master[%d].Connected = false, want true", i)
					}
					if len(master.SlotRanges) != 0 {
						t.Errorf("Master[%d] has %d slot ranges, want 0 (no slots assigned)", i, len(master.SlotRanges))
					}
				}

				if topology.Masters[0].Address.Host != "192.168.1.2" {
					t.Errorf("Master[0].Address.Host = %s, want 192.168.1.2", topology.Masters[0].Address.Host)
				}
				if topology.Masters[0].Address.Port != 7000 {
					t.Errorf("Master[0].Address.Port = %d, want 7000", topology.Masters[0].Address.Port)
				}
			},
		},
		{
			name: "masters with replicas using 'slave' keyword (Redis)",
			input: `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 node2.example.com:6379@16379 master - 0 1538428699000 2 connected 5461-10922
292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f node3.example.com:6379@16379 master - 0 1538428697000 3 connected 10923-16383
e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca node4.example.com:6379@16379 slave 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected
c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8 node5.example.com:6379@16379 slave 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1538428698000 5 connected
a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 node6.example.com:6379@16379 slave 292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 0 1538428698000 6 connected`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 3 {
					t.Errorf("Masters count = %d, want 3", len(topology.Masters))
				}
				if len(topology.Replicas) != 3 {
					t.Errorf("Replicas count = %d, want 3", len(topology.Replicas))
				}
				if len(topology.Nodes) != 6 {
					t.Errorf("Nodes count = %d, want 6", len(topology.Nodes))
				}

				replica0 := topology.Replicas[0]
				if replica0.Role != NodeRoleSlave {
					t.Errorf("Replica[0].Role = %s, want slave", replica0.Role)
				}
				if replica0.MasterID != "07c37dfeb235213a872192d05877c5d02d9a7e1f" {
					t.Errorf("Replica[0].MasterID = %s, want 07c37dfeb235213a872192d05877c5d02d9a7e1f", replica0.MasterID)
				}
				if !replica0.Connected {
					t.Error("Replica[0].Connected = false, want true")
				}

				replica2 := topology.Replicas[2]
				if replica2.MasterID != "292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f" {
					t.Errorf("Replica[2].MasterID = %s, want 292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f", replica2.MasterID)
				}
			},
		},
		{
			name: "masters with replicas using 'replica' keyword (Valkey)",
			input: `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 node2.example.com:6379@16379 master - 0 1538428699000 2 connected 5461-10922
e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca node3.example.com:6379@16379 replica 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected
c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8 node4.example.com:6379@16379 replica 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1538428698000 5 connected`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 2 {
					t.Errorf("Masters count = %d, want 2", len(topology.Masters))
				}
				if len(topology.Replicas) != 2 {
					t.Errorf("Replicas count = %d, want 2", len(topology.Replicas))
				}

				replica0 := topology.Replicas[0]
				if replica0.Role != NodeRoleSlave {
					t.Errorf("Replica[0].Role = %s, want slave", replica0.Role)
				}
				if replica0.MasterID != "07c37dfeb235213a872192d05877c5d02d9a7e1f" {
					t.Errorf("Replica[0].MasterID = %s, want 07c37dfeb235213a872192d05877c5d02d9a7e1f", replica0.MasterID)
				}

				replica1 := topology.Replicas[1]
				if replica1.Role != NodeRoleSlave {
					t.Errorf("Replica[1].Role = %s, want slave", replica1.Role)
				}
				if replica1.MasterID != "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1" {
					t.Errorf("Replica[1].MasterID = %s, want 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1", replica1.MasterID)
				}
			},
		},
		{
			name:        "master with multiple slot ranges",
			input:       `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-100 200-300 500-600`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 1 {
					t.Fatalf("Masters count = %d, want 1", len(topology.Masters))
				}

				master := topology.Masters[0]
				if len(master.SlotRanges) != 3 {
					t.Fatalf("Master has %d slot ranges, want 3", len(master.SlotRanges))
				}

				expectedRanges := []slot.SlotRange{
					{Start: 0, End: 100},
					{Start: 200, End: 300},
					{Start: 500, End: 600},
				}

				for i, slotRange := range master.SlotRanges {
					if slotRange != expectedRanges[i] {
						t.Errorf("SlotRange[%d] = [%d-%d], want [%d-%d]",
							i, slotRange.Start, slotRange.End,
							expectedRanges[i].Start, expectedRanges[i].End)
					}
				}
			},
		},
		{
			name:        "master with single slot numbers",
			input:       `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0 100 200`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 1 {
					t.Fatalf("Masters count = %d, want 1", len(topology.Masters))
				}

				master := topology.Masters[0]
				if len(master.SlotRanges) != 3 {
					t.Fatalf("Master has %d slot ranges, want 3", len(master.SlotRanges))
				}

				expectedRanges := []slot.SlotRange{
					{Start: 0, End: 0},
					{Start: 100, End: 100},
					{Start: 200, End: 200},
				}

				for i, slotRange := range master.SlotRanges {
					if slotRange != expectedRanges[i] {
						t.Errorf("SlotRange[%d] = [%d-%d], want [%d-%d]",
							i, slotRange.Start, slotRange.End,
							expectedRanges[i].Start, expectedRanges[i].End)
					}
				}
			},
		},
		{
			name:        "master with mixed slot ranges and single slots",
			input:       `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-100 150 200-300`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 1 {
					t.Fatalf("Masters count = %d, want 1", len(topology.Masters))
				}

				master := topology.Masters[0]
				if len(master.SlotRanges) != 3 {
					t.Fatalf("Master has %d slot ranges, want 3", len(master.SlotRanges))
				}

				expectedRanges := []slot.SlotRange{
					{Start: 0, End: 100},
					{Start: 150, End: 150},
					{Start: 200, End: 300},
				}

				for i, slotRange := range master.SlotRanges {
					if slotRange != expectedRanges[i] {
						t.Errorf("SlotRange[%d] = [%d-%d], want [%d-%d]",
							i, slotRange.Start, slotRange.End,
							expectedRanges[i].Start, expectedRanges[i].End)
					}
				}
			},
		},
		{
			name:        "node with importing/migrating slots (should be skipped)",
			input:       `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-100 [200->-67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1] [300-<-292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f] 400-500`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 1 {
					t.Fatalf("Masters count = %d, want 1", len(topology.Masters))
				}

				master := topology.Masters[0]
				if len(master.SlotRanges) != 2 {
					t.Fatalf("Master has %d slot ranges, want 2 (importing/migrating should be skipped)", len(master.SlotRanges))
				}

				expectedRanges := []slot.SlotRange{
					{Start: 0, End: 100},
					{Start: 400, End: 500},
				}

				for i, slotRange := range master.SlotRanges {
					if slotRange != expectedRanges[i] {
						t.Errorf("SlotRange[%d] = [%d-%d], want [%d-%d]",
							i, slotRange.Start, slotRange.End,
							expectedRanges[i].Start, expectedRanges[i].End)
					}
				}
			},
		},
		{
			name:        "myself flag in node",
			input:       `6ec23923021cf3ffec47632106199cb7f496ce01 192.168.1.3:7000@17000 myself,master - 0 1507999952 0 connected 0-5460`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 1 {
					t.Fatalf("Masters count = %d, want 1", len(topology.Masters))
				}

				master := topology.Masters[0]
				if master.Role != NodeRoleMaster {
					t.Errorf("Master.Role = %s, want master", master.Role)
				}
				if len(master.SlotRanges) != 1 {
					t.Fatalf("Master has %d slot ranges, want 1", len(master.SlotRanges))
				}
				if master.SlotRanges[0].Start != 0 || master.SlotRanges[0].End != 5460 {
					t.Errorf("Master slot range = [%d-%d], want [0-5460]",
						master.SlotRanges[0].Start, master.SlotRanges[0].End)
				}
			},
		},
		{
			name:        "empty input",
			input:       "",
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 0 {
					t.Errorf("Masters count = %d, want 0", len(topology.Masters))
				}
				if len(topology.Replicas) != 0 {
					t.Errorf("Replicas count = %d, want 0", len(topology.Replicas))
				}
				if len(topology.Nodes) != 0 {
					t.Errorf("Nodes count = %d, want 0", len(topology.Nodes))
				}
			},
		},
		{
			name: "malformed lines are skipped",
			input: `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-5460
invalid line with not enough fields
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 node2.example.com:6379@16379 master - 0 1538428699000 2 connected 5461-10922`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 2 {
					t.Errorf("Masters count = %d, want 2 (malformed line should be skipped)", len(topology.Masters))
				}
			},
		},
		{
			name:        "invalid slot ranges are skipped",
			input:       `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-100 invalid 200-300 999999 300-400`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 1 {
					t.Fatalf("Masters count = %d, want 1", len(topology.Masters))
				}

				master := topology.Masters[0]
				if len(master.SlotRanges) != 3 {
					t.Fatalf("Master has %d slot ranges, want 3 (invalid ranges should be skipped)", len(master.SlotRanges))
				}

				expectedRanges := []slot.SlotRange{
					{Start: 0, End: 100},
					{Start: 200, End: 300},
					{Start: 300, End: 400},
				}

				for i, slotRange := range master.SlotRanges {
					if slotRange != expectedRanges[i] {
						t.Errorf("SlotRange[%d] = [%d-%d], want [%d-%d]",
							i, slotRange.Start, slotRange.End,
							expectedRanges[i].Start, expectedRanges[i].End)
					}
				}
			},
		},
		{
			name: "nodes map contains all nodes",
			input: `07c37dfeb235213a872192d05877c5d02d9a7e1f node1.example.com:6379@16379 master - 0 1538428698000 1 connected 0-5460
e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca node2.example.com:6379@16379 replica 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected`,
			expectError: false,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Nodes) != 2 {
					t.Fatalf("Nodes count = %d, want 2", len(topology.Nodes))
				}

				master := topology.Nodes["07c37dfeb235213a872192d05877c5d02d9a7e1f"]
				if master == nil {
					t.Fatal("Master not found in Nodes map")
				}
				if master.Role != NodeRoleMaster {
					t.Errorf("Master role = %s, want master", master.Role)
				}

				replica := topology.Nodes["e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca"]
				if replica == nil {
					t.Fatal("Replica not found in Nodes map")
				}
				if replica.Role != NodeRoleSlave {
					t.Errorf("Replica role = %s, want slave", replica.Role)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseClusterTopology(test.input)

			if test.expectError && err == nil {
				t.Error("Expected error but got none")
				return
			}

			if !test.expectError && err != nil {
				t.Errorf("Unexpected error: %v", err)
				return
			}

			if test.checkTopology != nil && topology != nil {
				test.checkTopology(t, topology)
			}
		})
	}
}
