package cluster

import (
	"context"
	"fmt"
	"valkey/operator/internal/slot"

	"sigs.k8s.io/controller-runtime/pkg/log"
)

func BootstrapSlots(ctx context.Context, masters []*ClusterNode) error {
	logger := log.FromContext(ctx)

	logger.Info("No slots assigned, bootstrapping cluster")
	slotRanges := slot.DesiredSlotRangesFromMasterCount(int32(len(masters)))

	for i, masterNode := range masters {
		client, err := ConnectToValkeyNode(ctx, masterNode.FQDN)
		if err != nil {
			return fmt.Errorf("failed to connect to master %s: %w", masterNode.FQDN, err)
		}

		slotRange := slotRanges[i]
		slots := slotRange.Array()

		logger.Info("Assigning slots to master", "masterIndex", i, "slots", fmt.Sprintf("%d-%d", slotRange.Start, slotRange.End))
		cmd := client.B().ClusterAddslots().Slot(slots...).Build()
		if err := client.Do(ctx, cmd).Error(); err != nil {
			client.Close()
			return fmt.Errorf("failed to assign slots to master %d: %w", i, err)
		}

		client.Close()
	}
	return nil
}

func recoverMissingSlots(ctx context.Context, slotOwner map[int]string, numMasters int, podFQDNs []string, logger any) error {
	type loggerInterface interface {
		Info(msg string, keysAndValues ...any)
	}
	log := logger.(loggerInterface)

	log.Info("Partial slot assignment detected, assigning missing slots", "assigned", len(slotOwner), "total", slot.TotalSlots)

	desiredRanges := slot.DesiredSlotRanges(int32(numMasters))

	for i := 0; i < numMasters; i++ {
		slotRange := desiredRanges[i]
		slotsToAssign := make([]int64, 0)

		for slot := slotRange.Start; slot <= slotRange.End; slot++ {
			if _, assigned := slotOwner[slot]; !assigned {
				slotsToAssign = append(slotsToAssign, int64(slot))
			}
		}

		if len(slotsToAssign) == 0 {
			continue
		}

		client, err := ConnectToValkeyNode(ctx, podFQDNs[i])
		if err != nil {
			return fmt.Errorf("failed to connect to master %d: %w", i, err)
		}

		log.Info("Assigning missing slots to master", "masterIndex", i, "numSlots", len(slotsToAssign))
		cmd := client.B().ClusterAddslots().Slot(slotsToAssign...).Build()
		if err := client.Do(ctx, cmd).Error(); err != nil {
			client.Close()
			return fmt.Errorf("failed to assign slots to master %d: %w", i, err)
		}

		client.Close()
	}
	return nil
}

func rebalanceSlots(ctx context.Context, slotOwner map[int]string, currentSlotsByMaster map[string][]int, desiredMasterFQDNs []string, logger any) error {
	type loggerInterface interface {
		Info(msg string, keysAndValues ...any)
	}
	log := logger.(loggerInterface)

	numDesiredMasters := len(desiredMasterFQDNs)
	desiredSlotsPerMaster := slot.TotalSlots / numDesiredMasters

	desiredMasterSet := make(map[string]bool)
	for _, fqdn := range desiredMasterFQDNs {
		desiredMasterSet[fqdn] = true
	}

	migrations := calculateMigrationPlan(slotOwner, currentSlotsByMaster, desiredMasterFQDNs, desiredSlotsPerMaster, desiredMasterSet)

	if len(migrations) == 0 {
		log.Info("Slot distribution balanced, no migration needed")
		return nil
	}

	log.Info("Rebalancing slots", "numMigrations", len(migrations))

	for _, migration := range migrations {
		if err := migrateSlot(ctx, migration, logger); err != nil {
			return fmt.Errorf("failed to migrate slot %d from %s to %s: %w",
				migration.Slot, migration.SourceFQDN, migration.DestFQDN, err)
		}
	}

	log.Info("Slot rebalancing completed")
	return nil
}

type slotMigration struct {
	Slot       int
	SourceFQDN string
	SourceID   string
	DestFQDN   string
	DestID     string
}

