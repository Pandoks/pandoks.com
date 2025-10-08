package slot

import (
	"reflect"
	"testing"
)

func TestSlotRangeTracker_Add(t *testing.T) {
	tests := []struct {
		name   string
		ranges []SlotRange
		want   []SlotRange // nil if error
	}{
		{
			name: "single range",
			ranges: []SlotRange{
				{Start: 0, End: 100},
			},
			want: []SlotRange{
				{Start: 0, End: 100},
			},
		},
		{
			name: "adjacent ranges merge",
			ranges: []SlotRange{
				{Start: 0, End: 100},
				{Start: 101, End: 200},
			},
			want: []SlotRange{
				{Start: 0, End: 200},
			},
		},
		{
			name: "three adjacent ranges merge",
			ranges: []SlotRange{
				{Start: 0, End: 5460},
				{Start: 5461, End: 10922},
				{Start: 10923, End: 16383},
			},
			want: []SlotRange{
				{Start: 0, End: 16383},
			},
		},
		{
			name: "non-adjacent ranges stay separate",
			ranges: []SlotRange{
				{Start: 0, End: 100},
				{Start: 200, End: 300},
			},
			want: []SlotRange{
				{Start: 0, End: 100},
				{Start: 200, End: 300},
			},
		},
		{
			name: "overlapping ranges error",
			ranges: []SlotRange{
				{Start: 0, End: 100},
				{Start: 50, End: 150},
			},
			want: nil,
		},
		{
			name: "out of order ranges merge correctly",
			ranges: []SlotRange{
				{Start: 200, End: 300},
				{Start: 0, End: 100},
				{Start: 101, End: 198},
			},
			want: []SlotRange{
				{Start: 0, End: 198},
				{Start: 200, End: 300},
			},
		},
		{
			name: "invalid range: start > end",
			ranges: []SlotRange{
				{Start: 100, End: 50},
			},
			want: nil,
		},
		{
			name: "invalid range: negative start",
			ranges: []SlotRange{
				{Start: -1, End: 100},
			},
			want: nil,
		},
		{
			name: "invalid range: end >= totalSlots",
			ranges: []SlotRange{
				{Start: 0, End: 16384},
			},
			want: nil,
		},
		{
			name: "single slot",
			ranges: []SlotRange{
				{Start: 150, End: 150},
			},
			want: []SlotRange{
				{Start: 150, End: 150},
			},
		},
		{
			name: "single slot merges with range",
			ranges: []SlotRange{
				{Start: 0, End: 100},
				{Start: 101, End: 101},
			},
			want: []SlotRange{
				{Start: 0, End: 101},
			},
		},
		{
			name: "multiple single slots merge",
			ranges: []SlotRange{
				{Start: 0, End: 0},
				{Start: 1, End: 1},
				{Start: 2, End: 2},
			},
			want: []SlotRange{
				{Start: 0, End: 2},
			},
		},
		{
			name: "single slots with gaps stay separate",
			ranges: []SlotRange{
				{Start: 0, End: 0},
				{Start: 5, End: 5},
				{Start: 10, End: 10},
			},
			want: []SlotRange{
				{Start: 0, End: 0},
				{Start: 5, End: 5},
				{Start: 10, End: 10},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tracker := &SlotRangeTracker{}

			var err error
			for _, slotRange := range test.ranges {
				err = tracker.Add(slotRange)
				if err != nil {
					break
				}
			}

			if (test.want == nil) != (err != nil) {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				} else {
					t.Errorf("expected error but got none")
				}
				return
			}

			if err == nil && !reflect.DeepEqual(tracker.ranges, test.want) {
				t.Errorf("Add() ranges = %v, want %v", tracker.ranges, test.want)
			}
		})
	}
}

func TestSlotRangeTracker_IsFullyCovered(t *testing.T) {
	tests := []struct {
		name   string
		ranges []SlotRange
		want   bool
	}{
		{
			name: "full coverage - single range",
			ranges: []SlotRange{
				{Start: 0, End: 16383},
			},
			want: true,
		},
		{
			name: "full coverage - three adjacent ranges",
			ranges: []SlotRange{
				{Start: 0, End: 5460},
				{Start: 5461, End: 10922},
				{Start: 10923, End: 16383},
			},
			want: true,
		},
		{
			name: "partial coverage",
			ranges: []SlotRange{
				{Start: 0, End: 5000},
			},
			want: false,
		},
		{
			name: "full coverage with gap",
			ranges: []SlotRange{
				{Start: 0, End: 5000},
				{Start: 6000, End: 16383},
			},
			want: false,
		},
		{
			name:   "empty tracker",
			ranges: []SlotRange{},
			want:   false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tracker := &SlotRangeTracker{}

			for _, slotRange := range test.ranges {
				if err := tracker.Add(slotRange); err != nil {
					t.Fatalf("Add() unexpected error = %v", err)
				}
			}

			if isFullyCovered := tracker.IsFullyCovered(); isFullyCovered != test.want {
				t.Errorf("IsFullyCovered() = %v, want %v. Ranges: %v", isFullyCovered, test.want, tracker.ranges)
			}
		})
	}
}

