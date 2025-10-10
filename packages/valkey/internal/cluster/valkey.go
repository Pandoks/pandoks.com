package cluster

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"valkey/operator/internal/slot"

	"github.com/valkey-io/valkey-go"
)

const (
	ValkeyClientPort = 6379
	ValkeyGossipPort = 16379
)

func ConnectToValkeyNode(ctx context.Context, address string) (valkey.Client, error) {
	client, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{address}})
	if err != nil {
		return nil, fmt.Errorf("failed to create client for %s: %w", address, err)
	}

	if err := client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
		client.Close()
		return nil, fmt.Errorf("failed to ping client for %s: %w", address, err)
	}

	return client, nil
}

// returns the string output of the CLUSTER NODES command
//
// example output (fqdn in this case because we're in cluster but sometimes it'll be ipv4/6):
//
//	07c37dfeb235213a872192d05877c5d02d9a7e1f fqdn:6379@16379 master - 0 1538428698000 1 connected 0-5460
//	67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 fqdn:6379@16379 master - 0 1538428699000 2 connected 5461-10922
//	292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f fqdn:6379@16379 master - 0 1538428697000 3 connected 10923-16383
//	e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca fqdn:6379@16379 slave 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected
//	c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8 fqdn:6379@16379 slave 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1538428698000 5 connected
//	a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 fqdn:6379@16379 slave 292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 0 1538428698000 6 connected
func QueryClusterNodes(ctx context.Context, client valkey.Client) (string, error) {
	resp := client.Do(ctx, client.B().ClusterNodes().Build())
	if resp.Error() != nil {
		return "", resp.Error()
	}

	output, err := resp.ToString()
	if err != nil {
		return "", err
	}

	return output, nil
}

func ParseClusterTopology(clusterNodeOutput string) (*ClusterTopology, error) {
	topology := &ClusterTopology{
		Nodes: map[string]*ClusterNode{},
	}

	lines := slices.Collect(strings.SplitSeq(strings.TrimSpace(clusterNodeOutput), "\n"))

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
			port, err := strconv.Atoi(parts[1])
			if err != nil {
				continue
			}

			clusterNode.Host = host
			clusterNode.Port = port
			clusterNode.FQDN = hostPort
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
			const slotRangeStartIndex = 8
			for i := slotRangeStartIndex; i < len(fields); i++ {
				stringSlotRange := fields[i]
				if strings.HasPrefix(stringSlotRange, "[") && strings.HasSuffix(stringSlotRange, "]") {
					continue
				}

				var slotRange slot.SlotRange
				if strings.Contains(stringSlotRange, "-") {
					slots := strings.Split(stringSlotRange, "-")
					if len(slots) != 2 {
						continue
					}
					start, err := strconv.Atoi(slots[0])
					if err != nil {
						continue
					}
					end, err := strconv.Atoi(slots[1])
					if err != nil {
						continue
					}
					if start < 0 || end >= slot.TotalSlots || start > end {
						continue
					}
					slotRange = slot.SlotRange{Start: start, End: end}
				} else {
					slotNumber, err := strconv.Atoi(stringSlotRange)
					if err != nil {
						continue
					}
					if slotNumber < 0 || slotNumber >= slot.TotalSlots {
						continue
					}
					slotRange = slot.SlotRange{Start: slotNumber, End: slotNumber}
				}
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
