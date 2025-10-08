package cluster

import (
	"context"
	"fmt"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/slot"

	"sigs.k8s.io/controller-runtime/pkg/log"
)

type NodeRole string

// NOTE: unfortunately, valkey uses inclusive language for the role names
// Redis uses "master" and "slave" for roles
// Valkey uses "master" and "replica" for roles
const (
	NodeRoleMaster NodeRole = "master"
	NodeRoleSlave  NodeRole = "slave"
)

type ClusterNode struct {
	ID         string
	FQDN       string
	Host       string
	Port       int
	Role       NodeRole // master | slave (we do not use inclusive language here)
	MasterID   string
	SlotRanges []slot.SlotRange // [start, end] both inclusive
	Connected  bool
}

type ClusterTopology struct {
	Nodes    map[string]*ClusterNode // nodeID -> node
	Masters  []*ClusterNode
	Replicas []*ClusterNode
}

// desiredTopology calculates the desired cluster topology based on the spec. Note that the ids are not supposed to match
// the actual cluster state because it doesn't have access to the actual cluster. The master ids are named 'master-i' and
// the replica ids are named 'replica-i-j' where i is the master index and j is the replica index.
func DesiredTopology(valkeyCluster *valkeyv1.ValkeyCluster) *ClusterTopology {
	topology := &ClusterTopology{
		Nodes: map[string]*ClusterNode{},
	}

	numMasters := valkeyCluster.Spec.Masters
	desiredSlotRanges := slot.DesiredSlotRanges(numMasters)

	for i := range numMasters {
		masterId := fmt.Sprintf("master-%d", i)
		masterNode := &ClusterNode{
			ID:         masterId,
			Role:       NodeRoleMaster,
			SlotRanges: []slot.SlotRange{desiredSlotRanges[i]},
		}
		topology.Masters = append(topology.Masters, masterNode)
		topology.Nodes[masterNode.ID] = masterNode

		for j := range valkeyCluster.Spec.ReplicasPerMaster {
			slaveNode := &ClusterNode{
				ID:       fmt.Sprintf("replica-%d-%d", i, j),
				Role:     NodeRoleSlave,
				MasterID: masterId,
			}
			topology.Replicas = append(topology.Replicas, slaveNode)
			topology.Nodes[slaveNode.ID] = slaveNode
		}
	}

	return topology
}

func (r *ValkeyClusterReconciler) ensureSlots(ctx context.Context, current, desired *ClusterTopology) error {
	logger := log.FromContext(ctx)
	podFQDNs := current.fqdns()

	numDesiredMasters := len(desired.Masters)
	if numDesiredMasters == 0 {
		return fmt.Errorf("no masters available to assign slots")
	}

	slotOwner := make(map[int]string)
	currentSlotsByMaster := make(map[string][]int)

	for _, master := range current.Masters {
		for _, slotRange := range master.SlotRanges {
			for slot := slotRange.Start; slot <= slotRange.End; slot++ {
				slotOwner[slot] = master.FQDN
				currentSlotsByMaster[master.FQDN] = append(currentSlotsByMaster[master.FQDN], slot)
			}
		}
	}

	numAssignedSlots := len(slotOwner)

	// Case 1: No slots assigned (bootstrap)
	if numAssignedSlots == 0 {
		return r.bootstrapSlots(ctx, numDesiredMasters, podFQDNs, logger)
	}

	// Case 2: Partial assignment (recovery)
	if numAssignedSlots < slot.TotalSlots {
		return r.recoverMissingSlots(ctx, slotOwner, numDesiredMasters, podFQDNs, logger)
	}

	// Case 3: All slots assigned - check if rebalancing needed
	desiredMasterFQDNs := podFQDNs[:numDesiredMasters]
	return r.rebalanceSlots(ctx, slotOwner, currentSlotsByMaster, desiredMasterFQDNs, logger)
}

