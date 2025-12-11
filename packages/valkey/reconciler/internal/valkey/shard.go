package valkey

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/valkey-io/valkey-go"
)

type PromoteOriginalShardLeaderOptions struct {
	ClusterClient valkey.Client
	Shard         Shard
	Topology      Topology
}

// hostnames do not include port
func PromoteOriginalShardLeader(ctx context.Context, options PromoteOriginalShardLeaderOptions) (newMasterHostname, newSlaveHostname string, err error) {
	topology := options.Topology
	masterNode, exists := topology.Masters[options.Shard.MasterId]
	if !exists {
		return "", "", fmt.Errorf("master %s not found in topology", options.Shard.MasterId)
	}

	lowestIndexPodNode := masterNode.Node
	for _, slaveId := range masterNode.SlaveIds {
		slaveNode, exists := topology.Slaves[slaveId]
		if !exists {
			return "", "", fmt.Errorf("slave %s not found in topology", slaveId)
		}

		if slaveNode.Index() < lowestIndexPodNode.Index() {
			lowestIndexPodNode = slaveNode
		}
	}

	if lowestIndexPodNode.ID == masterNode.Node.ID { // already the original leader
		return masterNode.Node.Hostname, "", nil
	}

	// to be promoted to master
	replicaClient, exists := options.ClusterClient.Nodes()[fmt.Sprintf("%s:%d", lowestIndexPodNode.Hostname, lowestIndexPodNode.Port)]
	if !exists {
		return "", "", fmt.Errorf("replica client for %s not found", lowestIndexPodNode.Hostname)
	}
	failoverCmd := replicaClient.B().ClusterFailover().Build()
	if err := replicaClient.Do(ctx, failoverCmd).Error(); err != nil {
		return "", "", err
	}

	// to be demoted to slave
	masterClient, exists := options.ClusterClient.Nodes()[fmt.Sprintf("%s:%d", masterNode.Node.Hostname, masterNode.Node.Port)]
	if !exists {
		return "", "", fmt.Errorf("master client for %s not found", masterNode.Node.Hostname)
	}

	for {
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()
		default:
		}

		const section = "replication"
		replicaInfoCmd := replicaClient.B().Info().Section(section).Build()
		masterInfoCmd := masterClient.B().Info().Section(section).Build()

		replicaInfo, err := replicaClient.Do(ctx, replicaInfoCmd).ToString()
		if err != nil || !strings.Contains(replicaInfo, "role:master") {
			select {
			case <-ctx.Done():
				return "", "", ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}

		masterInfo, err := masterClient.Do(ctx, masterInfoCmd).ToString()
		if err != nil ||
			!strings.Contains(masterInfo, "role:slave") ||
			!strings.Contains(masterInfo, fmt.Sprintf("master_host:%s", lowestIndexPodNode.Hostname)) {
			select {
			case <-ctx.Done():
				return "", "", ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}

		break
	}

	return lowestIndexPodNode.Hostname, masterNode.Node.Hostname, nil
}
