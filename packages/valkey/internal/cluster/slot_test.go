package cluster

import (
	"testing"
	internalslot "valkey/operator/internal/slot"
)

func TestSlotBitset(t *testing.T) {
	tests := []struct {
		name          string
		slotsToSet    []int
		slotsToCheck  []int
		expectedIsSet []bool
	}{
		{
			name:          "empty bitset - all slots unset",
			slotsToSet:    []int{},
			slotsToCheck:  []int{0, 100, 8191, 16383},
			expectedIsSet: []bool{false, false, false, false},
		},
		{
			name:          "set single slot - slot 0",
			slotsToSet:    []int{0},
			slotsToCheck:  []int{0, 1, 100},
			expectedIsSet: []bool{true, false, false},
		},
		{
			name:          "set single slot - slot 16383 (last slot)",
			slotsToSet:    []int{16383},
			slotsToCheck:  []int{16382, 16383, 0},
			expectedIsSet: []bool{false, true, false},
		},
		{
			name:          "set multiple slots in same uint64 bucket",
			slotsToSet:    []int{0, 1, 2, 63},
			slotsToCheck:  []int{0, 1, 2, 3, 63, 64},
			expectedIsSet: []bool{true, true, true, false, true, false},
		},
		{
			name:          "set slots across different uint64 buckets",
			slotsToSet:    []int{0, 64, 128, 8192, 16383},
			slotsToCheck:  []int{0, 63, 64, 127, 128, 8192, 16383},
			expectedIsSet: []bool{true, false, true, false, true, true, true},
		},
		{
			name:          "set boundary slots - 63, 64, 65",
			slotsToSet:    []int{63, 64, 65},
			slotsToCheck:  []int{62, 63, 64, 65, 66},
			expectedIsSet: []bool{false, true, true, true, false},
		},
		{
			name: "set all slots in first bucket (0-63)",
			slotsToSet: func() []int {
				slots := make([]int, 64)
				for i := range slots {
					slots[i] = i
				}
				return slots
			}(),
			slotsToCheck:  []int{0, 31, 63, 64},
			expectedIsSet: []bool{true, true, true, false},
		},
		{
			name: "set all slots in last bucket (16320-16383)",
			slotsToSet: func() []int {
				slots := make([]int, 64)
				for i := range slots {
					slots[i] = 16320 + i
				}
				return slots
			}(),
			slotsToCheck:  []int{16319, 16320, 16350, 16383},
			expectedIsSet: []bool{false, true, true, true},
		},
		{
			name:          "set random pattern of slots",
			slotsToSet:    []int{10, 100, 1000, 5000, 8192, 10000, 15000},
			slotsToCheck:  []int{10, 11, 100, 999, 1000, 5000, 8192, 10000, 15000, 16383},
			expectedIsSet: []bool{true, false, true, false, true, true, true, true, true, false},
		},
		{
			name:          "set same slot multiple times",
			slotsToSet:    []int{42, 42, 42},
			slotsToCheck:  []int{41, 42, 43},
			expectedIsSet: []bool{false, true, false},
		},
		{
			name:          "set consecutive range",
			slotsToSet:    []int{100, 101, 102, 103, 104, 105},
			slotsToCheck:  []int{99, 100, 103, 105, 106},
			expectedIsSet: []bool{false, true, true, true, false},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var bitset SlotBitset

			// Set the slots
			for _, slot := range tt.slotsToSet {
				bitset.Set(slot)
			}

			// Check the slots
			for i, slot := range tt.slotsToCheck {
				got := bitset.IsSet(slot)
				want := tt.expectedIsSet[i]
				if got != want {
					t.Errorf("IsSet(%d) = %v, want %v", slot, got, want)
				}
			}
		})
	}
}

func TestSlotBitset_AllSlots(t *testing.T) {
	var bitset SlotBitset

	// Set all 16384 slots
	for i := 0; i < 16384; i++ {
		bitset.Set(i)
	}

	// Verify all slots are set
	for i := 0; i < 16384; i++ {
		if !bitset.IsSet(i) {
			t.Errorf("Slot %d should be set but isn't", i)
		}
	}
}

