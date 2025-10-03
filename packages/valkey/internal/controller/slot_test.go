package controller

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

			if !reflect.DeepEqual(tracker.ranges, test.want) {
				t.Errorf("Add() ranges = %v, want %v", tracker.ranges, test.want)
			}
		})
	}
}
