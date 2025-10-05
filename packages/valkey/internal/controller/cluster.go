package controller

import (
	"context"
	"fmt"
	"strings"
	valkeyv1 "valkey/operator/api/v1"

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
	SlotRanges []SlotRange // [start, end] both inclusive
	Connected  bool
}

type ClusterTopology struct {
	Nodes    map[string]*ClusterNode // nodeID -> node
	Masters  []*ClusterNode
	Replicas []*ClusterNode
}

func (r *ValkeyClusterReconciler) reconcileCluster(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster) error {
	logger := log.FromContext(ctx)

	// fqdn: fully qualified domain name
	podFQDNs := r.podFQDNs(valkeyCluster)
	if len(podFQDNs) == 0 {
		return fmt.Errorf("no pod FQDNs provided")
	}

	client, err := r.connectToValkeyNode(ctx, podFQDNs[0])
	if err != nil {
		return fmt.Errorf("failed to connect to seed node: %w", err)
	}
	defer client.Close()

	output, err := r.queryClusterNodes(ctx, client)
	currentTopology := &ClusterTopology{
		Nodes: map[string]*ClusterNode{},
	}
	if err == nil {
		fqdnMap := make(map[string]string)
		for _, fqdn := range podFQDNs {
			host := strings.Split(fqdn, ".")[0]
			fqdnMap[host] = fqdn
		}

		currentTopology, err = r.parseClusterNodes(output, fqdnMap)
		if err != nil {
			return fmt.Errorf("failed to parse cluster nodes: %w", err)
		}
	}

	return nil
}

	if r.needsBootstrap(currentTopology) {
		logger.Info("Cluster needs bootstrap")
		return r.bootstrapCluster(ctx, podFQDNs, valkeyCluster)
	}

	if r.needsScaleUp(currentTopology, desiredTopology) {
		logger.Info("Cluster needs scale up",
			"currentMasters", len(currentTopology.Masters),
			"desiredMasters", len(desiredTopology.Masters))
		return r.scaleUp(ctx, currentTopology, desiredTopology, podFQDNs)
	}

	if r.needsScaleDown(currentTopology, desiredTopology) {
		logger.Info("Cluster needs scale down",
			"currentMasters", len(currentTopology.Masters),
			"desiredMasters", len(desiredTopology.Masters))
		return r.scaleDown(ctx, currentTopology, desiredTopology, podFQDNs)
	}

	output, err := resp.ToString()
	if err != nil {
		return "", err
	}

	return output, nil
}

// converts the CLUSTER NODES string output of queryClusterNodes() into a ClusterTopology struct
//
// example clusterNodeOutput:
//
//	07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-5460
//	67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922
//	292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 10.1.0.4:6379@16379 master - 0 1538428697000 3 connected 10923-16383
//	e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 10.1.0.5:6379@16379 slave 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected
//	c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8 10.1.0.6:6379@16379 slave 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1538428698000 5 connected
//	a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 10.1.0.7:6379@16379 slave 292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 0 1538428698000 6 connected
func (r *ValkeyClusterReconciler) parseClusterNodes(clusterNodeOutput string, fqdnMap map[string]string) (*ClusterTopology, error) {
	topology := &ClusterTopology{
		Nodes: map[string]*ClusterNode{},
	}

	lines := slices.Collect(strings.SplitSeq(strings.TrimSpace(clusterNodeOutput), "\n"))

	clusterSlotRange := SlotRangeTracker{}
	for _, line := range lines {
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 8 {
			continue
		}

		clusterNode := &ClusterNode{
			ID:        fields[0],
			Connected: fields[7] == "connected",
		}

		hostPort := strings.Split(fields[1], "@")[0]
		parts := strings.Split(hostPort, ":")
		if len(parts) == 2 {
			host := parts[0]
			port, _ := strconv.Atoi(parts[1])

			clusterNode.Host = host
			clusterNode.Port = port
			clusterNode.FQDN = fqdnMap[host]
		}

		flags := slices.Collect(strings.SplitSeq(fields[2], ","))
		for _, flag := range flags {
			switch flag {
			case "master":
				clusterNode.Role = NodeRoleMaster
			case "slave", "replica":
				clusterNode.Role = NodeRoleSlave
				clusterNode.MasterID = fields[3]
			}
		}

		if clusterNode.Role == NodeRoleMaster {
			const slotRangeStartIndex = 8 // slots are always index 8 or higher
			for i := slotRangeStartIndex; i < len(fields); i++ {
				stringSlotRange := fields[i]
				if strings.HasPrefix(stringSlotRange, "[") && strings.HasSuffix(stringSlotRange, "]") {
					// importing/migrating a slot meaning that it is currently not part of the slot range
					continue
				}

				var slotRange SlotRange
				if strings.Contains(stringSlotRange, "-") { // range
					slots := strings.Split(stringSlotRange, "-")
					start, _ := strconv.Atoi(slots[0])
					end, _ := strconv.Atoi(slots[1])
					slotRange = SlotRange{Start: start, End: end}
				} else { // single slot
					slot, _ := strconv.Atoi(stringSlotRange)
					slotRange = SlotRange{Start: slot, End: slot}
				}
				clusterSlotRange.Add(slotRange)
				clusterNode.SlotRanges = append(clusterNode.SlotRanges, slotRange)
			}

			topology.Masters = append(topology.Masters, clusterNode)
		} else if clusterNode.Role == NodeRoleSlave {
			topology.Replicas = append(topology.Replicas, clusterNode)
		}

		topology.Nodes[clusterNode.ID] = clusterNode
	}

	return topology, nil
}

	}


	return topology, nil
}