func TestSlotBitset_EdgeCases(t *testing.T) {
	t.Run("slot 0", func(t *testing.T) {
		var bitset SlotBitset
		if bitset.IsSet(0) {
			t.Error("Slot 0 should be unset initially")
		}
		bitset.Set(0)
		if !bitset.IsSet(0) {
			t.Error("Slot 0 should be set after Set(0)")
		}
	})

	t.Run("slot 16383", func(t *testing.T) {
		var bitset SlotBitset
		if bitset.IsSet(16383) {
			t.Error("Slot 16383 should be unset initially")
		}
		bitset.Set(16383)
		if !bitset.IsSet(16383) {
			t.Error("Slot 16383 should be set after Set(16383)")
		}
	})

	t.Run("bucket boundaries", func(t *testing.T) {
		// Test boundaries of each uint64 bucket (every 64 slots)
		for bucket := 0; bucket < 256; bucket++ {
			var bitset SlotBitset // Create a fresh bitset for each bucket

			slotStart := bucket * 64
			slotEnd := slotStart + 63

			bitset.Set(slotStart)
			bitset.Set(slotEnd)

			if !bitset.IsSet(slotStart) {
				t.Errorf("Slot %d (bucket %d start) should be set", slotStart, bucket)
			}
			if !bitset.IsSet(slotEnd) {
				t.Errorf("Slot %d (bucket %d end) should be set", slotEnd, bucket)
			}

			// Check that adjacent slots aren't accidentally set
			if slotStart > 0 && bitset.IsSet(slotStart-1) {
				t.Errorf("Slot %d should not be set", slotStart-1)
			}
			if slotEnd < 16383 && bitset.IsSet(slotEnd+1) {
				t.Errorf("Slot %d should not be set", slotEnd+1)
			}
		}
	})
}

