package cluster

import (
	"fmt"
	"testing"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/slot"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestSlotRanges(t *testing.T) {
	tests := []struct {
		name       string
		numMasters int32
		want       []slot.SlotRange
	}{
		{
			name:       "1 master",
			numMasters: 1,
			want: []slot.SlotRange{
				{Start: 0, End: 16383},
			},
		},
		{
			name:       "2 masters",
			numMasters: 2,
			want: []slot.SlotRange{
				{Start: 0, End: 8191},
				{Start: 8192, End: 16383},
			},
		},
		{
			name:       "3 masters",
			numMasters: 3,
			want: []slot.SlotRange{
				{Start: 0, End: 5461},
				{Start: 5462, End: 10922},
				{Start: 10923, End: 16383},
			},
		},
		{
			name:       "4 masters",
			numMasters: 4,
			want: []slot.SlotRange{
				{Start: 0, End: 4095},
				{Start: 4096, End: 8191},
				{Start: 8192, End: 12287},
				{Start: 12288, End: 16383},
			},
		},
		{
			name:       "5 masters (uneven distribution)",
			numMasters: 5,
			want: []slot.SlotRange{
				{Start: 0, End: 3276},
				{Start: 3277, End: 6553},
				{Start: 6554, End: 9830},
				{Start: 9831, End: 13107},
				{Start: 13108, End: 16383},
			},
		},
		{
			name:       "6 masters",
			numMasters: 6,
			want: []slot.SlotRange{
				{Start: 0, End: 2730},
				{Start: 2731, End: 5461},
				{Start: 5462, End: 8192},
				{Start: 8193, End: 10923},
				{Start: 10924, End: 13653},
				{Start: 13654, End: 16383},
			},
		},
		{
			name:       "10 masters",
			numMasters: 10,
			want: []slot.SlotRange{
				{Start: 0, End: 1638},
				{Start: 1639, End: 3277},
				{Start: 3278, End: 4916},
				{Start: 4917, End: 6555},
				{Start: 6556, End: 8193},
				{Start: 8194, End: 9831},
				{Start: 9832, End: 11469},
				{Start: 11470, End: 13107},
				{Start: 13108, End: 14745},
				{Start: 14746, End: 16383},
			},
		},
		{
			name:       "16 masters (evenly divisible)",
			numMasters: 16,
			want: []slot.SlotRange{
				{Start: 0, End: 1023},
				{Start: 1024, End: 2047},
				{Start: 2048, End: 3071},
				{Start: 3072, End: 4095},
				{Start: 4096, End: 5119},
				{Start: 5120, End: 6143},
				{Start: 6144, End: 7167},
				{Start: 7168, End: 8191},
				{Start: 8192, End: 9215},
				{Start: 9216, End: 10239},
				{Start: 10240, End: 11263},
				{Start: 11264, End: 12287},
				{Start: 12288, End: 13311},
				{Start: 13312, End: 14335},
				{Start: 14336, End: 15359},
				{Start: 15360, End: 16383},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			slotRanges := slot.DesiredSlotRangesFromMasterCount(test.numMasters)

			if len(slotRanges) != len(test.want) {
				t.Fatalf("slotRanges() returned %d ranges, want %d", len(slotRanges), len(test.want))
			}

			totalSlots := 0
			for i, slotRange := range slotRanges {
				if slotRange.Start != test.want[i].Start {
					t.Errorf("Range[%d].Start = %d, want %d", i, slotRange.Start, test.want[i].Start)
				}
				if slotRange.End != test.want[i].End {
					t.Errorf("Range[%d].End = %d, want %d", i, slotRange.End, test.want[i].End)
				}

				rangeSize := slotRange.End - slotRange.Start + 1
				totalSlots += rangeSize

				if rangeSize <= 0 {
					t.Errorf("Range[%d] has invalid size: %d (Start=%d, End=%d)",
						i, rangeSize, slotRange.Start, slotRange.End)
				}
			}

			if totalSlots != 16384 {
				t.Errorf("Total slots = %d, want 16384", totalSlots)
			}

			for i := 1; i < len(slotRanges); i++ {
				if slotRanges[i-1].End+1 != slotRanges[i].Start {
					t.Errorf("Gap or overlap between ranges: Range[%d].End=%d, Range[%d].Start=%d",
						i-1, slotRanges[i-1].End, i, slotRanges[i].Start)
				}
			}

			if slotRanges[0].Start != 0 {
				t.Errorf("First range should start at 0, got %d", slotRanges[0].Start)
			}

			if slotRanges[len(slotRanges)-1].End != 16383 {
				t.Errorf("Last range should end at 16383, got %d", slotRanges[len(slotRanges)-1].End)
			}
		})
	}
}

