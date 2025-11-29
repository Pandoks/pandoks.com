package valkey

import (
	"fmt"
	"sort"

	"github.com/valkey-io/valkey-go"
)

type masterNode struct {
	Node     ClusterNode
	SlaveIds []string
}

type Shard struct {
	Index    int
	MasterId string
}

type Topology struct {
	Masters       map[string]masterNode
	Slaves        map[string]ClusterNode
	OrderedNodes  []ClusterNode
	OrderedShards []Shard
}

func ClusterTopology(nodes []ClusterNode) (Topology, error) {
	masters := make(map[string]masterNode)
	slaves := make(map[string]ClusterNode)
	orderedNodes := make([]ClusterNode, len(nodes))

	for i, node := range nodes {
		orderedNodes[i] = node
		if node.Master == "" {
			masters[node.ID] = masterNode{Node: node, SlaveIds: []string{}}
		}
	}
	for _, node := range nodes {
		if node.Master != "" {
			slaves[node.ID] = node
			master, exists := masters[node.Master]
			if !exists {
				return Topology{}, fmt.Errorf("master %s not found", node.Master)
			}
			master.SlaveIds = append(master.SlaveIds, node.ID)
			masters[node.Master] = master
		}
	}

	orderedShards := make([]Shard, 0, len(masters))
	for _, master := range masters {
		lowestIndex := master.Node.Index()
		for _, slave := range master.SlaveIds {
			slaveNode := slaves[slave]
			lowestIndex = min(lowestIndex, slaveNode.Index())
		}
		orderedShards = append(orderedShards, Shard{
			Index:    lowestIndex,
			MasterId: master.Node.ID,
		})
	}

	sort.Slice(orderedNodes, func(i, j int) bool {
		return orderedNodes[i].Index() < orderedNodes[j].Index()
	})

	sort.Slice(orderedShards, func(i, j int) bool {
		return orderedShards[i].Index < orderedShards[j].Index
	})

	return Topology{
		Masters:       masters,
		Slaves:        slaves,
		OrderedNodes:  orderedNodes,
		OrderedShards: orderedShards,
	}, nil
}

func (t Topology) IsHealthy() (bool, error) {
	nodeIndex := 0
	for _, node := range t.OrderedNodes {
		for _, flag := range node.Flags {
			switch flag {
			case Fail, Pfail, Handshake, NoAddr:
				return false, fmt.Errorf("node %s is in %s state", node.ID, flag)
			default:
				continue
			}
		}
		if node.LinkState == Disconnected {
			return false, fmt.Errorf("node %s is disconnected", node.ID)
		}

		index := node.Index()
		if index != nodeIndex {
			return false, fmt.Errorf("missing node index. expected %d", index)
		}
		nodeIndex += 1
	}

	var replicasPerMaster = -1
	for _, masterNode := range t.Masters {
		if replicasPerMaster == -1 {
			replicasPerMaster = len(masterNode.SlaveIds)
			continue
		}

		if len(masterNode.SlaveIds) != replicasPerMaster {
			return false, fmt.Errorf("master %s has %d replicas, expected %d", masterNode.Node.Hostname, len(masterNode.SlaveIds), replicasPerMaster)
		}
	}

	if len(t.OrderedShards) != len(t.Masters) {
		return false, fmt.Errorf("expected %d shards, got %d. there should be one shard per master", len(t.Masters), len(t.OrderedShards))
	}

	return true, nil
}

func GetClusterTopology(client valkey.Client) (Topology, error) {
	nodes, err := ClusterNodes(client)
	if err != nil {
		return Topology{}, err
	}
	return ClusterTopology(nodes)
}

func (t Topology) Print() {
	fmt.Println("Cluster Topology:")
	fmt.Println("  Masters:")
	for _, master := range t.Masters {
		fmt.Printf("    %s\n", master.Node.Hostname)
	}
	fmt.Println("  Slaves:")
	for _, slave := range t.Slaves {
		fmt.Printf("    %s\n", slave.Hostname)
	}
	fmt.Println("  Ordered Nodes:")
	for _, node := range t.OrderedNodes {
		fmt.Printf("    %s\n", node.Hostname)
	}
	fmt.Println("  Ordered Shards:")
	shardList := ""
	for _, shard := range t.OrderedShards {
		shardList += fmt.Sprintf("[%d] ", shard.Index)
	}
	fmt.Printf("    %s\n", shardList)
}
