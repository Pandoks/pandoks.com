package controller

import (
	"context"
	"fmt"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/cluster"

	"sigs.k8s.io/controller-runtime/pkg/log"
)

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
	currentAddressSet := make(map[string]struct{}, len(currentAddresses))
	for _, address := range currentAddresses {
		currentAddressSet[address.String()] = struct{}{}
	}
	for _, address := range clientAddresses {
		addressString := address.String()
		if _, exists := currentAddressSet[addressString]; !exists {
			meetCmd := seedClient.B().ClusterMeet().Ip(addressString).Port(cluster.ValkeyClientPort).Build()
			if err := seedClient.Do(ctx, meetCmd).Error(); err != nil {
				return fmt.Errorf("failed to meet node %s: %w", address.String(), err)
			}
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

	err = cluster.ReconcileSlots(currentTopology, cluster.DesiredTopology(valkeyCluster))
	output, err = cluster.QueryClusterNodes(ctx, seedClient)
	if err != nil {
		return fmt.Errorf("failed to query cluster nodes: %w", err)
	}
	currentTopology, err = cluster.ParseClusterTopology(output)
	if err != nil {
		return fmt.Errorf("failed to parse cluster nodes: %w", err)
	}

	if err := r.ensureNoExcessNodes(ctx, currentTopology, desiredTopology, podFQDNs); err != nil {
		return fmt.Errorf("failed to ensure no excess nodes: %w", err)
	}

	logger.Info("Cluster is in desired state")
	return nil
}
