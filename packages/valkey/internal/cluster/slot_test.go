package cluster

import (
	"testing"
	internalslot "valkey/operator/internal/slot"
)

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
