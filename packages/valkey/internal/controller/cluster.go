package controller

import (
	"context"
	"fmt"
	"net"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/cluster"

	"github.com/valkey-io/valkey-go"
	"golang.org/x/sync/errgroup"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

const slotMigrationConcurrency = 10

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

	seedClient, err := cluster.ConnectToValkeyNode(ctx, clientAddresses[0].String())
	if err != nil {
		return fmt.Errorf("failed to connect to seed node: %w", err)
	}
	defer seedClient.Close()

	headlessServiceName := valkeyCluster.HeadlessServiceName()
	namespace := valkeyCluster.Namespace
	output, err := cluster.QueryClusterNodes(ctx, seedClient)
	var currentTopology *cluster.ClusterTopology
	if err == nil {
		currentTopology, err = cluster.ParseClusterTopology(output, headlessServiceName, namespace)
		if err != nil {
			return fmt.Errorf("failed to parse cluster nodes: %w", err)
		}
	} else {
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
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeMeetingStandaloneNodes,
				Status:  metav1.ConditionTrue,
				Reason:  "MeetingStandaloneNodesInProgress",
				Message: "Meeting standalone valkey nodes that aren't part of the current cluster in progress",
			},
		)
		if err := r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}

		for _, address := range nodesToMeet {
			meetCmd := seedClient.B().ClusterMeet().Ip(addressToIP[address].String()).Port(cluster.ValkeyClientPort).Build()
			if err := seedClient.Do(ctx, meetCmd).Error(); err != nil {
				return fmt.Errorf("failed to meet node %s: %w", address.String(), err)
			}
		}

		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeMeetingStandaloneNodes,
				Status:  metav1.ConditionFalse,
				Reason:  "MeetingStandaloneNodesSucceeded",
				Message: "Meeting standalone valkey nodes that aren't part of the current cluster succeeded",
			},
		)
		if err := r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}
	}

	// need to requery the cluster topology after each cluter mutation
	output, err = cluster.QueryClusterNodes(ctx, seedClient)
	if err != nil {
		return fmt.Errorf("failed to query cluster nodes: %w", err)
	}
	currentTopology, err = cluster.ParseClusterTopology(output, headlessServiceName, namespace)
	if err != nil {
		return fmt.Errorf("failed to parse cluster nodes: %w", err)
	}

	// ensure slots are uniformly distributed amongst the correct masters
	desiredTopology := cluster.DesiredTopology(valkeyCluster)
	currentNodes, desiredNodes := currentTopology.Nodes.Array(), desiredTopology.Nodes.Array()
	if len(currentNodes) != len(desiredNodes) {
		return fmt.Errorf("current topology and desired topology have different number of nodes")
	}

	clients := make([]valkey.Client, len(currentNodes))
	for i, node := range currentNodes {
		address := node.Address.String()
		client, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{address}})
		if err != nil {
			return fmt.Errorf("failed to create client for %s: %w", address, err)
		}
		clients[i] = client
	}
	defer func() {
		for _, client := range clients {
			client.Close()
		}
	}()

	enslavementMigration := map[uint8]string{}
	for i := range len(desiredNodes) {
		if currentNodes[i].Role == cluster.NodeRoleSlave && desiredNodes[i].Role == cluster.NodeRoleMaster { // do promotions now
			// NOTE: we need to migrate slaves to masters so slot migratiosn can be performed to the right masters if needed or else there will be no proper masters to migrate to
			client := clients[i]
			promoteCmd := client.B().Arbitrary("REPLICAOF", "NO", "ONE").Build()
			if err := client.Do(ctx, promoteCmd).Error(); err != nil {
				return fmt.Errorf("failed to promote slave %s to master: %w", currentNodes[i].Address.String(), err)
			}
		} else if currentNodes[i].Role != desiredNodes[i].Role || currentNodes[i].MasterID != desiredNodes[i].MasterID { // downgrade later
			// NOTE: we don't need to migrate masters to slaves or assign a slave to another master until after slot migrations
			enslavementMigration[uint8(i)] = desiredNodes[i].MasterID
		}
	}

	slotsToAdd, slotsToMigrate, err := cluster.CalculateSlotsToReconcile(currentTopology, desiredTopology)
	if err != nil {
		return fmt.Errorf("failed to calculate slots to reconcile: %w", err)
	}

	needToAddSlots := len(slotsToAdd) > 0
	needToMigrateSlots := len(slotsToMigrate) > 0
	if needToAddSlots || needToMigrateSlots {
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeMigratingSlots,
				Status:  metav1.ConditionTrue,
				Reason:  "ReconcilingSlotsInProgress",
				Message: "Reconciling slots in progress",
			},
		)
		if err := r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}

		if needToAddSlots {
			for i := range len(currentTopology.Masters) {
				client := clients[i]
				slotsRangeTracker := slotsToAdd[i]
				for _, slotRange := range slotsRangeTracker.SlotRanges() {
					cmd := client.B().ClusterAddslotsrange().StartSlotEndSlot().StartSlotEndSlot(int64(slotRange.Start), int64(slotRange.End)).Build()
					if err := client.Do(ctx, cmd).Error(); err != nil {
						return fmt.Errorf("failed to add slot range %d-%d to master %d: %w", slotRange.Start, slotRange.End, i, err)
					}
				}
			}
		}
		if needToMigrateSlots {
			group, ctx := errgroup.WithContext(ctx)
			semaphore := make(chan struct{}, slotMigrationConcurrency)

			for migrationRoute, slotRangeTracker := range slotsToMigrate {
				for _, slotRange := range slotRangeTracker.SlotRanges() {
					for slot := slotRange.Start; slot <= slotRange.End; slot++ {
						semaphore <- struct{}{}
						group.Go(func() error {
							defer func() { <-semaphore }()
							return cluster.MigrateSlot(ctx, int64(slot), migrationRoute, clients, currentTopology)
						})
					}
				}
			}
			if err := group.Wait(); err != nil {
				return fmt.Errorf("failed to migrate slots: %w", err)
			}
		}

		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeMigratingSlots,
				Status:  metav1.ConditionFalse,
				Reason:  "ReconcilingSlotsSucceeded",
				Message: "Reconciling slots succeeded",
			},
		)
		if err := r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}

		// Re-query cluster topology after slot reconciliation
		output, err = cluster.QueryClusterNodes(ctx, seedClient)
		if err != nil {
			return fmt.Errorf("failed to query cluster nodes: %w", err)
		}
		currentTopology, err = cluster.ParseClusterTopology(output, headlessServiceName, namespace)
		if err != nil {
			return fmt.Errorf("failed to parse cluster nodes: %w", err)
		}
	}

	for i, masterId := range enslavementMigration {
		client := clients[i]
		enslavementCmd := client.B().ClusterReplicate().NodeId(masterId).Build()
		if err := client.Do(ctx, enslavementCmd).Error(); err != nil {
			return fmt.Errorf("failed to enslave node %s: %w", currentNodes[i].ID, err)
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
