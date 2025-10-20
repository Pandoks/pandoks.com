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

func TestIsSameTopologyShape(t *testing.T) {
	tests := []struct {
		name     string
		topoA    *ClusterTopology
		topoB    *ClusterTopology
		expected bool
	}{
		{
			name: "identical topologies",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 5461}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 5462, End: 10922}}},
					{ID: "m3", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 10923, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					{ID: "r2", Index: 4, Address: Address{Host: "valkey-4.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
					{ID: "r3", Index: 5, Address: Address{Host: "valkey-5.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m3"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 5461}}},
					"m2": {ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 5462, End: 10922}}},
					"m3": {ID: "m3", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 10923, End: 16383}}},
					"r1": {ID: "r1", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					"r2": {ID: "r2", Index: 4, Address: Address{Host: "valkey-4.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
					"r3": {ID: "r3", Index: 5, Address: Address{Host: "valkey-5.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m3"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "different-m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 5461}}},
					{ID: "different-m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 5462, End: 10922}}},
					{ID: "different-m3", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 10923, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "different-r1", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "different-m1"},
					{ID: "different-r2", Index: 4, Address: Address{Host: "valkey-4.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "different-m2"},
					{ID: "different-r3", Index: 5, Address: Address{Host: "valkey-5.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "different-m3"},
				},
				Nodes: map[string]*ClusterNode{
					"different-m1": {ID: "different-m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 5461}}},
					"different-m2": {ID: "different-m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 5462, End: 10922}}},
					"different-m3": {ID: "different-m3", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 10923, End: 16383}}},
					"different-r1": {ID: "different-r1", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "different-m1"},
					"different-r2": {ID: "different-r2", Index: 4, Address: Address{Host: "valkey-4.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "different-m2"},
					"different-r3": {ID: "different-r3", Index: 5, Address: Address{Host: "valkey-5.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "different-m3"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			expected: true,
		},
		{
			name: "different master count",
			topoA: &ClusterTopology{
				Masters:    []*ClusterNode{{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 16383}}}},
				Replicas:   []*ClusterNode{},
				Nodes:      map[string]*ClusterNode{},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas:   []*ClusterNode{},
				Nodes:      map[string]*ClusterNode{},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			expected: false,
		},
		{
			name: "different replica count",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 16383}}}},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 16383}}},
					"r1": {ID: "r1", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 16383}}}},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					{ID: "r2", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 16383}}},
					"r1": {ID: "r1", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					"r2": {ID: "r2", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			expected: false,
		},
		{
			name: "same shape with different node IDs and addresses",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "old-m1", Address: Address{Host: "valkey-0.old.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "old-m2", Address: Address{Host: "valkey-1.old.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "old-r1", Address: Address{Host: "valkey-2.old.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "old-m1"},
					{ID: "old-r2", Address: Address{Host: "valkey-3.old.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "old-m2"},
				},
				Nodes: map[string]*ClusterNode{
					"old-m1": {ID: "old-m1", Address: Address{Host: "valkey-0.old.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					"old-m2": {ID: "old-m2", Address: Address{Host: "valkey-1.old.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
					"old-r1": {ID: "old-r1", Address: Address{Host: "valkey-2.old.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "old-m1"},
					"old-r2": {ID: "old-r2", Address: Address{Host: "valkey-3.old.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "old-m2"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "new-m1", Address: Address{Host: "valkey-0.new.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "new-m2", Address: Address{Host: "valkey-1.new.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "new-r1", Address: Address{Host: "valkey-2.new.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "new-m1"},
					{ID: "new-r2", Address: Address{Host: "valkey-3.new.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "new-m2"},
				},
				Nodes: map[string]*ClusterNode{
					"new-m1": {ID: "new-m1", Address: Address{Host: "valkey-0.new.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					"new-m2": {ID: "new-m2", Address: Address{Host: "valkey-1.new.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
					"new-r1": {ID: "new-r1", Address: Address{Host: "valkey-2.new.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "new-m1"},
					"new-r2": {ID: "new-r2", Address: Address{Host: "valkey-3.new.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "new-m2"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			expected: true,
		},
		{
			name: "same replica count but different master assignment",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					{ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					"m2": {ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
					"r1": {ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					"r2": {ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					{ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					"m2": {ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
					"r1": {ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					"r2": {ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			expected: false,
		},
		{
			name: "no replicas",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 16383}}},
				},
				Replicas:   []*ClusterNode{},
				Nodes:      map[string]*ClusterNode{},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 16383}}},
				},
				Replicas:   []*ClusterNode{},
				Nodes:      map[string]*ClusterNode{},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			expected: true,
		},
		{
			name: "different slot ranges",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 5000}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 5001, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					{ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 5000}}},
					"m2": {ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 5001, End: 16383}}},
					"r1": {ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					"r2": {ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					{ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					"m2": {ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
					"r1": {ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					"r2": {ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			expected: false,
		},
		{
			name: "multiple slot ranges per master",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 1000}, {Start: 5000, End: 6000}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 1001, End: 4999}, {Start: 6001, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					{ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 1000}, {Start: 5000, End: 6000}}},
					"m2": {ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 1001, End: 4999}, {Start: 6001, End: 16383}}},
					"r1": {ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					"r2": {ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 1000}, {Start: 5000, End: 6000}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 1001, End: 4999}, {Start: 6001, End: 16383}}},
				},
				Replicas: []*ClusterNode{
					{ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					{ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Nodes: map[string]*ClusterNode{
					"m1": {ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 1000}, {Start: 5000, End: 6000}}},
					"m2": {ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 1001, End: 4999}, {Start: 6001, End: 16383}}},
					"r1": {ID: "r1", Index: 2, Address: Address{Host: "valkey-2.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m1"},
					"r2": {ID: "r2", Index: 3, Address: Address{Host: "valkey-3.svc", Port: 6379}, Role: NodeRoleSlave, MasterID: "m2"},
				},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			expected: true,
		},
		{
			name: "topologies with migrations - same migrations",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
				Migrations: func() map[MigrationRoute]*slot.SlotRangeTracker {
					m := map[MigrationRoute]*slot.SlotRangeTracker{}
					tracker := &slot.SlotRangeTracker{}
					tracker.Add(slot.SlotRange{Start: 100, End: 200})
					m[MigrationRoute{SourceIndex: 0, DestinationIndex: 1}] = tracker
					return m
				}(),
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
				Migrations: func() map[MigrationRoute]*slot.SlotRangeTracker {
					m := map[MigrationRoute]*slot.SlotRangeTracker{}
					tracker := &slot.SlotRangeTracker{}
					tracker.Add(slot.SlotRange{Start: 100, End: 200})
					m[MigrationRoute{SourceIndex: 0, DestinationIndex: 1}] = tracker
					return m
				}(),
			},
			expected: true,
		},
		{
			name: "topologies with migrations - different migration routes",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
				Migrations: func() map[MigrationRoute]*slot.SlotRangeTracker {
					m := map[MigrationRoute]*slot.SlotRangeTracker{}
					tracker := &slot.SlotRangeTracker{}
					tracker.Add(slot.SlotRange{Start: 100, End: 200})
					m[MigrationRoute{SourceIndex: 0, DestinationIndex: 1}] = tracker
					return m
				}(),
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
				Migrations: func() map[MigrationRoute]*slot.SlotRangeTracker {
					m := map[MigrationRoute]*slot.SlotRangeTracker{}
					tracker := &slot.SlotRangeTracker{}
					tracker.Add(slot.SlotRange{Start: 100, End: 200})
					m[MigrationRoute{SourceIndex: 1, DestinationIndex: 0}] = tracker
					return m
				}(),
			},
			expected: false,
		},
		{
			name: "topologies with migrations - different slot ranges",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
				Migrations: func() map[MigrationRoute]*slot.SlotRangeTracker {
					m := map[MigrationRoute]*slot.SlotRangeTracker{}
					tracker := &slot.SlotRangeTracker{}
					tracker.Add(slot.SlotRange{Start: 100, End: 200})
					m[MigrationRoute{SourceIndex: 0, DestinationIndex: 1}] = tracker
					return m
				}(),
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
				Migrations: func() map[MigrationRoute]*slot.SlotRangeTracker {
					m := map[MigrationRoute]*slot.SlotRangeTracker{}
					tracker := &slot.SlotRangeTracker{}
					tracker.Add(slot.SlotRange{Start: 100, End: 300})
					m[MigrationRoute{SourceIndex: 0, DestinationIndex: 1}] = tracker
					return m
				}(),
			},
			expected: false,
		},
		{
			name: "different migration count",
			topoA: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas:   []*ClusterNode{},
				Nodes:      map[string]*ClusterNode{},
				Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
			},
			topoB: &ClusterTopology{
				Masters: []*ClusterNode{
					{ID: "m1", Index: 0, Address: Address{Host: "valkey-0.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}}},
					{ID: "m2", Index: 1, Address: Address{Host: "valkey-1.svc", Port: 6379}, Role: NodeRoleMaster, SlotRanges: []slot.SlotRange{{Start: 8192, End: 16383}}},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
				Migrations: func() map[MigrationRoute]*slot.SlotRangeTracker {
					m := map[MigrationRoute]*slot.SlotRangeTracker{}
					tracker := &slot.SlotRangeTracker{}
					tracker.Add(slot.SlotRange{Start: 100, End: 200})
					m[MigrationRoute{SourceIndex: 0, DestinationIndex: 1}] = tracker
					return m
				}(),
			},
			expected: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := IsSameTopologyShape(test.topoA, test.topoB)
			if result != test.expected {
				t.Errorf("IsSameTopologyShape() = %v, want %v", result, test.expected)
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
						expectedID = "replica-0-0-3"
						expectedMasterID = "master-0"
					case 1:
						expectedID = "replica-1-0-4"
						expectedMasterID = "master-1"
					case 2:
						expectedID = "replica-2-0-5"
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
					"replica-0-0-3", "replica-0-1-4",
					"replica-1-0-5", "replica-1-1-6",
					"replica-2-0-7", "replica-2-1-8",
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
						statefulsetIndex := 5 + (i * 3) + j
						expectedReplicaID := fmt.Sprintf("replica-%d-%d-%d", i, j, statefulsetIndex)

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
				if topology.Nodes["replica-0-0-2"] != topology.Replicas[0] {
					t.Error("Nodes map doesn't contain replica-0-0-2")
				}
				if topology.Nodes["replica-1-0-3"] != topology.Replicas[1] {
					t.Error("Nodes map doesn't contain replica-1-0-3")
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

func TestAddress_Index(t *testing.T) {
	tests := []struct {
		name    string
		address Address
		want    int
	}{
		{
			name: "valid statefulset FQDN with index 0",
			address: Address{
				Host: "valkey-0.valkey-headless-example.default.svc.cluster.local",
				Port: 6379,
			},
			want: 0,
		},
		{
			name: "valid statefulset FQDN with index 5",
			address: Address{
				Host: "valkey-5.valkey-headless-example.default.svc.cluster.local",
				Port: 6379,
			},
			want: 5,
		},
		{
			name: "valid statefulset FQDN with index 42",
			address: Address{
				Host: "my-cluster-valkey-42.my-valkey-headless.namespace.svc.cluster.local",
				Port: 6379,
			},
			want: 42,
		},
		{
			name: "valid statefulset FQDN with index 100",
			address: Address{
				Host: "redis-cluster-100.redis-headless.prod.svc.cluster.local",
				Port: 6379,
			},
			want: 100,
		},
		{
			name: "short hostname with index",
			address: Address{
				Host: "valkey-3",
				Port: 6379,
			},
			want: 3,
		},
		{
			name: "hostname with only pod name",
			address: Address{
				Host: "pod-7",
				Port: 6379,
			},
			want: 7,
		},
		{
			name: "invalid hostname - no index",
			address: Address{
				Host: "valkey-abc.service.namespace.svc.cluster.local",
				Port: 6379,
			},
			want: -1,
		},
		{
			name: "invalid hostname - empty",
			address: Address{
				Host: "",
				Port: 6379,
			},
			want: -1,
		},
		{
			name: "invalid hostname - no hyphen",
			address: Address{
				Host: "valkey0.service.namespace.svc.cluster.local",
				Port: 6379,
			},
			want: -1,
		},
		{
			name: "hostname with multiple hyphens in pod name",
			address: Address{
				Host: "my-valkey-cluster-15.service.namespace.svc.cluster.local",
				Port: 6379,
			},
			want: 15,
		},
		{
			name: "single character hostname",
			address: Address{
				Host: "a",
				Port: 6379,
			},
			want: -1,
		},
		{
			name: "double hyphen in statefulset name",
			address: Address{
				Host: "valkey--cluster-5.service.namespace.svc.cluster.local",
				Port: 6379,
			},
			want: 5,
		},
		{
			name: "double period in FQDN",
			address: Address{
				Host: "valkey-3..service.namespace.svc.cluster.local",
				Port: 6379,
			},
			want: 3,
		},
		{
			name: "trailing period in FQDN",
			address: Address{
				Host: "valkey-8.service.namespace.svc.cluster.local.",
				Port: 6379,
			},
			want: 8,
		},
		{
			name: "only statefulset pod name with trailing hyphen and number",
			address: Address{
				Host: "valkey--5",
				Port: 6379,
			},
			want: 5,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := test.address.Index()

			if test.want == -1 {
				if err == nil {
					t.Errorf("Index() error = nil, want error")
				}
				return
			}

			if err != nil {
				t.Errorf("Index() error = %v, want nil", err)
				return
			}

			if got != test.want {
				t.Errorf("Index() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestMatchNodes(t *testing.T) {
	tests := []struct {
		name            string
		nodeA           *ClusterNode
		nodeB           *ClusterNode
		clusterNodeMapA ClusterNodeMap
		clusterNodeMapB ClusterNodeMap
		expectedMatch   bool
		expectError     bool
	}{
		{
			name: "matching master nodes with same index and slots",
			nodeA: &ClusterNode{
				ID:         "master-0",
				Index:      0,
				Address:    Address{Host: "valkey-0.svc", Port: 6379},
				Role:       NodeRoleMaster,
				SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}},
			},
			nodeB: &ClusterNode{
				ID:         "different-master-0",
				Index:      0,
				Address:    Address{Host: "valkey-0.svc", Port: 6379},
				Role:       NodeRoleMaster,
				SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}},
			},
			clusterNodeMapA: ClusterNodeMap{},
			clusterNodeMapB: ClusterNodeMap{},
			expectedMatch:   true,
			expectError:     false,
		},
		{
			name: "master nodes with different indices",
			nodeA: &ClusterNode{
				ID:         "master-0",
				Index:      0,
				Address:    Address{Host: "valkey-0.svc", Port: 6379},
				Role:       NodeRoleMaster,
				SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}},
			},
			nodeB: &ClusterNode{
				ID:         "master-1",
				Index:      1,
				Address:    Address{Host: "valkey-1.svc", Port: 6379},
				Role:       NodeRoleMaster,
				SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}},
			},
			clusterNodeMapA: ClusterNodeMap{},
			clusterNodeMapB: ClusterNodeMap{},
			expectedMatch:   false,
			expectError:     false,
		},
		{
			name: "master nodes with different slot ranges",
			nodeA: &ClusterNode{
				ID:         "master-0",
				Index:      0,
				Address:    Address{Host: "valkey-0.svc", Port: 6379},
				Role:       NodeRoleMaster,
				SlotRanges: []slot.SlotRange{{Start: 0, End: 5000}},
			},
			nodeB: &ClusterNode{
				ID:         "master-0",
				Index:      0,
				Address:    Address{Host: "valkey-0.svc", Port: 6379},
				Role:       NodeRoleMaster,
				SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}},
			},
			clusterNodeMapA: ClusterNodeMap{},
			clusterNodeMapB: ClusterNodeMap{},
			expectedMatch:   false,
			expectError:     false,
		},
		{
			name: "master nodes with different role",
			nodeA: &ClusterNode{
				ID:         "master-0",
				Index:      0,
				Address:    Address{Host: "valkey-0.svc", Port: 6379},
				Role:       NodeRoleMaster,
				SlotRanges: []slot.SlotRange{{Start: 0, End: 8191}},
			},
			nodeB: &ClusterNode{
				ID:       "replica-0",
				Index:    0,
				Address:  Address{Host: "valkey-0.svc", Port: 6379},
				Role:     NodeRoleSlave,
				MasterID: "master-0",
			},
			clusterNodeMapA: ClusterNodeMap{},
			clusterNodeMapB: ClusterNodeMap{},
			expectedMatch:   false,
			expectError:     false,
		},
		{
			name: "matching replica nodes pointing to same master index",
			nodeA: &ClusterNode{
				ID:       "replica-0",
				Index:    2,
				Address:  Address{Host: "valkey-2.svc", Port: 6379},
				Role:     NodeRoleSlave,
				MasterID: "master-0",
			},
			nodeB: &ClusterNode{
				ID:       "different-replica-0",
				Index:    2,
				Address:  Address{Host: "valkey-2.svc", Port: 6379},
				Role:     NodeRoleSlave,
				MasterID: "different-master-0",
			},
			clusterNodeMapA: ClusterNodeMap{
				"master-0": {
					ID:      "master-0",
					Index:   0,
					Address: Address{Host: "valkey-0.svc", Port: 6379},
					Role:    NodeRoleMaster,
				},
			},
			clusterNodeMapB: ClusterNodeMap{
				"different-master-0": {
					ID:      "different-master-0",
					Index:   0,
					Address: Address{Host: "valkey-0.svc", Port: 6379},
					Role:    NodeRoleMaster,
				},
			},
			expectedMatch: true,
			expectError:   false,
		},
		{
			name: "replica nodes pointing to different master indices",
			nodeA: &ClusterNode{
				ID:       "replica-0",
				Index:    2,
				Address:  Address{Host: "valkey-2.svc", Port: 6379},
				Role:     NodeRoleSlave,
				MasterID: "master-0",
			},
			nodeB: &ClusterNode{
				ID:       "replica-1",
				Index:    2,
				Address:  Address{Host: "valkey-2.svc", Port: 6379},
				Role:     NodeRoleSlave,
				MasterID: "master-1",
			},
			clusterNodeMapA: ClusterNodeMap{
				"master-0": {
					ID:      "master-0",
					Index:   0,
					Address: Address{Host: "valkey-0.svc", Port: 6379},
					Role:    NodeRoleMaster,
				},
			},
			clusterNodeMapB: ClusterNodeMap{
				"master-1": {
					ID:      "master-1",
					Index:   1,
					Address: Address{Host: "valkey-1.svc", Port: 6379},
					Role:    NodeRoleMaster,
				},
			},
			expectedMatch: false,
			expectError:   false,
		},
		{
			name: "replica nodes with different statefulset indices",
			nodeA: &ClusterNode{
				ID:       "replica-0",
				Index:    2,
				Address:  Address{Host: "valkey-2.svc", Port: 6379},
				Role:     NodeRoleSlave,
				MasterID: "master-0",
			},
			nodeB: &ClusterNode{
				ID:       "replica-1",
				Index:    3,
				Address:  Address{Host: "valkey-3.svc", Port: 6379},
				Role:     NodeRoleSlave,
				MasterID: "master-0",
			},
			clusterNodeMapA: ClusterNodeMap{
				"master-0": {
					ID:      "master-0",
					Index:   0,
					Address: Address{Host: "valkey-0.svc", Port: 6379},
					Role:    NodeRoleMaster,
				},
			},
			clusterNodeMapB: ClusterNodeMap{
				"master-0": {
					ID:      "master-0",
					Index:   0,
					Address: Address{Host: "valkey-0.svc", Port: 6379},
					Role:    NodeRoleMaster,
				},
			},
			expectedMatch: false,
			expectError:   false,
		},
		{
			name: "master nodes with multiple slot ranges",
			nodeA: &ClusterNode{
				ID:      "master-0",
				Index:   0,
				Address: Address{Host: "valkey-0.svc", Port: 6379},
				Role:    NodeRoleMaster,
				SlotRanges: []slot.SlotRange{
					{Start: 0, End: 1000},
					{Start: 5000, End: 6000},
				},
			},
			nodeB: &ClusterNode{
				ID:      "master-0",
				Index:   0,
				Address: Address{Host: "valkey-0.svc", Port: 6379},
				Role:    NodeRoleMaster,
				SlotRanges: []slot.SlotRange{
					{Start: 0, End: 1000},
					{Start: 5000, End: 6000},
				},
			},
			clusterNodeMapA: ClusterNodeMap{},
			clusterNodeMapB: ClusterNodeMap{},
			expectedMatch:   true,
			expectError:     false,
		},
		{
			name: "master nodes with different number of slot ranges",
			nodeA: &ClusterNode{
				ID:      "master-0",
				Index:   0,
				Address: Address{Host: "valkey-0.svc", Port: 6379},
				Role:    NodeRoleMaster,
				SlotRanges: []slot.SlotRange{
					{Start: 0, End: 1000},
				},
			},
			nodeB: &ClusterNode{
				ID:      "master-0",
				Index:   0,
				Address: Address{Host: "valkey-0.svc", Port: 6379},
				Role:    NodeRoleMaster,
				SlotRanges: []slot.SlotRange{
					{Start: 0, End: 1000},
					{Start: 5000, End: 6000},
				},
			},
			clusterNodeMapA: ClusterNodeMap{},
			clusterNodeMapB: ClusterNodeMap{},
			expectedMatch:   false,
			expectError:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			match, err := matchNodes(test.nodeA, test.nodeB, test.clusterNodeMapA, test.clusterNodeMapB)

			if test.expectError && err == nil {
				t.Errorf("matchNodes() expected error but got nil")
			}
			if !test.expectError && err != nil {
				t.Errorf("matchNodes() unexpected error: %v", err)
			}
			if match != test.expectedMatch {
				t.Errorf("matchNodes() = %v, want %v", match, test.expectedMatch)
			}
		})
	}
}