func TestSlotRange_Array(t *testing.T) {
	tests := []struct {
		name      string
		slotRange SlotRange
		want      []int
	}{
		{
			name:      "single slot",
			slotRange: SlotRange{Start: 5, End: 5},
			want:      []int{5},
		},
		{
			name:      "range of slots",
			slotRange: SlotRange{Start: 0, End: 4},
			want:      []int{0, 1, 2, 3, 4},
		},
		{
			name:      "larger range",
			slotRange: SlotRange{Start: 10, End: 15},
			want:      []int{10, 11, 12, 13, 14, 15},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := test.slotRange.Array()
			if !reflect.DeepEqual(got, test.want) {
				t.Errorf("Slice() = %v, want %v", got, test.want)
			}
		})
	}

	t.Run("full range", func(t *testing.T) {
		slotRange := SlotRange{Start: 0, End: 16383}
		got := slotRange.Array()
		if len(got) != 16384 {
			t.Errorf("Slice() length = %d, want 16384", len(got))
		}
		for i := range 16384 {
			if got[i] != i {
				t.Errorf("Slice()[%d] = %d, want %d", i, got[i], i)
			}
		}
	})
}

func TestDesiredSlotRanges(t *testing.T) {
	tests := []struct {
		name       string
		numMasters int32
		want       []SlotRange
	}{
		{
			name:       "single master",
			numMasters: 1,
			want: []SlotRange{
				{Start: 0, End: 16383},
			},
		},
		{
			name:       "two masters",
			numMasters: 2,
			want: []SlotRange{
				{Start: 0, End: 8191},
				{Start: 8192, End: 16383},
			},
		},
		{
			name:       "three masters",
			numMasters: 3,
			want: []SlotRange{
				{Start: 0, End: 5460},
				{Start: 5461, End: 10922},
				{Start: 10923, End: 16383},
			},
		},
		{
			name:       "four masters",
			numMasters: 4,
			want: []SlotRange{
				{Start: 0, End: 4095},
				{Start: 4096, End: 8191},
				{Start: 8192, End: 12287},
				{Start: 12288, End: 16383},
			},
		},
		{
			name:       "five masters with remainder",
			numMasters: 5,
			want: []SlotRange{
				{Start: 0, End: 3276},
				{Start: 3277, End: 6553},
				{Start: 6554, End: 9830},
				{Start: 9831, End: 13106},
				{Start: 13107, End: 16383},
			},
		},
		{
			name:       "ten masters",
			numMasters: 10,
			want: []SlotRange{
				{Start: 0, End: 1637},
				{Start: 1638, End: 3275},
				{Start: 3276, End: 4913},
				{Start: 4914, End: 6551},
				{Start: 6552, End: 8189},
				{Start: 8190, End: 9827},
				{Start: 9828, End: 11465},
				{Start: 11466, End: 13103},
				{Start: 13104, End: 14741},
				{Start: 14742, End: 16383},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := DesiredSlotRanges(test.numMasters)
			if !reflect.DeepEqual(got, test.want) {
				t.Errorf("DesiredSlotRanges(%d) = %v, want %v", test.numMasters, got, test.want)
			}

			totalSlots := 0
			for _, r := range got {
				totalSlots += r.End - r.Start + 1
			}
			if totalSlots != TotalSlots {
				t.Errorf("total slots = %d, want %d", totalSlots, TotalSlots)
			}

			for i := 0; i < len(got)-1; i++ {
				if got[i].End+1 != got[i+1].Start {
					t.Errorf("ranges are not contiguous: range %d ends at %d, range %d starts at %d", i, got[i].End, i+1, got[i+1].Start)
				}
			}

			if len(got) > 0 {
				if got[0].Start != 0 {
					t.Errorf("first range should start at 0, got %d", got[0].Start)
				}
				if got[len(got)-1].End != TotalSlots-1 {
					t.Errorf("last range should end at %d, got %d", TotalSlots-1, got[len(got)-1].End)
				}
			}
		})
	}
}
