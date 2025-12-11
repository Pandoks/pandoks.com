package commands

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
	"valkey/reconciler/internal/utils"
	"valkey/reconciler/internal/valkey"

	valkeygo "github.com/valkey-io/valkey-go"
)

func ScaleDown(env utils.Env) error {
	fmt.Println("=== Valkey Cluster Scaling Down ===")

	clusterClientHostnames, err := valkey.GetClusterConnectionInfo(utils.GetHeadlessServiceFQDN(env.ClusterName, env.Namespace), env)
	if err != nil {
		return err
	}
	client, err := valkey.NewClient(valkeygo.ClientOption{
		InitAddress: clusterClientHostnames,
		Username:    valkey.AdminUser,
		Password:    env.AdminPassword,
	})
	if err != nil {
		return err
	}
	defer client.Close()

	clusterTopology, err := valkey.GetClusterTopology(client)
	if err != nil {
		return err
	}
	if healthy, err := clusterTopology.IsHealthy(); !healthy {
		return err
	}

	valkey.PrintClusterInfo(client)
	valkey.PrintClusterNodes(client)
	fmt.Println()

	currentMasterCount := len(clusterTopology.Masters)
	currentSlaveCount := len(clusterTopology.Slaves)
	originalClusterNodeCount := len(clusterTopology.OrderedNodes)
	nodeCount := originalClusterNodeCount
	currentReplicasPerMaster := currentSlaveCount / currentMasterCount

	desiredNodeCount := env.Masters + env.Masters*env.ReplicasPerMaster

	fmt.Printf("Current cluster information:\n")
	fmt.Printf("  Masters: %d\n", currentMasterCount)
	fmt.Printf("  Slaves: %d\n", currentSlaveCount)
	fmt.Printf("  Total nodes: %d\n", originalClusterNodeCount)
	fmt.Printf("  Replicas per master: %d\n", currentReplicasPerMaster)
	fmt.Println()

	fmt.Printf("Desired total nodes: %d\n", desiredNodeCount)
	fmt.Println()

	lastColonIndex := strings.LastIndex(clusterClientHostnames[0], ":")
	cliHostname := clusterClientHostnames[0][:lastColonIndex]
	cliBaseOptions := valkey.CliBaseOptions{
		Connection: valkey.Connection{
			Hostname: cliHostname,
			Port:     uint16(6379),
		},
		Auth: valkey.Auth{
			Username: valkey.AdminUser,
			Password: env.AdminPassword,
		},
	}

	helperOptions := &scaleDownOptions{
		client:         client,
		env:            env,
		topology:       &clusterTopology,
		nodeCount:      &nodeCount,
		cliBaseOptions: cliBaseOptions,
	}

	if currentMasterCount > env.Masters {
		if err := removeShards(helperOptions); err != nil {
			return err
		}
	} else if currentMasterCount < env.Masters {
		if err := makeRoomForMasters(helperOptions); err != nil {
			return err
		}
	}

	if currentReplicasPerMaster > env.ReplicasPerMaster {
		if err := removeReplicasFromMasters(helperOptions); err != nil {
			return err
		}
	}

	if originalClusterNodeCount <= desiredNodeCount {
		fmt.Println("No need to scale down nodes")
		valkey.PrintClusterInfo(client)
		valkey.PrintClusterNodes(client)
		fmt.Println("=== Scale Down Complete ===")
		return nil
	}

	if err := moveMastersToSafeSpots(helperOptions); err != nil {
		return err
	}

	if err := removeDangerZoneNodes(helperOptions); err != nil {
		return err
	}

	valkey.PrintClusterNodes(client)
	fmt.Println("=== Scale Down Complete ===")
	return nil
}

type scaleDownOptions struct {
	client         *valkey.ValkeyClient
	env            utils.Env
	topology       *valkey.Topology
	nodeCount      *int
	cliBaseOptions valkey.CliBaseOptions
}

