package controller

import (
	"context"
	"fmt"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/cluster"

	"sigs.k8s.io/controller-runtime/pkg/log"
)

func (r *ValkeyClusterReconciler) reconcileCluster(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster) error {
	logger := log.FromContext(ctx)

	// fqdn: fully qualified domain name
	podFQDNs := r.podFQDNs(valkeyCluster)
	if len(podFQDNs) == 0 {
		return fmt.Errorf("no pod FQDNs provided")
	}

	seedClient, err := cluster.ConnectToValkeyNode(ctx, podFQDNs[0])
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

	desiredTopology := cluster.DesiredTopology(valkeyCluster)

	// join nodes that are not part of the current cluster topology through CLUSTER MEET
	// seed node (client) is alone a cluster that births everything so we need to add nodes to it
	currentFQDNs := currentTopology.FQDNs()
	currentFQDNsSet := make(map[string]struct{}, len(currentFQDNs))
	for _, fqdn := range currentFQDNs {
		currentFQDNsSet[fqdn] = struct{}{}
	}
	for _, fqdn := range podFQDNs {
		if _, exists := currentFQDNsSet[fqdn]; !exists {
			meetCmd := seedClient.B().ClusterMeet().Ip(fqdn).Port(ValkeyClientPort).Build()
			if err := seedClient.Do(ctx, meetCmd).Error(); err != nil {
				return fmt.Errorf("failed to meet node %s: %w", fqdn, err)
			}
		}
	}

	// ensure slots are assigned properly/rebalanced
	currentSlotRangeTracker, err := currentTopology.SlotRangeTracker()
	if err != nil {
		return fmt.Errorf("failed to calculate current slot range: %w", err)
	}
	if len(currentSlotRangeTracker.SlotRanges()) == 0 { // needs boostrapping
		if err = cluster.BootstrapSlots(ctx, valkeyCluster.Spec.Masters, podFQDNs, logger); err != nil {
			return fmt.Errorf("failed to bootstrap slots: %w", err)
		}
	} else if !currentSlotRangeTracker.IsFullyCovered() { // partial assigned slots
		if err = cluster.RecoverMissingSlots(ctx, currentTopology.Masters, valkeyCluster.Spec.Masters, podFQDNs, logger); err != nil {
			return fmt.Errorf("failed to recover missing slots: %w", err)
		}
	} else { // all slots assigned - check for rebalancing
		if err = cluster.RebalanceSlots(ctx, currentTopology.Masters, currentTopology.Replicas, podFQDNs, logger); err != nil {
			return fmt.Errorf("failed to rebalance slots: %w", err)
		}
	}

	if err := r.ensureReplicas(ctx, currentTopology, desiredTopology, podFQDNs); err != nil {
		return fmt.Errorf("failed to ensure replicas: %w", err)
	}

	if err := r.ensureNoExcessNodes(ctx, currentTopology, desiredTopology, podFQDNs); err != nil {
		return fmt.Errorf("failed to ensure no excess nodes: %w", err)
	}

	logger.Info("Cluster is in desired state")
	return nil
}
