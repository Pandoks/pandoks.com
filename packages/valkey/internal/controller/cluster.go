package controller

import (
	"context"
	"fmt"
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

	seedClient, err := cluster.ConnectToValkeyNode(ctx, clientAddresses[0].String())
	if err != nil {
		return fmt.Errorf("failed to connect to seed node: %w", err)
	}
	defer seedClient.Close()

	output, err := cluster.QueryClusterNodes(ctx, seedClient)
	var currentTopology *cluster.ClusterTopology
	if err == nil {
		currentTopology, err = cluster.ParseClusterTopology(output)
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
			meetCmd := seedClient.B().ClusterMeet().Ip(address.Host).Port(cluster.ValkeyClientPort).Build()
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
	currentTopology, err = cluster.ParseClusterTopology(output)
	if err != nil {
		return fmt.Errorf("failed to parse cluster nodes: %w", err)
	}

	masterClients := []valkey.Client{}
	for _, master := range currentTopology.Masters {
		client, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{master.Address.String()}})
		if err != nil {
			return fmt.Errorf("failed to create client for %s: %w", master.Address.String(), err)
		}
		masterClients = append(masterClients, client)
	}
	defer func() {
		for _, client := range masterClients {
			client.Close()
		}
	}()

	// ensure slots are uniformly distributed amongst the masters
	slotsToAdd, slotsToMigrate, err := cluster.CalculateSlotsToReconcile(currentTopology, cluster.DesiredTopology(valkeyCluster))
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
				client := masterClients[i]
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
						slot := slot

						semaphore <- struct{}{}
						group.Go(func() error {
							defer func() { <-semaphore }()
							return cluster.MigrateSlot(ctx, int64(slot), migrationRoute, masterClients, currentTopology)
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
		currentTopology, err = cluster.ParseClusterTopology(output)
		if err != nil {
			return fmt.Errorf("failed to parse cluster nodes: %w", err)
		}
	}

	// TODO: ensure replicas are assigned properly to masters with the proper count

	// TODO: cleanup excess nodes (scale down)

	logger.Info("Cluster is in desired state")
	return nil
}