func removeShards(options *scaleDownOptions) error {
	fmt.Println("Removing shards...")

	client, clusterTopology, env := options.client, *options.topology, options.env
	currentMasterCount := len(clusterTopology.Masters)
	currentSlaveCount := len(clusterTopology.Slaves)
	currentReplicasPerMaster := currentSlaveCount / currentMasterCount

	shardsToRemove := clusterTopology.OrderedShards[env.Masters:]
	removedNodeHostnames := make(map[string]struct{}, len(shardsToRemove)*currentReplicasPerMaster)

	fmt.Println("Shards to remove:")
	for _, shard := range shardsToRemove {
		fmt.Printf("  Master ID: %s\n", shard.MasterId)

		masterNode, exists := clusterTopology.Masters[shard.MasterId]
		if !exists {
			return fmt.Errorf("master %s not found in topology", shard.MasterId)
		}
		removedNodeHostnames[fmt.Sprintf("%s:%d", masterNode.Node.Hostname, masterNode.Node.Port)] = struct{}{}
		for _, slaveId := range masterNode.SlaveIds {
			slaveNode, exists := clusterTopology.Slaves[slaveId]
			if !exists {
				return fmt.Errorf("slave %s not found in topology", slaveId)
			}
			removedNodeHostnames[fmt.Sprintf("%s:%d", slaveNode.Hostname, slaveNode.Port)] = struct{}{}
		}

		forgetShardOptions := valkey.DelShardOptions{
			Shard:    shard,
			Topology: clusterTopology,
			Env:      env,
		}
		newClusterTopology, err := valkey.DelShard(forgetShardOptions)
		if err != nil {
			return err
		}
		clusterTopology = newClusterTopology
	}

	*options.nodeCount -= len(shardsToRemove) + len(shardsToRemove)*currentReplicasPerMaster

	leftOverNodeHostnames := make([]string, 0, *options.nodeCount)
	for _, node := range clusterTopology.OrderedNodes {
		hostname := fmt.Sprintf("%s:%d", node.Hostname, node.Port)
		if _, exists := removedNodeHostnames[hostname]; !exists {
			leftOverNodeHostnames = append(leftOverNodeHostnames, hostname)
		}
	}

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := valkey.WaitForAllNodesClusterInfoState(
		timeoutCtx,
		env,
		leftOverNodeHostnames,
		fmt.Sprintf("cluster_known_nodes:%d", *options.nodeCount)); err != nil {
		return err
	}

	client.Refresh(leftOverNodeHostnames...)
	clusterTopology, err := valkey.GetClusterTopology(client.Client)
	if err != nil {
		return err
	}
	options.topology = &clusterTopology

	clusterTopology.Print()
	fmt.Println("✓ Shards removed")
	valkey.PrintClusterNodes(client)
	return nil
}

func makeRoomForMasters(options *scaleDownOptions) error {
	fmt.Println("Making room for new masters in safe spots...")

	client, env, clusterTopology := options.client, options.env, *options.topology
	currentMasterCount := len(clusterTopology.Masters)

	var nodesToRemove []valkey.ClusterNode
	var leftOverNodes []valkey.ClusterNode
	if env.Masters > *options.nodeCount {
		nodesToRemove = clusterTopology.OrderedNodes[currentMasterCount:]
		leftOverNodes = make([]valkey.ClusterNode, currentMasterCount)
		copy(leftOverNodes, clusterTopology.OrderedNodes[:currentMasterCount])
	} else {
		nodesToRemove = clusterTopology.OrderedNodes[currentMasterCount:env.Masters]
		leftOverNodes = make([]valkey.ClusterNode, 0, len(clusterTopology.OrderedNodes)-(env.Masters-currentMasterCount))
		leftOverNodes = append(leftOverNodes, clusterTopology.OrderedNodes[:currentMasterCount]...)
		leftOverNodes = append(leftOverNodes, clusterTopology.OrderedNodes[env.Masters:]...)
	}
	leftOverNodeHostnames := make([]string, 0, len(leftOverNodes))
	for _, node := range leftOverNodes {
		leftOverNodeHostnames = append(leftOverNodeHostnames, fmt.Sprintf("%s:%d", node.Hostname, node.Port))
	}

	fmt.Println("Nodes to remove:")
	for _, node := range nodesToRemove {
		fmt.Printf("  %s\n", node.ID)
	}
	fmt.Println()

	for _, node := range nodesToRemove {
		if node.Master == "" {
			// NOTE: because the topology is healthy at the start of scale down function,
			// we should only be removing replicas. If we encounter a master, that means that there is a
			// pod in the safe zone
			fmt.Println("Node is a master, moving master to a safe spot...")

			var shard valkey.Shard
			for _, shard = range clusterTopology.OrderedShards {
				if shard.MasterId == node.ID {
					break
				}
			}
			if shard.MasterId != node.ID {
				return fmt.Errorf("shard for master %s not found in topology", node.ID)
			}

			promoteOriginalShardLeaderOptions := valkey.PromoteOriginalShardLeaderOptions{
				ClusterClient: client.Client,
				Shard:         shard,
				Topology:      clusterTopology,
			}
			timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			newMasterHostname, newSlaveHostname, err := valkey.PromoteOriginalShardLeader(timeoutCtx, promoteOriginalShardLeaderOptions)
			if err != nil {
				return err
			}

			newMasterMatchingStrings := []string{
				fmt.Sprintf("%s master", newMasterHostname),
				fmt.Sprintf("%s myself,master", newMasterHostname),
			}
			newSlaveMatchingStrings := []string{
				fmt.Sprintf("%s slave", newSlaveHostname),
				fmt.Sprintf("%s myself,slave", newSlaveHostname),
			}
			newlyReshardedOriginalLeaderStringMatches := [][]string{newMasterMatchingStrings, newSlaveMatchingStrings}
			timeoutCtx, cancel = context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			if err := valkey.WaitForAllNodesClusterNodeContains(timeoutCtx, env, leftOverNodeHostnames, newlyReshardedOriginalLeaderStringMatches...); err != nil {
				return err
			}

			fmt.Println("✓ Master moved to safe spot")
		}

		if err := valkey.DelNode(valkey.DelNodeOptions{CliBaseOptions: options.cliBaseOptions, NodeID: node.ID}); err != nil {
			return err
		}
	}

	*options.nodeCount -= len(nodesToRemove)

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := valkey.WaitForAllNodesClusterInfoState(timeoutCtx, env, leftOverNodeHostnames, fmt.Sprintf("cluster_known_nodes:%d", *options.nodeCount)); err != nil {
		return err
	}

	client.Refresh(leftOverNodeHostnames...)
	clusterTopology, err := valkey.GetClusterTopology(client.Client)
	if err != nil {
		return err
	}
	options.topology = &clusterTopology

	clusterTopology.Print()
	fmt.Println("✓ Nodes removed")
	fmt.Println()

	return nil
}

