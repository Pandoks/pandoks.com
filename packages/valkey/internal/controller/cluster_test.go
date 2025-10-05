package controller

import (
	"testing"
)

func TestSlotRanges(t *testing.T) {
	tests := []struct {
		name       string
		numMasters int32
		want       []SlotRange
	}{
		{
			name:       "1 master",
			numMasters: 1,
			want: []SlotRange{
				{Start: 0, End: 16383},
			},
		},
		{
			name:       "2 masters",
			numMasters: 2,
			want: []SlotRange{
				{Start: 0, End: 8191},
				{Start: 8192, End: 16383},
			},
		},
		{
			name:       "3 masters",
			numMasters: 3,
			want: []SlotRange{
				{Start: 0, End: 5461},
				{Start: 5462, End: 10922},
				{Start: 10923, End: 16383},
			},
		},
		{
			name:       "4 masters",
			numMasters: 4,
			want: []SlotRange{
				{Start: 0, End: 4095},
				{Start: 4096, End: 8191},
				{Start: 8192, End: 12287},
				{Start: 12288, End: 16383},
			},
		},
		{
			name:       "5 masters (uneven distribution)",
			numMasters: 5,
			want: []SlotRange{
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
			want: []SlotRange{
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
			want: []SlotRange{
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
			want: []SlotRange{
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
			r := &ValkeyClusterReconciler{}
			slotRanges := r.slotRanges(test.numMasters)

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
