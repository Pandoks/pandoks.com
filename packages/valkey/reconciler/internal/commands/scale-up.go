package commands

import (
	"context"
	"fmt"
	"strings"
	"time"
	"valkey/reconciler/internal/utils"
	"valkey/reconciler/internal/valkey"

	valkeygo "github.com/valkey-io/valkey-go"
)

const confusedMessage = "how tf did this even happen... maybe something went wrong during scale down?"

func ScaleUp(env utils.Env) error {
	fmt.Println("=== Valkey Cluster Scaling Up ===")

	totalNodes := env.Masters + env.Masters*env.ReplicasPerMaster

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	statefulSetName := utils.GetStatefulsetName(env.ClusterName)
	err := utils.WaitForStatefulSetReady(timeoutCtx, env.Namespace, statefulSetName, totalNodes)
	if err != nil {
		return err
	}

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

	valkey.PrintClusterInfo(client)
	valkey.PrintClusterNodes(client)
	fmt.Println()

	clusterTopology, err := valkey.GetClusterTopology(client)
	if err != nil {
		return err
	}

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

	helperOptions := &scaleUpOptions{
		client:         client,
		env:            env,
		topology:       &clusterTopology,
		cliBaseOptions: cliBaseOptions,
	}

	currentMasterCount := len(clusterTopology.Masters)
	if currentMasterCount < env.Masters {
		if err := addMasters(helperOptions); err != nil {
			return err
		}
	} else if currentMasterCount > env.Masters {
		fmt.Println(confusedMessage)
		return fmt.Errorf(
			"current cluster has more masters than desired during scale up. desired masters: %d, current cluster masters: %d",
			env.Masters,
			currentMasterCount,
		)
	}

	currentNodeCount := len(clusterTopology.OrderedNodes)
	if currentNodeCount == totalNodes {
		return finalizeScaleUp(helperOptions)
	}

	if err := addReplicas(helperOptions); err != nil {
		return err
	}

	return finalizeScaleUp(helperOptions)
}

type scaleUpOptions struct {
	client         valkeygo.Client
	env            utils.Env
	topology       *valkey.Topology
	cliBaseOptions valkey.CliBaseOptions
}

func addMasters(options *scaleUpOptions) error {
	fmt.Println("Adding new masters...")

	client, env, clusterTopology := options.client, options.env, *options.topology
	currentMasterCount := len(clusterTopology.Masters)

	numberOfMastersToAdd := env.Masters - currentMasterCount
	hostnames := make([]string, 0, len(clusterTopology.Masters)+numberOfMastersToAdd)
	hostnameMatching := make([][]string, 0, numberOfMastersToAdd)
	for _, master := range clusterTopology.Masters {
		hostnames = append(hostnames, fmt.Sprintf("%s:%d", master.Node.Hostname, master.Node.Port))
		hostnameMatching = append(hostnameMatching, []string{master.Node.Hostname})
	}

	for i := range numberOfMastersToAdd {
		masterPodIndex := currentMasterCount + i
		masterHostname := utils.GetPodHeadlessServiceFQDN(env.ClusterName, env.Namespace, masterPodIndex)
		if _, exists := client.Nodes()[fmt.Sprintf("%s:%d", masterHostname, 6379)]; exists {
			return fmt.Errorf("pod %s is already part of the cluster. expected pod to not be part of cluster", masterHostname)
		}

		fmt.Printf("  Adding master %s...\n", masterHostname)
		addNodeOptions := valkey.AddNodeOptions{
			CliBaseOptions: options.cliBaseOptions,
			NewHostname:    masterHostname,
			NewPort:        uint16(6379),
		}
		if err := valkey.AddNode(addNodeOptions); err != nil {
			return err
		}

		hostnames = append(hostnames, fmt.Sprintf("%s:%d", masterHostname, 6379))
		hostnameMatching = append(hostnameMatching, []string{masterHostname})

		timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := valkey.WaitForAllNodesClusterNodeContains(timeoutCtx, env, hostnames, hostnameMatching...); err != nil {
			return err
		}

		fmt.Printf("  ✓ Master %s added\n", masterHostname)
	}

	clusterTopology, err := valkey.GetClusterTopology(client)
	if err != nil {
		return err
	}

	options.topology = &clusterTopology

	clusterTopology.Print()
	fmt.Println("✓ Masters added")
	return nil
}

