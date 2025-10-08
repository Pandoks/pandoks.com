package cluster

import (
	"fmt"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/slot"
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

func (t *ClusterTopology) FQDNs() []string {
	fqdns := make([]string, 0, len(t.Nodes))
	for _, node := range t.Nodes {
		fqdns = append(fqdns, node.FQDN)
	}
	return fqdns
}