func removeReplicasFromMasters(options *scaleDownOptions) error {
	fmt.Println("Removing replicas...")

	client, clusterTopology, env := options.client, *options.topology, options.env
	clusterTopology.Print()

	removedNodeHostnames := map[string]struct{}{}

	for _, masterNode := range clusterTopology.Masters {
		if len(masterNode.SlaveIds) <= env.ReplicasPerMaster {
			continue
		}

		slaveNodes := make([]valkey.ClusterNode, 0, len(masterNode.SlaveIds))
		for _, slaveId := range masterNode.SlaveIds {
			slaveNode, exists := clusterTopology.Slaves[slaveId]
			if !exists {
				return fmt.Errorf("slave %s not found in topology", slaveId)
			}
			slaveNodes = append(slaveNodes, slaveNode)
		}

		sort.Slice(slaveNodes, func(i, j int) bool {
			return slaveNodes[i].Index() < slaveNodes[j].Index()
		})

		nodesToDelete := slaveNodes[env.ReplicasPerMaster:] // remove the replicas from the later statefulset pod indices
		fmt.Printf("Nodes to remove for master %s:\n", masterNode.Node.ID)

		for _, node := range nodesToDelete {
			fmt.Printf("  %s\n", node.ID)
		}
		fmt.Println()
		for _, node := range nodesToDelete {
			removedNodeHostnames[fmt.Sprintf("%s:%d", node.Hostname, node.Port)] = struct{}{}

			if err := valkey.DelNode(valkey.DelNodeOptions{CliBaseOptions: options.cliBaseOptions, NodeID: node.ID}); err != nil {
				return err
			}
			*options.nodeCount -= 1
		}
		fmt.Printf("✓ Nodes removed for master %s\n", masterNode.Node.ID)
		fmt.Println()
	}

	leftOverNodeHostnames := make([]string, 0, *options.nodeCount)
	for _, node := range clusterTopology.OrderedNodes {
		if _, exists := removedNodeHostnames[fmt.Sprintf("%s:%d", node.Hostname, node.Port)]; !exists {
			leftOverNodeHostnames = append(leftOverNodeHostnames, fmt.Sprintf("%s:%d", node.Hostname, node.Port))
		}
	}

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := valkey.WaitForAllNodesClusterInfoState(
		timeoutCtx,
		env,
		leftOverNodeHostnames,
		fmt.Sprintf("cluster_known_nodes:%d", *options.nodeCount)); err != nil {
		return err
	}

	client.Refresh(leftOverNodeHostnames...)
	clusterTopology, err := valkey.GetClusterTopology(client.Client)
	if err != nil {
		return err
	}
	options.topology = &clusterTopology

	clusterTopology.Print()
	fmt.Println("✓ Replicas removed")
	fmt.Println()

	return nil
}

