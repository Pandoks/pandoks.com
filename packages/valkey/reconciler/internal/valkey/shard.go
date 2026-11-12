package valkey

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/valkey-io/valkey-go"
)

type PromoteOriginalShardLeaderOptions struct {
	AdminPassword string
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

	// NOTE: dialed directly; the cluster client's Nodes() leaves out a resyncing (loading) node
	newNodeClient := func(node ClusterNode) (*ValkeyClient, error) {
		return NewClient(valkey.ClientOption{
			InitAddress:       []string{fmt.Sprintf("%s:%d", node.Hostname, node.Port)},
			Username:          AdminUser,
			Password:          options.AdminPassword,
			ForceSingleClient: true,
		})
	}

	// to be promoted to master
	replicaClient, err := newNodeClient(lowestIndexPodNode)
	if err != nil {
		return "", "", err
	}
	defer replicaClient.Close()
	// NOTE: a manual failover fails while the replica still resyncs, e.g. right after its pod restarted
	if err := WaitForReplicaSynced(ctx, replicaClient); err != nil {
		return "", "", err
	}

	failoverCmd := replicaClient.B().ClusterFailover().Build()
	if err := replicaClient.Do(ctx, failoverCmd).Error(); err != nil {
		return "", "", err
	}

	// to be demoted to slave
	masterClient, err := newNodeClient(masterNode.Node)
	if err != nil {
		return "", "", err
	}
	defer masterClient.Close()

	for {
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()
		default:
		}

		const section = "replication"
		replicaInfoCmd := replicaClient.B().Info().Section(section).Build()

		replicaInfo, err := replicaClient.Do(ctx, replicaInfoCmd).ToString()
		if err != nil || !strings.Contains(replicaInfo, "role:master") {
			select {
			case <-ctx.Done():
				return "", "", ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}

		// NOTE: match by node id, since master_host is an IP and the topology's IPs go stale when pods restart
		masterNodes, err := ClusterNodes(masterClient)
		myselfIndex := slices.IndexFunc(masterNodes, func(node ClusterNode) bool { return slices.Contains(node.Flags, Myself) })
		if err != nil || myselfIndex == -1 || !slices.Contains(masterNodes[myselfIndex].Flags, Slave) || masterNodes[myselfIndex].Master != lowestIndexPodNode.ID {
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
