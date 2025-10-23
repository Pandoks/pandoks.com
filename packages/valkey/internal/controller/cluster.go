package controller

import (
	"context"
	"errors"
	"fmt"
	"net"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/cluster"
	"valkey/operator/internal/slot"

	"github.com/valkey-io/valkey-go"
	"golang.org/x/sync/errgroup"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

const slotMigrationConcurrency = 10

var ErrNodesMeeting = errors.New("nodes meeting")

// Steps to reconcile cluster:
//
//  1. Connects to the seed node (statefulset pod 0) and query the cluster topology (CLUSTER NODE)
//  2. Joins the nodes in valkeyCluster (statefulsets that aren't part of the valkey cluster yet) that are not part of the current cluster topology (CLUSTER MEET)
//  3. Ensures all slots are properly uniformly distributed amongst the masters
func (r *ValkeyClusterReconciler) reconcileCluster(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster) error {
	logger := log.FromContext(ctx)

	// fqdn: fully qualified domain name
	clientAddresses := r.valkeyClientAddresses(valkeyCluster)
	if len(clientAddresses) == 0 {
		return fmt.Errorf("no pod FQDNs provided")
	}
	addresses := stringifyAddresses(clientAddresses)

	seedClient, err := valkey.NewClient(valkey.ClientOption{
		InitAddress: []string{addresses[0]},
	})
	if err != nil {
		return fmt.Errorf("failed to connect to seed node: %w", err)
	}
	defer seedClient.Close()

	headlessServiceName := valkeyCluster.HeadlessServiceName()
	namespace := valkeyCluster.Namespace
	currentTopology, err := cluster.GetTopology(ctx, seedClient, headlessServiceName, namespace)
	if err != nil {
		currentTopology = &cluster.ClusterTopology{
			Nodes: map[string]*cluster.ClusterNode{},
		}
	}

	// join nodes that are not part of the current cluster topology through CLUSTER MEET
	// seed node (client) is alone a cluster that births everything so we need to add nodes to it
	currentAddresses := currentTopology.Addresses()
	currentAddressSet := make(map[cluster.Address]struct{}, len(currentAddresses))
	for _, address := range currentAddresses {
		currentAddressSet[address] = struct{}{}
	}

	nodesToMeet := []cluster.Address{}
	for _, address := range clientAddresses {
		if _, exists := currentAddressSet[address]; !exists {
			nodesToMeet = append(nodesToMeet, address)
		}
	}
	if len(nodesToMeet) > 0 {
		resolver := &net.Resolver{}
		addressToIP := make(map[cluster.Address]net.IP, len(clientAddresses))
		for _, address := range clientAddresses {
			ips, err := resolver.LookupIP(ctx, "ip4", address.Host)
			if err != nil {
				return fmt.Errorf("failed to resolve IP for %s: %w", address.String(), err)
			}
			if len(ips) == 0 {
				return fmt.Errorf("failed to resolve IP for %s: no IPs found", address.String())
			}
			addressToIP[address] = ips[0]
		}

		logger.Info("Meeting standalone valkey nodes that aren't part of the current cluster")
		valkeyClusterCopy := valkeyCluster.DeepCopy()
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeMeetingStandaloneNodes,
				Status:  metav1.ConditionTrue,
				Reason:  "MeetingStandaloneNodesInProgress",
				Message: "Meeting standalone valkey nodes that aren't part of the current cluster in progress",
			},
		)
		if err = r.Status().Patch(ctx, valkeyCluster, client.MergeFrom(valkeyClusterCopy)); err != nil {
			logger.Error(err, "Failed to patch valkey cluster status")
		}

		for _, address := range nodesToMeet {
			meetCmd := seedClient.B().ClusterMeet().Ip(addressToIP[address].String()).Port(cluster.ValkeyClientPort).Build()
			if err := seedClient.Do(ctx, meetCmd).Error(); err != nil {
				return fmt.Errorf("failed to meet node %s: %w", address.String(), err)
			}
		}
		return ErrNodesMeeting
	}

	// ensure slots are uniformly distributed amongst the correct masters
	desiredTopology := cluster.DesiredTopology(valkeyCluster)
	currentNodes, desiredNodes := currentTopology.Nodes.Array(), desiredTopology.Nodes.Array()
	if len(currentNodes) != len(desiredNodes) {
		return fmt.Errorf("current topology and desired topology have different number of nodes")
	}

	clients := seedClient.Nodes()

	enslavementMigration := map[uint8]string{}
	for i := range len(desiredNodes) {
		currentNode := currentNodes[i]
		desiredNode := desiredNodes[i]
		if currentNode.Role == cluster.NodeRoleSlave && desiredNode.Role == cluster.NodeRoleMaster { // do promotions now
			// NOTE: we need to migrate slaves to masters so slot migrations can be performed to the right masters if needed or else there will be no proper masters to migrate to
			client := clients[addresses[i]]
			promoteCmd := client.B().ClusterReset().Soft().Build()
			if err := client.Do(ctx, promoteCmd).Error(); err != nil {
				return fmt.Errorf("failed to promote slave %s to master: %w", currentNode.Address.String(), err)
			}
		} else if desiredNode.Role == cluster.NodeRoleSlave { // downgrade later
			// NOTE: we don't need to migrate masters to slaves or assign a slave to another master until after slot migrations
			desiredNodeMasterId := desiredNode.MasterID
			if desiredNodeMasterId == "" {
				return fmt.Errorf("desired slave node %s has no master id", desiredNode.ID)
			}
			desiredMasterNode := desiredTopology.Nodes[desiredNode.MasterID]
			if desiredMasterNode == nil {
				return fmt.Errorf("failed to get master node from desired topology %s", desiredNodeMasterId)
			}
			desiredNodeMasterIndex := desiredMasterNode.Index

			currentNodeMasterId := currentNode.MasterID
			var currentNodeMasterIndex int
			if currentNodeMasterId != "" {
				currentMasterNode := currentTopology.Nodes[currentNodeMasterId]
				if currentMasterNode == nil {
					return fmt.Errorf("failed to get master node from current topology %s", currentNodeMasterId)
				}
				currentNodeMasterIndex = currentMasterNode.Index
			}

			if masterNeedsEnslavement, misMatchingMasters := currentNodeMasterId == "", currentNodeMasterIndex != desiredNodeMasterIndex; masterNeedsEnslavement || misMatchingMasters {
				properMasterNode := currentNodes[desiredNodeMasterIndex]
				enslavementMigration[uint8(i)] = properMasterNode.ID
			}
		}
	}
	logger.Info("Enslavement plan created", "migration", enslavementMigration)

	slotsToAdd, slotsToMigrate, err := cluster.CalculateSlotsToReconcile(currentTopology, desiredTopology)
	if err != nil {
		return fmt.Errorf("failed to calculate slots to reconcile: %w", err)
	}

	needToAddSlots := false
	for _, slotRange := range slotsToAdd {
		if slotRange != nil {
			needToAddSlots = true
			break
		}
	}
	needToMigrateSlots := len(slotsToMigrate) > 0
	if needToAddSlots || needToMigrateSlots {
		valkeyClusterCopy := valkeyCluster.DeepCopy()
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeMigratingSlots,
				Status:  metav1.ConditionTrue,
				Reason:  "ReconcilingSlotsInProgress",
				Message: "Reconciling slots in progress",
			},
		)
		if err = r.Status().Patch(ctx, valkeyCluster, client.MergeFrom(valkeyClusterCopy)); err != nil {
			logger.Error(err, "Failed to patch valkey cluster status")
		}

		if needToAddSlots {
			logger.Info("Adding slots to masters", "slotsToAdd", slotsToAdd)
			for i := range len(desiredTopology.Masters) {
				slotsRangeTracker := slotsToAdd[i]
				if slotsRangeTracker == nil {
					continue
				}
				client := clients[addresses[i]]
				for _, slotRange := range slotsRangeTracker.SlotRanges() {
					cmd := client.B().ClusterAddslotsrange().StartSlotEndSlot().StartSlotEndSlot(int64(slotRange.Start), int64(slotRange.End)).Build()
					if err := client.Do(ctx, cmd).Error(); err != nil {
						return fmt.Errorf("failed to add slot range %d-%d to master %d: %w", slotRange.Start, slotRange.End, i, err)
					}
				}
			}
		}
		if needToMigrateSlots {
			slotsToMigrateLog := make(map[string][]slot.SlotRange, len(slotsToMigrate))
			for migrationRoute, slotRangeTracker := range slotsToMigrate {
				slotsToMigrateLog[fmt.Sprintf("source %d, destination %d", migrationRoute.SourceIndex, migrationRoute.DestinationIndex)] = slotRangeTracker.SlotRanges()
			}
			logger.Info("Migrating slots", "slotsToMigrate", slotsToMigrateLog)

			group, ctx := errgroup.WithContext(ctx)
			semaphore := make(chan struct{}, slotMigrationConcurrency)

			for migrationRoute, slotRangeTracker := range slotsToMigrate {
				for _, slotRange := range slotRangeTracker.SlotRanges() {
					for slot := slotRange.Start; slot <= slotRange.End; slot++ {
						semaphore <- struct{}{}
						group.Go(func() error {
							defer func() { <-semaphore }()
							return cluster.MigrateSlot(
								ctx,
								int64(slot),
								cluster.MigrationInfo{
									Clients: cluster.MigrationClients{
										Source:      clients[addresses[migrationRoute.SourceIndex]],
										Destination: clients[addresses[migrationRoute.DestinationIndex]],
									},
									Nodes: cluster.MigrationNodes{
										Source:      currentTopology.Masters[migrationRoute.SourceIndex],
										Destination: currentTopology.Masters[migrationRoute.DestinationIndex],
									},
								})
						})
					}
				}
			}
			if err := group.Wait(); err != nil {
				return fmt.Errorf("failed to migrate slots: %w", err)
			}
		}

		valkeyClusterCopy = valkeyCluster.DeepCopy()
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeMigratingSlots,
				Status:  metav1.ConditionFalse,
				Reason:  "ReconcilingSlotsSucceeded",
				Message: "Reconciling slots succeeded",
			},
		)
		if err = r.Status().Patch(ctx, valkeyCluster, client.MergeFrom(valkeyClusterCopy)); err != nil {
			logger.Error(err, "Failed to patch valkey cluster status")
		}

		currentTopology, err = cluster.GetTopology(ctx, seedClient, headlessServiceName, namespace)
		if err != nil {
			return fmt.Errorf("failed to get cluster topology: %w", err)
		}
	}

	currentNodes = currentTopology.Nodes.Array()
	// NOTE: this is a map for loop dumb ass, nodeIndex is not the for loop index, it is the key
	for nodeIndex, masterId := range enslavementMigration {
		node := currentNodes[nodeIndex]
		client := clients[addresses[nodeIndex]]

		if node.ID == masterId {
			return fmt.Errorf("BUG: trying to make node %s replicate itself (masterIdToReplicate=%s)", node.ID, masterId)
		}

		enslavementCmd := client.B().ClusterReplicate().NodeId(masterId).Build()
		if err := client.Do(ctx, enslavementCmd).Error(); err != nil {
			return fmt.Errorf("failed to enslave node %s: %w", node.ID, err)
		}
	}

	currentNodes = currentTopology.Nodes.Array()
	if len(currentNodes) > len(desiredNodes) {
		needToBeForgotten := currentNodes[len(desiredNodes):]
		for _, node := range needToBeForgotten {
			forgetCmd := seedClient.B().ClusterForget().NodeId(node.ID).Build()
			if err := seedClient.Do(ctx, forgetCmd).Error(); err != nil {
				return fmt.Errorf("failed to forget node %s: %w", node.ID, err)
			}
		}
	}

	logger.Info("Cluster is in desired state")
	return nil
}