func calculateMigrationPlan(
	slotOwner map[int]string,
	currentSlotsByMaster map[string][]int,
	desiredMasterFQDNs []string,
	desiredSlotsPerMaster int,
	desiredMasterSet map[string]bool,
) []slotMigration {

	overloadedMasters := make(map[string][]int)
	underloadedMasters := []string{}
	excessMasters := []string{}

	for _, fqdn := range desiredMasterFQDNs {
		currentSlots := len(currentSlotsByMaster[fqdn])

		if currentSlots == 0 {
			underloadedMasters = append(underloadedMasters, fqdn)
		} else if currentSlots > desiredSlotsPerMaster {
			overloadedMasters[fqdn] = currentSlotsByMaster[fqdn]
		}
	}

	for fqdn, slots := range currentSlotsByMaster {
		if !desiredMasterSet[fqdn] {
			excessMasters = append(excessMasters, fqdn)
			overloadedMasters[fqdn] = slots
		}
	}

	migrations := []slotMigration{}
	underloadedIdx := 0

	for sourceFQDN, slots := range overloadedMasters {
		isExcess := !desiredMasterSet[sourceFQDN]
		targetSlotCount := desiredSlotsPerMaster
		if isExcess {
			targetSlotCount = 0
		}

		for len(slots) > targetSlotCount && underloadedIdx < len(underloadedMasters) {
			destFQDN := underloadedMasters[underloadedIdx]
			destSlotCount := len(currentSlotsByMaster[destFQDN])

			if destSlotCount >= desiredSlotsPerMaster {
				underloadedIdx++
				continue
			}

			slot := slots[len(slots)-1]
			slots = slots[:len(slots)-1]

			migrations = append(migrations, slotMigration{
				Slot:       slot,
				SourceFQDN: sourceFQDN,
				DestFQDN:   destFQDN,
			})

			currentSlotsByMaster[destFQDN] = append(currentSlotsByMaster[destFQDN], slot)
		}

		overloadedMasters[sourceFQDN] = slots
	}

	return migrations
}

func migrateSlot(ctx context.Context, migration slotMigration, logger any) error {
	type loggerInterface interface {
		Info(msg string, keysAndValues ...any)
	}
	log := logger.(loggerInterface)

	sourceClient, err := ConnectToValkeyNode(ctx, migration.SourceFQDN)
	if err != nil {
		return fmt.Errorf("failed to connect to source: %w", err)
	}
	defer sourceClient.Close()

	destClient, err := ConnectToValkeyNode(ctx, migration.DestFQDN)
	if err != nil {
		return fmt.Errorf("failed to connect to dest: %w", err)
	}
	defer destClient.Close()

	sourceIDResp := sourceClient.Do(ctx, sourceClient.B().ClusterMyid().Build())
	if sourceIDResp.Error() != nil {
		return fmt.Errorf("failed to get source node ID: %w", sourceIDResp.Error())
	}
	sourceID, err := sourceIDResp.ToString()
	if err != nil {
		return fmt.Errorf("failed to parse source node ID: %w", err)
	}

	destIDResp := destClient.Do(ctx, destClient.B().ClusterMyid().Build())
	if destIDResp.Error() != nil {
		return fmt.Errorf("failed to get dest node ID: %w", destIDResp.Error())
	}
	destID, err := destIDResp.ToString()
	if err != nil {
		return fmt.Errorf("failed to parse dest node ID: %w", err)
	}

	log.Info("Migrating slot", "slot", migration.Slot, "from", migration.SourceFQDN, "to", migration.DestFQDN)

	importCmd := destClient.B().ClusterSetslot().Slot(int64(migration.Slot)).Importing().NodeId(sourceID).Build()
	if err := destClient.Do(ctx, importCmd).Error(); err != nil {
		return fmt.Errorf("failed to set slot importing: %w", err)
	}

	migratingCmd := sourceClient.B().ClusterSetslot().Slot(int64(migration.Slot)).Migrating().NodeId(destID).Build()
	if err := sourceClient.Do(ctx, migratingCmd).Error(); err != nil {
		return fmt.Errorf("failed to set slot migrating: %w", err)
	}

	for {
		keysCmd := sourceClient.B().ClusterGetkeysinslot().Slot(int64(migration.Slot)).Count(100).Build()
		keysResp := sourceClient.Do(ctx, keysCmd)
		if keysResp.Error() != nil {
			return fmt.Errorf("failed to get keys in slot: %w", keysResp.Error())
		}

		keys, err := keysResp.AsStrSlice()
		if err != nil {
			return fmt.Errorf("failed to parse keys: %w", err)
		}

		if len(keys) == 0 {
			break
		}

		for _, key := range keys {
			migrateCmd := sourceClient.B().Migrate().Host(migration.DestFQDN).Port(6379).Key(key).DestinationDb(0).Timeout(5000).Build()
			if err := sourceClient.Do(ctx, migrateCmd).Error(); err != nil {
				return fmt.Errorf("failed to migrate key %s: %w", key, err)
			}
		}
	}

	setslotCmd := sourceClient.B().ClusterSetslot().Slot(int64(migration.Slot)).Node().NodeId(destID).Build()
	if err := sourceClient.Do(ctx, setslotCmd).Error(); err != nil {
		return fmt.Errorf("failed to finalize slot on source: %w", err)
	}

	setslotCmd = destClient.B().ClusterSetslot().Slot(int64(migration.Slot)).Node().NodeId(destID).Build()
	if err := destClient.Do(ctx, setslotCmd).Error(); err != nil {
		return fmt.Errorf("failed to finalize slot on dest: %w", err)
	}

	return nil
}

