package slot

import (
	"fmt"
	"sort"
)

const (
	TotalSlots = 16384 // 16384 slots starting at 0 [0, 16383]
)

type SlotRange struct {
	Start int
	End   int
}

type SlotRangeTracker struct {
	ranges []SlotRange
}

// Adds a slot range to the tracker. The slots are always ordered by start and there should be no overlaps.
func (t *SlotRangeTracker) Add(slotRanges ...SlotRange) error {
	if len(slotRanges) == 0 {
		return nil
	}

	for _, slotRange := range slotRanges {
		start, end := slotRange.Start, slotRange.End
		if start < 0 || end >= TotalSlots || start > end {
			return fmt.Errorf("invalid slot range: [%d-%d]", start, end)
		}

		for _, slotRange := range t.ranges {
			if start <= slotRange.End && end >= slotRange.Start {
				return fmt.Errorf("slot overlap detected: [%d-%d] overlaps with existing [%d-%d]", start, end, slotRange.Start, slotRange.End)
			}
		}

		t.ranges = append(t.ranges, slotRange)

		sort.Slice(t.ranges, func(i, j int) bool {
			return t.ranges[i].Start < t.ranges[j].Start
		})

		mergedRanges := make([]SlotRange, 0, len(t.ranges))
		current := t.ranges[0]
		for i := 1; i < len(t.ranges); i++ {
			next := t.ranges[i]
			if current.End+1 == next.Start {
				current.End = next.End
			} else {
				mergedRanges = append(mergedRanges, current)
				current = next
			}
		}
		mergedRanges = append(mergedRanges, current)
		t.ranges = mergedRanges
	}

	return nil
}

func (t *SlotRangeTracker) IsFullyCovered() bool {
	return len(t.ranges) == 1 && t.ranges[0].Start == 0 && t.ranges[0].End == TotalSlots-1
}

func (t *SlotRangeTracker) SlotRanges() []SlotRange {
	return t.ranges
}

func (t *SlotRangeTracker) Array() []int64 {
	slots := []int64{}
	for _, slotRange := range t.ranges {
		slots = append(slots, slotRange.Array()...)
	}
	return slots
}

// returns int64 slice because valkey-go uses int64... for Slot()
func (s *SlotRange) Array() []int64 {
	slots := make([]int64, 0, s.End-s.Start+1)
	for slot := s.Start; slot <= s.End; slot++ {
		slots = append(slots, int64(slot))
	}
	return slots
}

// calculates the slot ranges for a given amount of masters
func DesiredSlotRangesFromMasterCount(numMasters int32) []SlotRange {
	slotsPerMaster := int(TotalSlots / numMasters)
	remainder := TotalSlots % numMasters

	ranges := make([]SlotRange, numMasters)
	currentSlot := 0

	for i := range numMasters {
		ranges[i].Start = currentSlot

		slots := slotsPerMaster
		if i < remainder {
			slots++
		}

		ranges[i].End = currentSlot + slots - 1
		currentSlot += slots
	}

	return ranges
}
