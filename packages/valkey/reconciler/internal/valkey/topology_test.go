package valkey

import (
	"strings"
	"testing"
)

func TestClusterTopology(t *testing.T) {
	tests := []struct {
		name  string
		nodes []ClusterNode
		check func(t *testing.T, topology Topology, err error)
	}{
		{
			name: "single master no slaves",
			nodes: []ClusterNode{
				{
					ID:        "master1",
					Hostname:  "valkey-0.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
			},
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if len(topology.Masters) != 1 {
					t.Errorf("expected 1 master, got %d", len(topology.Masters))
				}
				if len(topology.Slaves) != 0 {
					t.Errorf("expected 0 slaves, got %d", len(topology.Slaves))
				}
				if len(topology.OrderedNodes) != 1 {
					t.Errorf("expected 1 ordered node, got %d", len(topology.OrderedNodes))
				}
				master, exists := topology.Masters["master1"]
				if !exists {
					t.Fatal("master1 not found in topology")
				}
				if len(master.SlaveIds) != 0 {
					t.Errorf("expected 0 slave IDs, got %d", len(master.SlaveIds))
				}
				if len(topology.OrderedShards) != 1 {
					t.Errorf("expected 1 shard, got %d", len(topology.OrderedShards))
				}
				if len(topology.OrderedShards) > 0 {
					if topology.OrderedShards[0].MasterId != "master1" {
						t.Errorf("expected shard master to be master1, got %s", topology.OrderedShards[0].MasterId)
					}
					if topology.OrderedShards[0].Index != 0 {
						t.Errorf("expected shard index 0, got %d", topology.OrderedShards[0].Index)
					}
				}
			},
		},
		{
			name: "one master with one slave",
			nodes: []ClusterNode{
				{
					ID:        "master1",
					Hostname:  "valkey-0.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "slave1",
					Hostname:  "valkey-1.valkey.default.svc.cluster.local",
					Master:    "master1",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
			},
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if len(topology.Masters) != 1 {
					t.Errorf("expected 1 master, got %d", len(topology.Masters))
				}
				if len(topology.Slaves) != 1 {
					t.Errorf("expected 1 slave, got %d", len(topology.Slaves))
				}
				master, exists := topology.Masters["master1"]
				if !exists {
					t.Fatal("master1 not found")
				}
				if len(master.SlaveIds) != 1 {
					t.Errorf("expected 1 slave ID, got %d", len(master.SlaveIds))
				}
				if master.SlaveIds[0] != "slave1" {
					t.Errorf("expected slave1, got %s", master.SlaveIds[0])
				}
				if len(topology.OrderedShards) != 1 {
					t.Errorf("expected 1 shard, got %d", len(topology.OrderedShards))
				}
				if len(topology.OrderedShards) > 0 {
					if topology.OrderedShards[0].MasterId != "master1" {
						t.Errorf("expected shard master to be master1, got %s", topology.OrderedShards[0].MasterId)
					}
					if topology.OrderedShards[0].Index != 0 {
						t.Errorf("expected shard index 0 (lowest of master and slave), got %d", topology.OrderedShards[0].Index)
					}
				}
			},
		},
		{
			name: "multiple masters with slaves",
			nodes: []ClusterNode{
				{
					ID:        "master1",
					Hostname:  "valkey-0.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "master2",
					Hostname:  "valkey-1.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "slave1",
					Hostname:  "valkey-2.valkey.default.svc.cluster.local",
					Master:    "master1",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
				{
					ID:        "slave2",
					Hostname:  "valkey-3.valkey.default.svc.cluster.local",
					Master:    "master2",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
			},
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if len(topology.Masters) != 2 {
					t.Errorf("expected 2 masters, got %d", len(topology.Masters))
				}
				if len(topology.Slaves) != 2 {
					t.Errorf("expected 2 slaves, got %d", len(topology.Slaves))
				}
				if len(topology.OrderedShards) != 2 {
					t.Errorf("expected 2 shards, got %d", len(topology.OrderedShards))
				}
			},
		},
		{
			name: "slave references non-existent master",
			nodes: []ClusterNode{
				{
					ID:        "master1",
					Hostname:  "valkey-0.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "slave1",
					Hostname:  "valkey-1.valkey.default.svc.cluster.local",
					Master:    "nonexistent",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
			},
			check: func(t *testing.T, topology Topology, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if !strings.Contains(err.Error(), "master nonexistent not found") {
					t.Errorf("expected error about missing master, got: %v", err)
				}
			},
		},
		{
			name: "nodes ordered by index",
			nodes: []ClusterNode{
				{
					ID:        "node2",
					Hostname:  "valkey-2.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "node0",
					Hostname:  "valkey-0.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "node1",
					Hostname:  "valkey-1.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
			},
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if len(topology.OrderedNodes) != 3 {
					t.Fatalf("expected 3 ordered nodes, got %d", len(topology.OrderedNodes))
				}
				if topology.OrderedNodes[0].ID != "node0" {
					t.Errorf("expected node0 at index 0, got %s", topology.OrderedNodes[0].ID)
				}
				if topology.OrderedNodes[1].ID != "node1" {
					t.Errorf("expected node1 at index 1, got %s", topology.OrderedNodes[1].ID)
				}
				if topology.OrderedNodes[2].ID != "node2" {
					t.Errorf("expected node2 at index 2, got %s", topology.OrderedNodes[2].ID)
				}
			},
		},
		{
			name:  "empty nodes",
			nodes: []ClusterNode{},
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if len(topology.Masters) != 0 {
					t.Errorf("expected 0 masters, got %d", len(topology.Masters))
				}
				if len(topology.Slaves) != 0 {
					t.Errorf("expected 0 slaves, got %d", len(topology.Slaves))
				}
				if len(topology.OrderedNodes) != 0 {
					t.Errorf("expected 0 ordered nodes, got %d", len(topology.OrderedNodes))
				}
			},
		},
		{
			name:  "nil nodes slice",
			nodes: nil,
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if topology.OrderedNodes == nil {
					t.Error("expected non-nil OrderedNodes")
				}
			},
		},
		{
			name: "shard index uses lowest index from master and slaves",
			nodes: []ClusterNode{
				{
					ID:        "master1",
					Hostname:  "valkey-5.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "slave1",
					Hostname:  "valkey-2.valkey.default.svc.cluster.local",
					Master:    "master1",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
			},
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if len(topology.OrderedShards) != 1 {
					t.Fatalf("expected 1 shard, got %d", len(topology.OrderedShards))
				}
				shard := topology.OrderedShards[0]
				if shard.Index != 2 {
					t.Errorf("expected shard index 2 (slave has lowest index), got %d", shard.Index)
				}
				if shard.MasterId != "master1" {
					t.Errorf("expected shard master to be master1, got %s", shard.MasterId)
				}
			},
		},
		{
			name: "shards are ordered by index",
			nodes: []ClusterNode{
				{
					ID:        "master1",
					Hostname:  "valkey-4.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "slave1",
					Hostname:  "valkey-5.valkey.default.svc.cluster.local",
					Master:    "master1",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
				{
					ID:        "master2",
					Hostname:  "valkey-0.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "slave2",
					Hostname:  "valkey-1.valkey.default.svc.cluster.local",
					Master:    "master2",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
				{
					ID:        "master3",
					Hostname:  "valkey-2.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "slave3",
					Hostname:  "valkey-3.valkey.default.svc.cluster.local",
					Master:    "master3",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
			},
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if len(topology.OrderedShards) != 3 {
					t.Fatalf("expected 3 shards, got %d", len(topology.OrderedShards))
				}
				for i := 0; i < len(topology.OrderedShards)-1; i++ {
					if topology.OrderedShards[i].Index >= topology.OrderedShards[i+1].Index {
						t.Errorf("shards not ordered: shard[%d].Index=%d >= shard[%d].Index=%d",
							i, topology.OrderedShards[i].Index,
							i+1, topology.OrderedShards[i+1].Index)
					}
				}
				if topology.OrderedShards[0].Index != 0 {
					t.Errorf("expected first shard index 0, got %d", topology.OrderedShards[0].Index)
				}
				if topology.OrderedShards[1].Index != 2 {
					t.Errorf("expected second shard index 2, got %d", topology.OrderedShards[1].Index)
				}
				if topology.OrderedShards[2].Index != 4 {
					t.Errorf("expected third shard index 4, got %d", topology.OrderedShards[2].Index)
				}
			},
		},
		{
			name: "master with multiple slaves",
			nodes: []ClusterNode{
				{
					ID:        "master1",
					Hostname:  "valkey-0.valkey.default.svc.cluster.local",
					Master:    "",
					LinkState: Connected,
					Flags:     []Flag{Master},
				},
				{
					ID:        "slave1",
					Hostname:  "valkey-1.valkey.default.svc.cluster.local",
					Master:    "master1",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
				{
					ID:        "slave2",
					Hostname:  "valkey-2.valkey.default.svc.cluster.local",
					Master:    "master1",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
				{
					ID:        "slave3",
					Hostname:  "valkey-3.valkey.default.svc.cluster.local",
					Master:    "master1",
					LinkState: Connected,
					Flags:     []Flag{Slave},
				},
			},
			check: func(t *testing.T, topology Topology, err error) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				master := topology.Masters["master1"]
				if len(master.SlaveIds) != 3 {
					t.Errorf("expected 3 slaves, got %d", len(master.SlaveIds))
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ClusterTopology(test.nodes)
			test.check(t, topology, err)
		})
	}
}

func TestTopology_IsHealthy(t *testing.T) {
	tests := []struct {
		name     string
		topology Topology
		check    func(t *testing.T, healthy bool, err error)
	}{
		{
			name: "healthy single master",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
				},
				OrderedShards: []Shard{
					{
						Index:    0,
						MasterId: "master1",
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err != nil {
					t.Errorf("expected no error, got: %v", err)
				}
				if !healthy {
					t.Error("expected healthy=true, got false")
				}
			},
		},
		{
			name: "healthy cluster with replicas",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{"slave1"},
					},
					"master2": {
						Node: ClusterNode{
							ID:        "master2",
							Hostname:  "valkey-2.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{"slave2"},
					},
				},
				Slaves: map[string]ClusterNode{
					"slave1": {
						ID:        "slave1",
						Hostname:  "valkey-1.valkey.default.svc.cluster.local",
						Master:    "master1",
						LinkState: Connected,
						Flags:     []Flag{Slave},
					},
					"slave2": {
						ID:        "slave2",
						Hostname:  "valkey-3.valkey.default.svc.cluster.local",
						Master:    "master2",
						LinkState: Connected,
						Flags:     []Flag{Slave},
					},
				},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
					{
						ID:        "slave1",
						Hostname:  "valkey-1.valkey.default.svc.cluster.local",
						Master:    "master1",
						LinkState: Connected,
						Flags:     []Flag{Slave},
					},
					{
						ID:        "master2",
						Hostname:  "valkey-2.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
					{
						ID:        "slave2",
						Hostname:  "valkey-3.valkey.default.svc.cluster.local",
						Master:    "master2",
						LinkState: Connected,
						Flags:     []Flag{Slave},
					},
				},
				OrderedShards: []Shard{
					{
						Index:    0,
						MasterId: "master1",
					},
					{
						Index:    2,
						MasterId: "master2",
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err != nil {
					t.Errorf("expected no error, got: %v", err)
				}
				if !healthy {
					t.Error("expected healthy=true, got false")
				}
			},
		},
		{
			name: "node in fail state",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master, Fail},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master, Fail},
					},
				},
				OrderedShards: []Shard{
					{
						Index:    0,
						MasterId: "master1",
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if healthy {
					t.Error("expected healthy=false, got true")
				}
				if !strings.Contains(err.Error(), "is in fail state") {
					t.Errorf("expected error about fail state, got: %v", err)
				}
			},
		},
		{
			name: "node in pfail state",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master, Pfail},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master, Pfail},
					},
				},
				OrderedShards: []Shard{
					{
						Index:    0,
						MasterId: "master1",
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if healthy {
					t.Error("expected healthy=false, got true")
				}
				if !strings.Contains(err.Error(), "is in fail? state") {
					t.Errorf("expected error about pfail state, got: %v", err)
				}
			},
		},
		{
			name: "node in handshake state",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master, Handshake},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master, Handshake},
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if healthy {
					t.Error("expected healthy=false, got true")
				}
				if !strings.Contains(err.Error(), "is in handshake state") {
					t.Errorf("expected error about handshake state, got: %v", err)
				}
			},
		},
		{
			name: "node in noaddr state",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master, NoAddr},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master, NoAddr},
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if healthy {
					t.Error("expected healthy=false, got true")
				}
				if !strings.Contains(err.Error(), "is in noaddr state") {
					t.Errorf("expected error about noaddr state, got: %v", err)
				}
			},
		},
		{
			name: "node disconnected",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Disconnected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Disconnected,
						Flags:     []Flag{Master},
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if healthy {
					t.Error("expected healthy=false, got true")
				}
				if !strings.Contains(err.Error(), "is disconnected") {
					t.Errorf("expected error about disconnected state, got: %v", err)
				}
			},
		},
		{
			name: "missing node index",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{},
					},
					"master2": {
						Node: ClusterNode{
							ID:        "master2",
							Hostname:  "valkey-2.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
					{
						ID:        "master2",
						Hostname:  "valkey-2.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if healthy {
					t.Error("expected healthy=false, got true")
				}
				if !strings.Contains(err.Error(), "missing node index") {
					t.Errorf("expected error about missing index, got: %v", err)
				}
			},
		},
		{
			name: "uneven replica distribution",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{"slave1"},
					},
					"master2": {
						Node: ClusterNode{
							ID:        "master2",
							Hostname:  "valkey-2.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{
					"slave1": {
						ID:        "slave1",
						Hostname:  "valkey-1.valkey.default.svc.cluster.local",
						Master:    "master1",
						LinkState: Connected,
						Flags:     []Flag{Slave},
					},
				},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
					{
						ID:        "slave1",
						Hostname:  "valkey-1.valkey.default.svc.cluster.local",
						Master:    "master1",
						LinkState: Connected,
						Flags:     []Flag{Slave},
					},
					{
						ID:        "master2",
						Hostname:  "valkey-2.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if healthy {
					t.Error("expected healthy=false, got true")
				}
				if !strings.Contains(err.Error(), "replicas, expected") {
					t.Errorf("expected error about uneven replicas, got: %v", err)
				}
			},
		},
		{
			name: "shard count does not match master count",
			topology: Topology{
				Masters: map[string]masterNode{
					"master1": {
						Node: ClusterNode{
							ID:        "master1",
							Hostname:  "valkey-0.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{},
					},
					"master2": {
						Node: ClusterNode{
							ID:        "master2",
							Hostname:  "valkey-1.valkey.default.svc.cluster.local",
							LinkState: Connected,
							Flags:     []Flag{Master},
						},
						SlaveIds: []string{},
					},
				},
				Slaves: map[string]ClusterNode{},
				OrderedNodes: []ClusterNode{
					{
						ID:        "master1",
						Hostname:  "valkey-0.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
					{
						ID:        "master2",
						Hostname:  "valkey-1.valkey.default.svc.cluster.local",
						LinkState: Connected,
						Flags:     []Flag{Master},
					},
				},
				OrderedShards: []Shard{
					{
						Index:    0,
						MasterId: "master1",
					},
					// Missing shard for master2
				},
			},
			check: func(t *testing.T, healthy bool, err error) {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if healthy {
					t.Error("expected healthy=false, got true")
				}
				if !strings.Contains(err.Error(), "expected 2 shards, got 1") {
					t.Errorf("expected error about shard count mismatch, got: %v", err)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			healthy, err := test.topology.IsHealthy()
			test.check(t, healthy, err)
		})
	}
}