func ensureReplicas(ctx context.Context, current, desired *ClusterTopology, podFQDNs []string) error {
	logger := log.FromContext(ctx)

	numMasters := len(desired.Masters)
	replicasPerMaster := len(desired.Replicas) / numMasters

	if replicasPerMaster == 0 {
		return nil
	}

	masterIDs := make([]string, numMasters)
	for i := 0; i < numMasters; i++ {
		client, err := ConnectToValkeyNode(ctx, podFQDNs[i])
		if err != nil {
			return fmt.Errorf("failed to connect to master %d: %w", i, err)
		}

		resp := client.Do(ctx, client.B().ClusterMyid().Build())
		if resp.Error() != nil {
			client.Close()
			return fmt.Errorf("failed to get master %d node ID: %w", i, resp.Error())
		}

		masterID, err := resp.ToString()
		client.Close()
		if err != nil {
			return fmt.Errorf("failed to parse master %d node ID: %w", i, err)
		}

		masterIDs[i] = masterID
	}

	currentReplicasByFQDN := make(map[string]*ClusterNode)
	for _, replica := range current.Replicas {
		currentReplicasByFQDN[replica.FQDN] = replica
	}

	for i := 0; i < numMasters; i++ {
		for j := 0; j < replicasPerMaster; j++ {
			replicaIndex := numMasters + i*replicasPerMaster + j
			if replicaIndex >= len(podFQDNs) {
				continue
			}

			replicaFQDN := podFQDNs[replicaIndex]
			expectedMasterID := masterIDs[i]

			currentReplica, exists := currentReplicasByFQDN[replicaFQDN]
			if exists && currentReplica.MasterID == expectedMasterID && currentReplica.Role == NodeRoleSlave {
				continue
			}

			logger.Info("Configuring replica", "replicaIndex", replicaIndex, "masterIndex", i)

			client, err := ConnectToValkeyNode(ctx, replicaFQDN)
			if err != nil {
				return fmt.Errorf("failed to connect to replica %d-%d: %w", i, j, err)
			}

			cmd := client.B().ClusterReplicate().NodeId(expectedMasterID).Build()
			if err := client.Do(ctx, cmd).Error(); err != nil {
				client.Close()
				return fmt.Errorf("failed to set replica %d-%d: %w", i, j, err)
			}

			client.Close()
		}
	}

	return nil
}

func ensureNoExcessNodes(ctx context.Context, current, desired *ClusterTopology, podFQDNs []string) error {
	logger := log.FromContext(ctx)

	currentNodeCount := len(current.Masters) + len(current.Replicas)
	desiredNodeCount := len(desired.Masters) + len(desired.Replicas)

	if currentNodeCount <= desiredNodeCount {
		return nil
	}

	logger.Info("Removing excess nodes", "current", currentNodeCount, "desired", desiredNodeCount)

	for i := desiredNodeCount; i < currentNodeCount && i < len(podFQDNs); i++ {
		client, err := ConnectToValkeyNode(ctx, podFQDNs[i])
		if err != nil {
			continue
		}

		resp := client.Do(ctx, client.B().ClusterMyid().Build())
		if resp.Error() != nil {
			client.Close()
			continue
		}

		nodeID, err := resp.ToString()
		client.Close()
		if err != nil {
			continue
		}

		for j := 0; j < desiredNodeCount && j < len(podFQDNs); j++ {
			otherClient, err := ConnectToValkeyNode(ctx, podFQDNs[j])
			if err != nil {
				continue
			}

			cmd := otherClient.B().ClusterForget().NodeId(nodeID).Build()
			otherClient.Do(ctx, cmd)
			otherClient.Close()
		}

		logger.Info("Forgot node", "nodeID", nodeID)
	}

	return nil
}