func addReplicas(options *scaleUpOptions) error {
	client, env, clusterTopology := options.client, options.env, *options.topology

	freeNodeHostnames, err := findFreeNodeHostnames(env, clusterTopology)
	if err != nil {
		return err
	}

	fmt.Println("Adding/checking replicas...")
	replicasAdded := make(map[string]string, env.Masters*env.ReplicasPerMaster-len(clusterTopology.Slaves))
	for _, masterNode := range clusterTopology.Masters {
		slaveNodeCount := len(masterNode.SlaveIds)
		replicasToAdd := env.ReplicasPerMaster - slaveNodeCount

		if replicasToAdd == 0 {
			continue
		} else if replicasToAdd < 0 {
			fmt.Println(confusedMessage)
			return fmt.Errorf("master doesn't have desired number of replicas. it has more...")
		}

		for range replicasToAdd {
			if len(freeNodeHostnames) == 0 {
				fmt.Println(confusedMessage)
				return fmt.Errorf("not enough free nodes to add replicas")
			}
			freeNodeHostname := freeNodeHostnames[0]
			freeNodeHostnames = freeNodeHostnames[1:]

			fmt.Printf("  Adding replica %s for master %s...\n", freeNodeHostname, masterNode.Node.ID)

			addNodeOptions := valkey.AddNodeOptions{
				CliBaseOptions: options.cliBaseOptions,
				NewHostname:    freeNodeHostname,
				NewPort:        uint16(6379),
			}
			if err := valkey.AddNode(addNodeOptions); err != nil {
				return err
			}

			replicaClient, err := valkey.NewClient(valkeygo.ClientOption{
				InitAddress:       []string{fmt.Sprintf("%s:%d", freeNodeHostname, 6379)},
				Username:          valkey.AdminUser,
				Password:          env.AdminPassword,
				ForceSingleClient: true,
			})
			if err != nil {
				return err
			}

			// wait for metadata (master id) to be recieved by the replica via bus
			timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			if err := valkey.WaitForClusterNodeContains(timeoutCtx, replicaClient, []string{masterNode.Node.ID}); err != nil {
				return err
			}

			if err := valkey.Replicate(replicaClient, masterNode.Node.ID); err != nil {
				return err
			}

			currentClusterHostnames := make([]string, 0, len(clusterTopology.OrderedNodes)+len(replicasAdded))
			for _, node := range clusterTopology.OrderedNodes {
				currentClusterHostnames = append(currentClusterHostnames, fmt.Sprintf("%s:%d", node.Hostname, node.Port))
			}
			for hostname := range replicasAdded {
				currentClusterHostnames = append(currentClusterHostnames, fmt.Sprintf("%s:%d", hostname, 6379))
			}
			timeoutCtx, cancel = context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			if err := valkey.WaitForAllNodesClusterNodeContains(
				timeoutCtx,
				env,
				currentClusterHostnames,
				[]string{fmt.Sprintf("%s slave %s", freeNodeHostname, masterNode.Node.ID)}); err != nil {
				return err
			}

			replicaClient.Close()
			replicasAdded[freeNodeHostname] = masterNode.Node.ID

			fmt.Printf("✓ Replica %s added for master %s\n", freeNodeHostname, masterNode.Node.ID)
		}
	}

	if len(replicasAdded) > 0 {
		if err := waitForEntireClusterForReplicas(env, replicasAdded); err != nil {
			return err
		}

		clusterTopology, err := valkey.GetClusterTopology(client)
		if err != nil {
			return err
		}
		options.topology = &clusterTopology

		clusterTopology.Print()
	}

	fmt.Println("✓ Replicas added or checked")
	return nil
}

func findFreeNodeHostnames(env utils.Env, clusterTopology valkey.Topology) ([]string, error) {
	fmt.Println("Finding free nodes...")

	totalNodes, currentNodeCount := env.Masters+env.Masters*env.ReplicasPerMaster, len(clusterTopology.OrderedNodes)

	freeNodeHostnames := make([]string, 0, totalNodes-currentNodeCount)
	existingNodeHostnameSet := make(map[string]struct{}, len(clusterTopology.OrderedNodes))
	for _, node := range clusterTopology.OrderedNodes {
		existingNodeHostnameSet[node.Hostname] = struct{}{}
	}
	for i := range totalNodes {
		hostname := utils.GetPodHeadlessServiceFQDN(env.ClusterName, env.Namespace, i)
		if _, exists := existingNodeHostnameSet[hostname]; !exists {
			freeNodeHostnames = append(freeNodeHostnames, hostname)
		}
	}
	if len(freeNodeHostnames) < totalNodes-currentNodeCount {
		fmt.Println(confusedMessage)
		return nil, fmt.Errorf("expected %d free nodes, got %d", totalNodes-currentNodeCount, len(freeNodeHostnames))
	}
	fmt.Println("Free nodes found:")
	for _, hostname := range freeNodeHostnames {
		fmt.Printf("  %s\n", hostname)
	}
	fmt.Println("✓ Found free nodes")

	return freeNodeHostnames, nil
}

// wait for entire cluster to be fully updated via bus
func waitForEntireClusterForReplicas(env utils.Env, replicasAdded map[string]string) error {
	replicaStringMatches := make([][]string, 0, len(replicasAdded))
	for replicaHostname, masterId := range replicasAdded {
		slaveMatchingString := fmt.Sprintf("%s slave %s", replicaHostname, masterId)
		myselfSlaveMatchingString := fmt.Sprintf("%s myself,slave %s", replicaHostname, masterId)
		replicaStringMatches = append(replicaStringMatches, []string{slaveMatchingString, myselfSlaveMatchingString})
	}

	totalNodes := env.Masters + env.Masters*env.ReplicasPerMaster
	allHostnames := make([][]string, 0, totalNodes)
	for i := range totalNodes {
		allHostnames = append(allHostnames, []string{utils.GetPodHeadlessServiceFQDN(env.ClusterName, env.Namespace, i)})
	}

	allMatches := append(allHostnames, replicaStringMatches...)
	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := valkey.WaitForEntireClusterConsistencyClusterNodeContains(timeoutCtx, env, allMatches...); err != nil {
		return err
	}

	return nil
}

func finalizeScaleUp(options *scaleUpOptions) error {
	client, clusterTopology := options.client, *options.topology
	rebalanceOptions := valkey.RebalanceOptions{
		CliBaseOptions:  options.cliBaseOptions,
		UseEmptyMasters: true,
		Replace:         true,
	}

	if healthy, err := clusterTopology.IsHealthy(); !healthy {
		fmt.Println(confusedMessage)
		fmt.Println("Cluster is unhealthy with a proper amount of nodes. Something went wrong!")
		valkey.PrintClusterNodes(client)
		return err
	}

	fmt.Println("Rebalancing slots...")
	if err := valkey.Rebalance(rebalanceOptions); err != nil {
		return err
	}
	fmt.Println("✓ Slots rebalanced")
	fmt.Println()

	valkey.PrintClusterNodes(client)
	fmt.Println("=== Scale Up Complete ===")
	return nil
}
