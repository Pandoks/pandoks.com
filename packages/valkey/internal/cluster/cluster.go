package cluster

import (
	"fmt"
	"sort"
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

type ClusterNodeMap map[string]*ClusterNode

func (m ClusterNodeMap) Array() []*ClusterNode {
	nodes := make([]*ClusterNode, 0, len(m))
	for _, node := range m {
		nodes = append(nodes, node)
	}
	sort.Slice(nodes, func(i, j int) bool {
		iIndex, _ := nodes[i].Address.Index()
		jIndex, _ := nodes[j].Address.Index()
		return iIndex < jIndex
	})
	return nodes
}

type ClusterNode struct {
	ID         string
	Address    Address
	Role       NodeRole         // master | slave (we do not use inclusive language here)
	MasterID   string           // "" for masters, otherwise the ID of the master
	SlotRanges []slot.SlotRange // [start, end] both inclusive, nil if slave node
	Connected  bool
}

type ClusterTopology struct {
	Nodes      ClusterNodeMap                            // nodeID -> node
	Masters    []*ClusterNode                            // sorted by statefulset index (corresponds to node index for slots)
	Replicas   []*ClusterNode                            // sorted by statefulset index too. the starting index is the max index of masters + 1
	Migrations map[MigrationRoute]*slot.SlotRangeTracker // {source index, destination index} -> slot ranges NOTE: migrations are always from master to master so the index is the index for Masters
}

// desiredTopology calculates the desired cluster topology based on the spec. Note that the ids are not supposed to match
// the actual cluster state because it doesn't have access to the actual cluster. The master ids are named 'master-i' and
// the replica ids are named 'replica-i-j-k' where i is the master index, j is the replica index for that master, and k is the statefulset index
func DesiredTopology(valkeyCluster *valkeyv1.ValkeyCluster) *ClusterTopology {
	topology := &ClusterTopology{
		Nodes:      map[string]*ClusterNode{},
		Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
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
			statefulsetIndex := numMasters + (i * valkeyCluster.Spec.ReplicasPerMaster) + j
			slaveId := fmt.Sprintf("replica-%d-%d-%d", i, j, statefulsetIndex)
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

func IsSameTopologyShape(topologyA, topologyB *ClusterTopology) bool {
	if len(topologyA.Masters) != len(topologyB.Masters) ||
		len(topologyA.Replicas) != len(topologyB.Replicas) ||
		len(topologyA.Migrations) != len(topologyB.Migrations) {
		return false
	}

	mastersLength := len(topologyA.Masters)
	replicaLength := len(topologyA.Replicas)

	for i := range mastersLength {
		masterA := topologyA.Masters[i]
		masterB := topologyB.Masters[i]
		if match, _ := matchNodes(masterA, masterB, topologyA.Nodes, topologyB.Nodes); !match {
			return false
		}
	}

	for i := range replicaLength {
		replicaA := topologyA.Replicas[i]
		replicaB := topologyB.Replicas[i]
		if match, _ := matchNodes(replicaA, replicaB, topologyA.Nodes, topologyB.Nodes); !match {
			return false
		}
	}

	for route, migrationA := range topologyA.Migrations {
		migrationB, exists := topologyB.Migrations[route]
		if !exists {
			return false
		}
		slotRangesA, slotRangesB := migrationA.SlotRanges(), migrationB.SlotRanges()
		if len(slotRangesA) != len(slotRangesB) {
			return false
		}
		for i := range len(slotRangesA) {
			slotRangeA := slotRangesA[i]
			slotRangeB := slotRangesB[i]
			if slotRangeA.Start != slotRangeB.Start || slotRangeA.End != slotRangeB.End {
				return false
			}
		}
	}

	return true
}

func matchNodes(nodeA, nodeB *ClusterNode, clusterNodeMapA, clusterNodeMapB ClusterNodeMap) (bool, error) {
	nodeAIndex, err := nodeA.Address.Index()
	if err != nil {
		return false, err
	}
	nodeBIndex, err := nodeB.Address.Index()
	if err != nil {
		return false, err
	}
	if nodeAIndex != nodeBIndex || nodeA.Role != nodeB.Role {
		return false, nil
	}

	if nodeA.Role == NodeRoleSlave {
		masterNodeA := clusterNodeMapA[nodeA.MasterID]
		masterNodeB := clusterNodeMapB[nodeB.MasterID]
		masterNodeAIndex, err := masterNodeA.Address.Index()
		if err != nil {
			return false, err
		}
		masterNodeBIndex, err := masterNodeB.Address.Index()
		if err != nil {
			return false, err
		}
		if masterNodeAIndex != masterNodeBIndex {
			return false, nil
		}
	}

	if len(nodeA.SlotRanges) != len(nodeB.SlotRanges) {
		return false, nil
	}
	for i := range len(nodeA.SlotRanges) {
		nodeASlotRange := nodeA.SlotRanges[i]
		nodeBSlotRange := nodeB.SlotRanges[i]
		if nodeASlotRange.Start != nodeBSlotRange.Start || nodeASlotRange.End != nodeBSlotRange.End {
			return false, nil
		}
	}
	return true, nil
}
