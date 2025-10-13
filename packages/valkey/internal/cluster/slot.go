package cluster

import (
	"fmt"
	"math"
	internalslot "valkey/operator/internal/slot"
)

const (
	Unassigned uint8 = math.MaxUint8
)

type MigrationRoute struct {
	SourceIndex      uint8
	DestinationIndex uint8
}

// masterAddSlotRanges: array of slot ranges to add to each master. It is ordered by master index so index 0 is master 0, index 1 is master 1, etc.
// migrationRoutes: map of migration routes. Key is the {source, destination} pair. Value is a slot range tracker.
func CalculateSlotsToReconcile(currentTopology, desiredTopology *ClusterTopology) ([]*internalslot.SlotRangeTracker, map[MigrationRoute]*internalslot.SlotRangeTracker, error) {
	if len(currentTopology.Masters) != len(desiredTopology.Masters) {
		return nil, nil, fmt.Errorf("current and desired master count mismatch: %d vs %d", len(currentTopology.Masters), len(desiredTopology.Masters))
	}

	currentSlotOwner := make([]uint8, internalslot.TotalSlots)
	desiredSlotOwner := make([]uint8, internalslot.TotalSlots)
	for i := range currentSlotOwner {
		currentSlotOwner[i] = Unassigned
	}

	for _, currentMaster := range currentTopology.Masters {
		for _, slotRange := range currentMaster.SlotRanges {
			for slot := slotRange.Start; slot <= slotRange.End; slot++ {
				currentMasterIndex, err := currentMaster.Address.Index()
				if err != nil {
					return nil, nil, err
				}
				currentSlotOwner[slot] = uint8(currentMasterIndex)
			}
		}
	}
	for _, desiredMaster := range desiredTopology.Masters {
		for _, slotRange := range desiredMaster.SlotRanges {
			for slot := slotRange.Start; slot <= slotRange.End; slot++ {
				desiredMasterIndex, err := desiredMaster.Address.Index()
				if err != nil {
					return nil, nil, err
				}
				desiredSlotOwner[slot] = uint8(desiredMasterIndex)
			}
		}
	}

	masterAddSlotRanges := make([]*internalslot.SlotRangeTracker, len(currentTopology.Masters))
	migrationRoutes := map[MigrationRoute]*internalslot.SlotRangeTracker{}
	for slot := range internalslot.TotalSlots {
		currentOwnerIndex := currentSlotOwner[slot]
		desiredOwnerIndex := desiredSlotOwner[slot]

		if currentOwnerIndex == Unassigned {
			if masterAddSlotRanges[desiredOwnerIndex] == nil {
				masterAddSlotRanges[desiredOwnerIndex] = &internalslot.SlotRangeTracker{}
			}
			masterAddSlotRanges[desiredOwnerIndex].Add(internalslot.SlotRange{Start: slot, End: slot})
		} else if currentOwnerIndex != desiredOwnerIndex {
			migration := MigrationRoute{SourceIndex: currentOwnerIndex, DestinationIndex: desiredOwnerIndex}
			if migrationRoutes[migration] == nil {
				migrationRoutes[migration] = &internalslot.SlotRangeTracker{}
			}
			migrationRoutes[migration].Add(internalslot.SlotRange{Start: slot, End: slot})
		}
	}

	return masterAddSlotRanges, migrationRoutes, nil
}