func TestDesiredTopology(t *testing.T) {
	tests := []struct {
		name              string
		masters           int32
		replicasPerMaster int32
		checkTopology     func(*testing.T, *ClusterTopology)
	}{
		{
			name:              "3 masters, 1 replica per master",
			masters:           3,
			replicasPerMaster: 1,
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

				for i, master := range topology.Masters {
					var expectedID string
					switch i {
					case 0:
						expectedID = "master-0"
					case 1:
						expectedID = "master-1"
					case 2:
						expectedID = "master-2"
					}
					if master.ID != expectedID {
						t.Errorf("Master[%d].ID = %s, want %s", i, master.ID, expectedID)
					}
					if master.Role != NodeRoleMaster {
						t.Errorf("Master[%d].Role = %s, want master", i, master.Role)
					}
					if len(master.SlotRanges) != 1 {
						t.Errorf("Master[%d] has %d slot ranges, want 1", i, len(master.SlotRanges))
					}
				}

				if topology.Masters[0].SlotRanges[0].Start != 0 {
					t.Errorf("Master 0 slot range start = %d, want 0", topology.Masters[0].SlotRanges[0].Start)
				}
				if topology.Masters[2].SlotRanges[0].End != 16383 {
					t.Errorf("Master 2 slot range end = %d, want 16383", topology.Masters[2].SlotRanges[0].End)
				}

				for i, replica := range topology.Replicas {
					var expectedID, expectedMasterID string
					switch i {
					case 0:
						expectedID = "replica-0-0"
						expectedMasterID = "master-0"
					case 1:
						expectedID = "replica-1-0"
						expectedMasterID = "master-1"
					case 2:
						expectedID = "replica-2-0"
						expectedMasterID = "master-2"
					}
					if replica.ID != expectedID {
						t.Errorf("Replica[%d].ID = %s, want %s", i, replica.ID, expectedID)
					}
					if replica.Role != NodeRoleSlave {
						t.Errorf("Replica[%d].Role = %s, want slave", i, replica.Role)
					}
					if replica.MasterID != expectedMasterID {
						t.Errorf("Replica[%d].MasterID = %s, want %s", i, replica.MasterID, expectedMasterID)
					}
				}
			},
		},
		{
			name:              "1 master, 0 replicas",
			masters:           1,
			replicasPerMaster: 0,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 1 {
					t.Errorf("Masters count = %d, want 1", len(topology.Masters))
				}
				if len(topology.Replicas) != 0 {
					t.Errorf("Replicas count = %d, want 0", len(topology.Replicas))
				}
				if len(topology.Nodes) != 1 {
					t.Errorf("Nodes count = %d, want 1", len(topology.Nodes))
				}

				master := topology.Masters[0]
				if master.ID != "master-0" {
					t.Errorf("Master ID = %s, want master-0", master.ID)
				}
				if len(master.SlotRanges) != 1 {
					t.Fatalf("Master has %d slot ranges, want 1", len(master.SlotRanges))
				}
				if master.SlotRanges[0].Start != 0 || master.SlotRanges[0].End != 16383 {
					t.Errorf("Master slot range = [%d-%d], want [0-16383]",
						master.SlotRanges[0].Start, master.SlotRanges[0].End)
				}
			},
		},
		{
			name:              "3 masters, 2 replicas per master",
			masters:           3,
			replicasPerMaster: 2,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 3 {
					t.Errorf("Masters count = %d, want 3", len(topology.Masters))
				}
				if len(topology.Replicas) != 6 {
					t.Errorf("Replicas count = %d, want 6", len(topology.Replicas))
				}
				if len(topology.Nodes) != 9 {
					t.Errorf("Nodes count = %d, want 9", len(topology.Nodes))
				}

				replicaIDs := []string{
					"replica-0-0", "replica-0-1",
					"replica-1-0", "replica-1-1",
					"replica-2-0", "replica-2-1",
				}
				masterIDs := []string{
					"master-0", "master-0",
					"master-1", "master-1",
					"master-2", "master-2",
				}

				for i, replica := range topology.Replicas {
					if replica.ID != replicaIDs[i] {
						t.Errorf("Replica[%d].ID = %s, want %s", i, replica.ID, replicaIDs[i])
					}
					if replica.MasterID != masterIDs[i] {
						t.Errorf("Replica[%d].MasterID = %s, want %s", i, replica.MasterID, masterIDs[i])
					}
				}
			},
		},
		{
			name:              "5 masters, 3 replicas per master",
			masters:           5,
			replicasPerMaster: 3,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if len(topology.Masters) != 5 {
					t.Errorf("Masters count = %d, want 5", len(topology.Masters))
				}
				if len(topology.Replicas) != 15 {
					t.Errorf("Replicas count = %d, want 15", len(topology.Replicas))
				}
				if len(topology.Nodes) != 20 {
					t.Errorf("Nodes count = %d, want 20", len(topology.Nodes))
				}

				for i := range int32(5) {
					expectedMasterID := fmt.Sprintf("master-%d", i)
					if topology.Masters[i].ID != expectedMasterID {
						t.Errorf("Master[%d].ID = %s, want %s", i, topology.Masters[i].ID, expectedMasterID)
					}

					for j := range int32(3) {
						replicaIndex := 3*i + j
						replica := topology.Replicas[replicaIndex]
						expectedReplicaID := fmt.Sprintf("replica-%d-%d", i, j)

						if replica.ID != expectedReplicaID {
							t.Errorf("Replica[%d].ID = %s, want %s", replicaIndex, replica.ID, expectedReplicaID)
						}
						if replica.MasterID != expectedMasterID {
							t.Errorf("Replica[%d].MasterID = %s, want %s", replicaIndex, replica.MasterID, expectedMasterID)
						}
					}
				}
			},
		},
		{
			name:              "nodes map contains all nodes",
			masters:           2,
			replicasPerMaster: 1,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				if topology.Nodes["master-0"] != topology.Masters[0] {
					t.Error("Nodes map doesn't contain master-0")
				}
				if topology.Nodes["master-1"] != topology.Masters[1] {
					t.Error("Nodes map doesn't contain master-1")
				}
				if topology.Nodes["replica-0-0"] != topology.Replicas[0] {
					t.Error("Nodes map doesn't contain replica-0-0")
				}
				if topology.Nodes["replica-1-0"] != topology.Replicas[1] {
					t.Error("Nodes map doesn't contain replica-1-0")
				}

				for _, master := range topology.Masters {
					if node, exists := topology.Nodes[master.ID]; !exists {
						t.Errorf("Master %s not in Nodes map", master.ID)
					} else if node != master {
						t.Errorf("Nodes[%s] doesn't point to same master object", master.ID)
					}
				}

				for _, replica := range topology.Replicas {
					if node, exists := topology.Nodes[replica.ID]; !exists {
						t.Errorf("Replica %s not in Nodes map", replica.ID)
					} else if node != replica {
						t.Errorf("Nodes[%s] doesn't point to same replica object", replica.ID)
					}
				}
			},
		},
		{
			name:              "slot ranges are correct for 6 masters",
			masters:           6,
			replicasPerMaster: 0,
			checkTopology: func(t *testing.T, topology *ClusterTopology) {
				expectedRanges := []slot.SlotRange{
					{Start: 0, End: 2730},
					{Start: 2731, End: 5461},
					{Start: 5462, End: 8192},
					{Start: 8193, End: 10923},
					{Start: 10924, End: 13653},
					{Start: 13654, End: 16383},
				}

				for i, master := range topology.Masters {
					if len(master.SlotRanges) != 1 {
						t.Errorf("Master[%d] has %d slot ranges, want 1", i, len(master.SlotRanges))
						continue
					}
					if master.SlotRanges[0] != expectedRanges[i] {
						t.Errorf("Master[%d] slot range = [%d-%d], want [%d-%d]",
							i, master.SlotRanges[0].Start, master.SlotRanges[0].End,
							expectedRanges[i].Start, expectedRanges[i].End)
					}
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			valkeyCluster := &valkeyv1.ValkeyCluster{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "test-cluster",
					Namespace: "default",
				},
				Spec: valkeyv1.ValkeyClusterSpec{
					Masters:           test.masters,
					ReplicasPerMaster: test.replicasPerMaster,
				},
			}

			topology := DesiredTopology(valkeyCluster)

			if topology == nil {
				t.Fatal("desiredTopology() returned nil")
			}

			test.checkTopology(t, topology)
		})
	}
}
