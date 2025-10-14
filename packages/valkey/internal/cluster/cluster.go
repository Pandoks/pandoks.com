package cluster

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
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

// Host is the FQDN of the headless service of the node for the stateful set pod
// Example:
//
//	<statefulset-name>-<index>.<headless-service-name>.<namespace>.svc.cluster.local
//	valkey-0.valkey-headless-example.default.svc.cluster.local
type Address struct {
	Host string
	Port int64
}

func (a *Address) String() string {
	return fmt.Sprintf("%s:%d", a.Host, a.Port)
}

// statefulset index
func (a *Address) Index() (int, error) {
	statefulSetname := strings.Split(a.Host, ".")
	parts := strings.Split(statefulSetname[0], "-")
	if len(parts) == 0 {
		return -1, fmt.Errorf("failed to parse stateful set name: %s", a.Host)
	}
	index, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		return -1, fmt.Errorf("failed to parse stateful set index: %s", a.Host)
	}
	return index, nil
}

type ClusterNode struct {
	ID         string
	Address    Address
	Role       NodeRole         // master | slave (we do not use inclusive language here)
	MasterID   string           // nil for masters, otherwise the ID of the master
	SlotRanges []slot.SlotRange // [start, end] both inclusive, nil if slave node
	Connected  bool
}

type ClusterTopology struct {
	Nodes    map[string]*ClusterNode // nodeID -> node
	Masters  []*ClusterNode          // sorted by statefulset index (corresponds to node index for slots)
	Replicas []*ClusterNode          // sorted by statefulset index too. the starting index is the max index of masters + 1
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
			Address:    Address{Host: masterId, Port: ValkeyClientPort},
			Role:       NodeRoleMaster,
			SlotRanges: []slot.SlotRange{desiredSlotRanges[i]},
			Connected:  true,
		}
		topology.Masters = append(topology.Masters, masterNode)
		topology.Nodes[masterNode.ID] = masterNode

		for j := range valkeyCluster.Spec.ReplicasPerMaster {
			slaveId := fmt.Sprintf("replica-%d-%d", i, j)
			slaveNode := &ClusterNode{
				ID:        slaveId,
				Address:   Address{Host: slaveId, Port: ValkeyClientPort},
				Role:      NodeRoleSlave,
				MasterID:  masterId,
				Connected: true,
			}
			topology.Replicas = append(topology.Replicas, slaveNode)
			topology.Nodes[slaveNode.ID] = slaveNode
		}
	}

	return topology
}

func (t *ClusterTopology) Addresses() []Address {
	addresses := make([]Address, 0, len(t.Nodes))
	for _, node := range t.Nodes {
		addresses = append(addresses, node.Address)
	}
	return addresses
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