func (r *ValkeyClusterReconciler) bootstrapSlots(ctx context.Context, numMasters int, podFQDNs []string, logger any) error {
	type loggerInterface interface {
		Info(msg string, keysAndValues ...any)
	}
	log := logger.(loggerInterface)

	log.Info("No slots assigned, bootstrapping cluster")
	slotRanges := slot.DesiredSlotRanges(int32(numMasters))

	for i := 0; i < numMasters; i++ {
		client, err := r.connectToValkeyNode(ctx, podFQDNs[i])
		if err != nil {
			return fmt.Errorf("failed to connect to master %d: %w", i, err)
		}

		slotRange := slotRanges[i]
		slots := make([]int64, 0, slotRange.End-slotRange.Start+1)
		for slot := slotRange.Start; slot <= slotRange.End; slot++ {
			slots = append(slots, int64(slot))
		}

		log.Info("Assigning slots to master", "masterIndex", i, "slots", fmt.Sprintf("%d-%d", slotRange.Start, slotRange.End))
		cmd := client.B().ClusterAddslots().Slot(slots...).Build()
		if err := client.Do(ctx, cmd).Error(); err != nil {
			client.Close()
			return fmt.Errorf("failed to assign slots to master %d: %w", i, err)
		}

		client.Close()
	}
	return nil
}

func (r *ValkeyClusterReconciler) recoverMissingSlots(ctx context.Context, slotOwner map[int]string, numMasters int, podFQDNs []string, logger any) error {
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

		client, err := r.connectToValkeyNode(ctx, podFQDNs[i])
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

func (r *ValkeyClusterReconciler) rebalanceSlots(ctx context.Context, slotOwner map[int]string, currentSlotsByMaster map[string][]int, desiredMasterFQDNs []string, logger any) error {
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

	migrations := r.calculateMigrationPlan(slotOwner, currentSlotsByMaster, desiredMasterFQDNs, desiredSlotsPerMaster, desiredMasterSet)

	if len(migrations) == 0 {
		log.Info("Slot distribution balanced, no migration needed")
		return nil
	}

	log.Info("Rebalancing slots", "numMigrations", len(migrations))

	for _, migration := range migrations {
		if err := r.migrateSlot(ctx, migration, logger); err != nil {
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

func (r *ValkeyClusterReconciler) calculateMigrationPlan(
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

func (r *ValkeyClusterReconciler) migrateSlot(ctx context.Context, migration slotMigration, logger any) error {
	type loggerInterface interface {
		Info(msg string, keysAndValues ...any)
	}
	log := logger.(loggerInterface)

	sourceClient, err := r.connectToValkeyNode(ctx, migration.SourceFQDN)
	if err != nil {
		return fmt.Errorf("failed to connect to source: %w", err)
	}
	defer sourceClient.Close()

	destClient, err := r.connectToValkeyNode(ctx, migration.DestFQDN)
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

func (r *ValkeyClusterReconciler) ensureReplicas(ctx context.Context, current, desired *ClusterTopology, podFQDNs []string) error {
	logger := log.FromContext(ctx)

	numMasters := len(desired.Masters)
	replicasPerMaster := len(desired.Replicas) / numMasters

	if replicasPerMaster == 0 {
		return nil
	}

	masterIDs := make([]string, numMasters)
	for i := 0; i < numMasters; i++ {
		client, err := r.connectToValkeyNode(ctx, podFQDNs[i])
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

			client, err := r.connectToValkeyNode(ctx, replicaFQDN)
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

func (r *ValkeyClusterReconciler) ensureNoExcessNodes(ctx context.Context, current, desired *ClusterTopology, podFQDNs []string) error {
	logger := log.FromContext(ctx)

	currentNodeCount := len(current.Masters) + len(current.Replicas)
	desiredNodeCount := len(desired.Masters) + len(desired.Replicas)

	if currentNodeCount <= desiredNodeCount {
		return nil
	}

	logger.Info("Removing excess nodes", "current", currentNodeCount, "desired", desiredNodeCount)

	for i := desiredNodeCount; i < currentNodeCount && i < len(podFQDNs); i++ {
		client, err := r.connectToValkeyNode(ctx, podFQDNs[i])
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
			otherClient, err := r.connectToValkeyNode(ctx, podFQDNs[j])
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

func (t *ClusterTopology) fqdns() []string {
	fqdns := make([]string, 0, len(t.Nodes))
	for _, node := range t.Nodes {
		fqdns = append(fqdns, node.FQDN)
	}
	return fqdns
}