func moveMastersToSafeSpots(options *scaleDownOptions) error {
	fmt.Println("Moving masters to safe spots...")

	client, clusterTopology, env := options.client, *options.topology, options.env
	desiredNodeCount := env.Masters + env.Masters*env.ReplicasPerMaster
	lastSafeNodeIndex := desiredNodeCount - 1

	hostnames := make([]string, 0, len(clusterTopology.OrderedNodes))
	for _, node := range clusterTopology.OrderedNodes {
		hostnames = append(hostnames, fmt.Sprintf("%s:%d", node.Hostname, node.Port))
	}

	modifiedTopology := false
	for _, shard := range clusterTopology.OrderedShards {
		masterNode, exists := clusterTopology.Masters[shard.MasterId]
		if !exists {
			return fmt.Errorf("master %s not found in topology", shard.MasterId)
		}
		if masterNode.Node.Index() <= lastSafeNodeIndex {
			continue
		}

		fmt.Printf("Moving master %s to safe spot...\n", masterNode.Node.ID)
		// NOTE: because the topology is healthy at the start of scale down function,
		// there will always be a pod that isn't going to be removed from a statefulset scale down
		promoteOriginalShardLeaderOptions := valkey.PromoteOriginalShardLeaderOptions{
			ClusterClient: client.Client,
			Shard:         shard,
			Topology:      clusterTopology,
		}
		timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		newMasterHostname, newSlaveHostname, err := valkey.PromoteOriginalShardLeader(timeoutCtx, promoteOriginalShardLeaderOptions)
		if err != nil {
			return err
		}

		newMasterMatchingStrings := []string{
			fmt.Sprintf("%s master", newMasterHostname),
			fmt.Sprintf("%s myself,master", newMasterHostname),
		}
		newSlaveMatchingStrings := []string{
			fmt.Sprintf("%s slave", newSlaveHostname),
			fmt.Sprintf("%s myself,slave", newSlaveHostname),
		}
		newlyReshardedOriginalLeaderStringMatches := [][]string{newMasterMatchingStrings, newSlaveMatchingStrings}
		timeoutCtx, cancel = context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := valkey.WaitForAllNodesClusterNodeContains(timeoutCtx, env, hostnames, newlyReshardedOriginalLeaderStringMatches...); err != nil {
			return err
		}

		fmt.Println("✓ Master moved to safe spot")
		fmt.Println()

		modifiedTopology = true
	}

	if !modifiedTopology {
		fmt.Println("No need to move masters to safe spots. Masters are already in safe spots")
		return nil
	}

	newTopology, err := valkey.GetClusterTopology(client.Client)
	if err != nil {
		return err
	}
	options.topology = &newTopology

	newTopology.Print()
	fmt.Println("✓ Masters moved to safe spots")
	fmt.Println()
	return nil
}

func removeDangerZoneNodes(options *scaleDownOptions) error {
	fmt.Println("Removing nodes in danger zones...")
	fmt.Println("Nodes in danger zones:")

	client, clusterTopology, env := options.client, *options.topology, options.env
	desiredNodeCount := env.Masters + env.Masters*env.ReplicasPerMaster
	lastSafeNodeIndex := desiredNodeCount - 1

	leftOverNodeHostnames := make([]string, 0, desiredNodeCount)

	// NOTE: can't precompute using OrderedNodes[lastSafeNodeIndex:] because it's not guaranteed to all be in the topology
	for _, node := range clusterTopology.OrderedNodes {
		if node.Index() <= lastSafeNodeIndex {
			leftOverNodeHostnames = append(leftOverNodeHostnames, fmt.Sprintf("%s:%d", node.Hostname, node.Port))
			continue
		}

		fmt.Printf("  %s\n", node.ID)
		if err := valkey.DelNode(valkey.DelNodeOptions{CliBaseOptions: options.cliBaseOptions, NodeID: node.ID}); err != nil {
			return err
		}
		*options.nodeCount -= 1
	}

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := valkey.WaitForAllNodesClusterInfoState(timeoutCtx, env, leftOverNodeHostnames, fmt.Sprintf("cluster_known_nodes:%d", *options.nodeCount)); err != nil {
		return err
	}
	client.Refresh(leftOverNodeHostnames...)
	clusterTopology, err := valkey.GetClusterTopology(client)
	if err != nil {
		return err
	}
	options.topology = &clusterTopology

	clusterTopology.Print()
	fmt.Println("✓ Nodes removed from danger zones")
	fmt.Println()

	return nil
}
