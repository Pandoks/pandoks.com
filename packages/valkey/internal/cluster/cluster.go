package cluster

import (
	"fmt"
	"reflect"
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
	Role       NodeRole         // master | slave (we do not use inclusive language here)
	MasterID   string           // nil for masters, otherwise the ID of the master
	SlotRanges []slot.SlotRange // [start, end] both inclusive, nil if slave node
	Connected  bool
}

type ClusterTopology struct {
	Nodes    map[string]*ClusterNode // nodeID -> node
	Masters  []*ClusterNode          // sorted by statefulset index (corresponds to node index for slots)
	Replicas []*ClusterNode          // not sorted
}

// desiredTopology calculates the desired cluster topology based on the spec. Note that the ids are not supposed to match
// the actual cluster state because it doesn't have access to the actual cluster. The master ids are named 'master-i' and
// the replica ids are named 'replica-i-j' where i is the master index and j is the replica index.
func DesiredTopology(valkeyCluster *valkeyv1.ValkeyCluster) *ClusterTopology {
	topology := &ClusterTopology{
		Nodes: map[string]*ClusterNode{},
	}

	numMasters := valkeyCluster.Spec.Masters
	desiredSlotRanges := slot.DesiredSlotRangesFromMasterCount(numMasters)

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

func (t *ClusterTopology) SlotRangeTracker() (slot.SlotRangeTracker, error) {
	slotRangeTracker := slot.SlotRangeTracker{}
	for _, node := range t.Masters {
		if err := slotRangeTracker.Add(node.SlotRanges...); err != nil {
			return slot.SlotRangeTracker{}, err
		}
	}

	return slotRangeTracker, nil
}

// WARNING: this does not look at the IDs, FQDNs, and host/port of the nodes, it only looks at the topology shape
func IsSameTopologyShape(topologyA, topologyB *ClusterTopology) bool {
	if len(topologyA.Masters) != len(topologyB.Masters) || len(topologyA.Replicas) != len(topologyB.Replicas) {
		return false
	}

	hashSlotRanges := func(slotRanges []slot.SlotRange) string {
		var hash string
		for _, slotRange := range slotRanges {
			hash += fmt.Sprintf("%d-%d", slotRange.Start, slotRange.End)
		}
		return hash
	}

	slotRangesReplicaCountA := map[string]int{}
	slotRangesReplicaCountB := map[string]int{}
	for i := range topologyA.Replicas {
		// NOTE: you can't compare the nodes here becuase they are not guaranteed to be in the same order
		replicaA := topologyA.Replicas[i]
		replicaB := topologyB.Replicas[i]

		masterNodeA := topologyA.Nodes[replicaA.MasterID]
		masterNodeB := topologyB.Nodes[replicaB.MasterID]

		slotRangeHashA := hashSlotRanges(masterNodeA.SlotRanges)
		slotRangeHashB := hashSlotRanges(masterNodeB.SlotRanges)

		slotRangesReplicaCountA[slotRangeHashA]++
		slotRangesReplicaCountB[slotRangeHashB]++
	}

	return reflect.DeepEqual(slotRangesReplicaCountA, slotRangesReplicaCountB)
}
