package cluster

import (
	"context"
	"fmt"
	"math"
	"strconv"
	internalslot "valkey/operator/internal/slot"

	"github.com/valkey-io/valkey-go"
)

const (
	Unassigned uint8 = math.MaxUint8
)

type MigrationRoute struct {
	SourceIndex      uint8
	DestinationIndex uint8
}

// masterAddSlotRanges: array of slot ranges to add to each master. It is ordered by master index so index 0 is master 0, index 1 is master 1, etc.
//
// migrationRoutes: map of migration routes. Key is the {source, destination} pair. Value is a slot range tracker.
func CalculateSlotsToReconcile(currentTopology, desiredTopology *ClusterTopology) ([]*internalslot.SlotRangeTracker, map[MigrationRoute]*internalslot.SlotRangeTracker, error) {
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

	masterAddSlotRanges := make([]*internalslot.SlotRangeTracker, len(desiredTopology.Masters))
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

func MigrateSlot(ctx context.Context, slot int64, migrationRoute MigrationRoute, clients []valkey.Client, currentTopology *ClusterTopology) error {
	sourceClient := clients[migrationRoute.SourceIndex]
	destClient := clients[migrationRoute.DestinationIndex]

	sourceNode := currentTopology.Masters[migrationRoute.SourceIndex]
	destNode := currentTopology.Masters[migrationRoute.DestinationIndex]

	slotStr := strconv.Itoa(int(slot))

	markSourceSlotMigratingCmd := sourceClient.B().
		Arbitrary("CLUSTER", "SETSLOT").
		Args(slotStr, "MIGRATING", destNode.ID).Build()
	if err := sourceClient.Do(ctx, markSourceSlotMigratingCmd).Error(); err != nil {
		return fmt.Errorf("failed to mark source slot %d migrating to destination %s: %w", slot, destNode.ID, err)
	}

	markDestSlotMigratingCmd := destClient.B().
		Arbitrary("CLUSTER", "SETSLOT").
		Args(slotStr, "IMPORTING", sourceNode.ID).Build()
	if err := destClient.Do(ctx, markDestSlotMigratingCmd).Error(); err != nil {
		return fmt.Errorf("failed to mark destination slot %d migrating to source %s: %w", slot, sourceNode.ID, err)
	}

	for {
		// NOTE: migrates 100 keys at a time
		keysInSlotCmd := sourceClient.B().Arbitrary("CLUSTER", "GETKEYSINSLOT").Args(slotStr, "100").Build()
		keys, err := sourceClient.Do(ctx, keysInSlotCmd).AsStrSlice()
		if err != nil {
			return fmt.Errorf("failed to get keys in slot %d: %w", slot, err)
		}
		if len(keys) == 0 {
			break
		}

		// valkey-cli equivalent:
		// MIGRATE <host> <port> <key ("" is all keys)> <db (cluster only uses 0)> <timeout> KEYS <keys...>
		migrationArgs := []string{
			destNode.Address.Host,
			strconv.Itoa(int(destNode.Address.Port)),
			"",
			"0",
			"5000",
			"KEYS",
		}
		migrationArgs = append(migrationArgs, keys...)
		migrateKeysCmd := sourceClient.B().Arbitrary("MIGRATE").Args(migrationArgs...).Build()
		if err := sourceClient.Do(ctx, migrateKeysCmd).Error(); err != nil {
			return fmt.Errorf("failed to migrate keys in slot %d: %w", slot, err)
		}
	}

	finalizeSourceMigrationCmd := sourceClient.B().
		Arbitrary("CLUSTER", "SETSLOT").
		Args(slotStr, "NODE", destNode.ID).Build()
	if err := sourceClient.Do(ctx, finalizeSourceMigrationCmd).Error(); err != nil {
		return fmt.Errorf("failed to finalize source slot %d migration to destination %s: %w", slot, destNode.ID, err)
	}

	finalizeDestMigrationCmd := destClient.B().
		Arbitrary("CLUSTER", "SETSLOT").
		Args(slotStr, "NODE", destNode.ID).Build()
	if err := destClient.Do(ctx, finalizeDestMigrationCmd).Error(); err != nil {
		return fmt.Errorf("failed to finalize destination slot %d migration to source %s: %w", slot, sourceNode.ID, err)
	}

	return nil
}
