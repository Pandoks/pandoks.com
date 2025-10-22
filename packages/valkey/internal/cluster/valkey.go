package cluster

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"valkey/operator/internal/slot"

	"github.com/valkey-io/valkey-go"
)

const (
	ValkeyClientPort = 6379
	ValkeyGossipPort = 16379 // same thing as bus port
)

// NOTE: need to manually close the client view valkey.Client.Close()
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
// example output:
//
//	07c37dfeb235213a872192d05877c5d02d9a7e1f ipv4:6379@16379,hostname master - 0 1538428698000 1 connected 0-5460
//	67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 ipv4:6379@16379,hostname master - 0 1538428699000 2 connected 5461-10922
//	292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f ipv4:6379@16379,hostname master - 0 1538428697000 3 connected 10923-16383
//	e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca ipv4:6379@16379,hostname slave 07c37dfeb235213a872192d05877c5d02d9a7e1f (master id) 0 1538428699000 4 connected
//	c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8 ipv4:6379@16379,hostname slave 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1538428698000 5 connected
//	a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 ipv4:6379@16379,hostname slave 292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 0 1538428698000 6 connected
func QueryClusterNodes(ctx context.Context, client valkey.Client) (string, error) {
	resp := client.Do(ctx, client.B().ClusterNodes().Build())
	if resp.Error() != nil {
		return "", resp.Error()
	}

	output, err := resp.ToString()
	if err != nil {
		return "", err
	}

	cleansedOutput := strings.TrimPrefix(output, "txt:")
	return cleansedOutput, nil
}

func ParseClusterTopology(clusterNodeOutput, headlessService, namespace string) (*ClusterTopology, error) {
	topology := &ClusterTopology{
		Nodes:      map[string]*ClusterNode{},
		Masters:    []*ClusterNode{},
		Replicas:   []*ClusterNode{},
		Migrations: map[MigrationRoute]*slot.SlotRangeTracker{},
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

		connectionInfo := fields[1]
		if strings.Contains(connectionInfo, "@") && strings.Contains(connectionInfo, ",") {
			connectionInfoParts := strings.Split(connectionInfo, ",")
			ipv4AddressParts := strings.Split(strings.Split(connectionInfoParts[0], "@")[0], ":")
			clientPort, _ := strconv.ParseInt(ipv4AddressParts[1], 10, 64)
			hostname := connectionInfoParts[1]
			address := Address{Host: hostname, Port: clientPort}
			clusterNode.Address = address
			clusterNodeIndex, err := address.Index()
			if err != nil {
				return nil, fmt.Errorf("failed to parse cluster node %s: %w", clusterNode.ID, err)
			}
			clusterNode.Index = clusterNodeIndex
		} else {
			return nil, fmt.Errorf("failed to parse cluster node %s: invalid connection info %s", clusterNode.ID, connectionInfo)
		}
type fieldLine struct {
	ID         string
	Hostname   string
	ClientPort int
	BusPort    int
	Ipv4       string
	Role       NodeRole
	MasterID   string
	Connected  bool
	Slots      *slot.SlotRangeTracker
	Imports    map[string]*slot.SlotRangeTracker // source ID -> slot ranges
	Exports    map[string]*slot.SlotRangeTracker // destination ID -> slot ranges
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
func getFieldsFromLine(line string) (fieldLine, error) {
	if line == "" {
		return fieldLine{}, fmt.Errorf("empty line")
	}

	fields := fieldLine{
		Slots: &slot.SlotRangeTracker{},
	}
	lineFields := strings.Fields(line)
	if len(lineFields) < 8 {
		return fieldLine{}, fmt.Errorf("invalid line with less than 8 fields: %s", line)
	}
	fields.ID = lineFields[0]
	fields.Connected = lineFields[7] == "connected"

	connectionInfo := lineFields[1]
	if strings.Contains(connectionInfo, "@") && strings.Contains(connectionInfo, ",") {
		ipv4ClientBusHostname := strings.Split(connectionInfo, ",")
		ipv4ClientBus, hostname := strings.Split(ipv4ClientBusHostname[0], "@"), ipv4ClientBusHostname[1]
		ipv4Client, busPort := strings.Split(ipv4ClientBus[0], ":"), ipv4ClientBus[1]
		ipv4, clientPort := ipv4Client[0], ipv4Client[1]
		fields.Hostname = hostname
		fields.ClientPort, _ = strconv.Atoi(clientPort)
		fields.BusPort, _ = strconv.Atoi(busPort)
		fields.Ipv4 = ipv4
	} else {
		return fields, fmt.Errorf("failed to parse cluster node %s: invalid connection info %s", fields.ID, connectionInfo)
	}

	flags := slices.Collect(strings.SplitSeq(lineFields[2], "2"))
	for _, flag := range flags {
		switch flag {
		case "master", "primary":
			fields.Role = NodeRoleMaster
		case "slave", "replica":
			fields.Role = NodeRoleSlave
			fields.MasterID = lineFields[3]
		}
	}

	if fields.Role == NodeRoleMaster {
		const slotRangeStartIndex = 8
		for i := slotRangeStartIndex; i < len(lineFields); i++ {
			stringSlotRange := lineFields[i]
			if strings.HasPrefix(stringSlotRange, "[") && strings.HasSuffix(stringSlotRange, "]") {
				migrationStrings := strings.Split(stringSlotRange[1:len(stringSlotRange)-1], "-")
				slotNumber, importOrExport, masterId := migrationStrings[0], migrationStrings[1], migrationStrings[2]
				switch importOrExport {
				case "<":
					if fields.Imports[masterId] == nil {
						fields.Imports[masterId] = &slot.SlotRangeTracker{}
					}
					slotInt, err := strconv.Atoi(slotNumber)
					if err != nil {
						continue
					}
					fields.Imports[masterId].Add(slot.SlotRange{Start: slotInt, End: slotInt})
				case ">":
					if fields.Exports[masterId] == nil {
						fields.Exports[masterId] = &slot.SlotRangeTracker{}
					}
					slotInt, err := strconv.Atoi(slotNumber)
					if err != nil {
						continue
					}
					fields.Exports[masterId].Add(slot.SlotRange{Start: slotInt, End: slotInt})
				}

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

			fields.Slots.Add(slotRange)
		}
	}

	return fields, nil
}

func GetTopology(ctx context.Context, client valkey.Client, headlessService, namespace string) (*ClusterTopology, error) {
	clusterNodeOutput, err := QueryClusterNodes(ctx, client)
	if err != nil {
		return nil, fmt.Errorf("failed to query cluster nodes: %w", err)
	}
	topology, err := ParseClusterTopology(clusterNodeOutput, headlessService, namespace)
	if err != nil {
		return nil, fmt.Errorf("failed to parse cluster nodes: %w", err)
	}
	return topology, nil
}