func TestCalculateSlotsToReconcile(t *testing.T) {
	tests := []struct {
		name                string
		currentTopology     *ClusterTopology
		desiredTopology     *ClusterTopology
		wantMasterAddSlots  []*internalslot.SlotRangeTracker
		wantMigrationRoutes map[MigrationRoute]*internalslot.SlotRangeTracker
		wantErr             bool
		errMsg              string
	}{
		{
			name: "no changes needed - already in sync",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots:  []*internalslot.SlotRangeTracker{nil, nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{},
			wantErr:             false,
		},
		{
			name: "all slots unassigned - need to add all slots",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{
				func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 0; i <= 8191; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
				func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 8192; i <= 16383; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{},
			wantErr:             false,
		},
		{
			name: "need migration from master 0 to master 1",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 12287}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 12288, End: 16383}},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{nil, nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{
				{SourceIndex: 0, DestinationIndex: 1}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 8192; i <= 12287; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantErr: false,
		},
		{
			name: "need migration from master 1 to master 0",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 4095}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 4096, End: 16383}},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{nil, nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{
				{SourceIndex: 1, DestinationIndex: 0}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 4096; i <= 8191; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantErr: false,
		},
		{
			name: "complex rebalance with 3 masters",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 10922}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 10923, End: 13107}},
					},
					{
						ID:         "m3",
						Index:      2,
						Address:    Address{Host: "valkey-2.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 13108, End: 16383}},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 5461}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 5462, End: 10922}},
					},
					{
						ID:         "m3",
						Index:      2,
						Address:    Address{Host: "valkey-2.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 10923, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{nil, nil, nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{
				{SourceIndex: 0, DestinationIndex: 1}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 5462; i <= 10922; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
				{SourceIndex: 1, DestinationIndex: 2}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 10923; i <= 13107; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantErr: false,
		},
		{
			name: "mixed unassigned and migration needed",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 5000}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{
				func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 5001; i <= 8191; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
				func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 8192; i <= 16383; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{},
			wantErr:             false,
		},
		{
			name: "scale up - 1 to 2 masters",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 16383}},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{nil, nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{
				{SourceIndex: 0, DestinationIndex: 1}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 8192; i <= 16383; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantErr: false,
		},
		{
			name: "single master - all slots assigned",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 16383}},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 16383}},
					},
				},
			},
			wantMasterAddSlots:  []*internalslot.SlotRangeTracker{nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{},
			wantErr:             false,
		},
		{
			name: "bidirectional migration between two masters",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 5000}, {Start: 12000, End: 16383}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 5001, End: 11999}},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{nil, nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{
				{SourceIndex: 1, DestinationIndex: 0}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 5001; i <= 8191; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
				{SourceIndex: 0, DestinationIndex: 1}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 12000; i <= 16383; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantErr: false,
		},
		{
			name: "partial slots assigned - unassigned at the end",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 10000}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{
				nil,
				func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 10001; i <= 16383; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{
				{SourceIndex: 0, DestinationIndex: 1}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 8192; i <= 10000; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantErr: false,
		},
		{
			name: "scale down - 3 to 2 masters",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 5461}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 5462, End: 10922}},
					},
					{
						ID:         "m3",
						Index:      2,
						Address:    Address{Host: "valkey-2.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 10923, End: 16383}},
					},
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{nil, nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{
				{SourceIndex: 1, DestinationIndex: 0}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 5462; i <= 8191; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
				{SourceIndex: 2, DestinationIndex: 1}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					for i := 10923; i <= 16383; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantErr: false,
		},
		{
			name: "skip slots already in migration - importing",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 5000}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 5001, End: 16383}},
					},
				},
				Migrations: map[MigrationRoute]*internalslot.SlotRangeTracker{
					{SourceIndex: 1, DestinationIndex: 0}: func() *internalslot.SlotRangeTracker {
						tracker := &internalslot.SlotRangeTracker{}
						// Slots 5001-6000 are already being migrated
						for i := 5001; i <= 6000; i++ {
							tracker.Add(internalslot.SlotRange{Start: i, End: i})
						}
						return tracker
					}(),
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{nil, nil},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{
				{SourceIndex: 1, DestinationIndex: 0}: func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					// Should only include 6001-8191, skipping 5001-6000 that are already migrating
					for i := 6001; i <= 8191; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantErr: false,
		},
		{
			name: "skip unassigned slots already in migration",
			currentTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{},
					},
				},
				Migrations: map[MigrationRoute]*internalslot.SlotRangeTracker{
					{SourceIndex: 0, DestinationIndex: 1}: func() *internalslot.SlotRangeTracker {
						tracker := &internalslot.SlotRangeTracker{}
						// Slots 0-100 are already being migrated from master 0 to master 1
						for i := 0; i <= 100; i++ {
							tracker.Add(internalslot.SlotRange{Start: i, End: i})
						}
						return tracker
					}(),
				},
			},
			desiredTopology: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "m1",
						Index:      0,
						Address:    Address{Host: "valkey-0.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 0, End: 8191}},
					},
					{
						ID:         "m2",
						Index:      1,
						Address:    Address{Host: "valkey-1.svc", Port: 6379},
						Role:       NodeRoleMaster,
						SlotRanges: []internalslot.SlotRange{{Start: 8192, End: 16383}},
					},
				},
			},
			wantMasterAddSlots: []*internalslot.SlotRangeTracker{
				nil,
				func() *internalslot.SlotRangeTracker {
					tracker := &internalslot.SlotRangeTracker{}
					// Add 8192-16383 for master 1
					for i := 8192; i <= 16383; i++ {
						tracker.Add(internalslot.SlotRange{Start: i, End: i})
					}
					return tracker
				}(),
			},
			wantMigrationRoutes: map[MigrationRoute]*internalslot.SlotRangeTracker{},
			wantErr:             false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotMasterAddSlots, gotMigrationRoutes, err := CalculateSlotsToReconcile(test.currentTopology, test.desiredTopology)

			if test.wantErr {
				if err == nil {
					t.Errorf("CalculateSlotsToReconcile() error = nil, wantErr %v", test.wantErr)
					return
				}
				if test.errMsg != "" && err.Error() != test.errMsg {
					t.Errorf("CalculateSlotsToReconcile() error = %v, want error message %v", err, test.errMsg)
				}
				return
			}

			if err != nil {
				t.Errorf("CalculateSlotsToReconcile() unexpected error = %v", err)
				return
			}

			if len(gotMasterAddSlots) != len(test.wantMasterAddSlots) {
				t.Errorf("CalculateSlotsToReconcile() masterAddSlots length = %v, want %v", len(gotMasterAddSlots), len(test.wantMasterAddSlots))
				return
			}

			for i := range gotMasterAddSlots {
				if test.wantMasterAddSlots[i] == nil {
					if gotMasterAddSlots[i] != nil {
						t.Errorf("CalculateSlotsToReconcile() masterAddSlots[%d] = %v, want nil", i, gotMasterAddSlots[i])
					}
					continue
				}

				if gotMasterAddSlots[i] == nil {
					t.Errorf("CalculateSlotsToReconcile() masterAddSlots[%d] = nil, want non-nil", i)
					continue
				}

				gotRanges := gotMasterAddSlots[i].SlotRanges()
				wantRanges := test.wantMasterAddSlots[i].SlotRanges()

				if len(gotRanges) != len(wantRanges) {
					t.Errorf("CalculateSlotsToReconcile() masterAddSlots[%d] ranges length = %v, want %v", i, len(gotRanges), len(wantRanges))
					continue
				}

				for j := range gotRanges {
					if gotRanges[j].Start != wantRanges[j].Start || gotRanges[j].End != wantRanges[j].End {
						t.Errorf("CalculateSlotsToReconcile() masterAddSlots[%d][%d] = {%d, %d}, want {%d, %d}",
							i, j, gotRanges[j].Start, gotRanges[j].End, wantRanges[j].Start, wantRanges[j].End)
					}
				}
			}

			if len(gotMigrationRoutes) != len(test.wantMigrationRoutes) {
				t.Errorf("CalculateSlotsToReconcile() migrationRoutes length = %v, want %v", len(gotMigrationRoutes), len(test.wantMigrationRoutes))
				return
			}

			for route, wantTracker := range test.wantMigrationRoutes {
				gotTracker, exists := gotMigrationRoutes[route]
				if !exists {
					t.Errorf("CalculateSlotsToReconcile() missing migration route %v", route)
					continue
				}

				if gotTracker == nil && wantTracker != nil {
					t.Errorf("CalculateSlotsToReconcile() migrationRoutes[%v] = nil, want non-nil", route)
					continue
				}

				if gotTracker != nil && wantTracker == nil {
					t.Errorf("CalculateSlotsToReconcile() migrationRoutes[%v] = %v, want nil", route, gotTracker)
					continue
				}

				if gotTracker == nil && wantTracker == nil {
					continue
				}

				gotRanges := gotTracker.SlotRanges()
				wantRanges := wantTracker.SlotRanges()

				if len(gotRanges) != len(wantRanges) {
					t.Errorf("CalculateSlotsToReconcile() migrationRoutes[%v] ranges length = %v, want %v", route, len(gotRanges), len(wantRanges))
					continue
				}

				for j := range gotRanges {
					if gotRanges[j].Start != wantRanges[j].Start || gotRanges[j].End != wantRanges[j].End {
						t.Errorf("CalculateSlotsToReconcile() migrationRoutes[%v][%d] = {%d, %d}, want {%d, %d}",
							route, j, gotRanges[j].Start, gotRanges[j].End, wantRanges[j].Start, wantRanges[j].End)
					}
				}
			}
		})
	}
}
