package valkey

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/valkey-io/valkey-go"
)

// https://valkey.io/commands/cluster-nodes/
type Flag string

const (
	Myself     Flag = "myself"
	Master     Flag = "master"
	Slave      Flag = "slave"
	Pfail      Flag = "fail?"
	Fail       Flag = "fail"
	Handshake  Flag = "handshake"
	NoAddr     Flag = "noaddr"
	NoFailover Flag = "nofailover"
	NoFlags    Flag = "noflags"
)

type LinkState string

const (
	Connected    LinkState = "connected"
	Disconnected LinkState = "disconnected"
)

type SlotRange struct {
	StartSlot uint16
	EndSlot   uint16
}

// going in
type ImportingSlot struct {
	Slot            uint16
	ImportingNodeID string
}

// going out
type MigratingSlot struct {
	Slot            uint16
	MigratingNodeID string
}

// <id> <ip:port@cport[,hostname]> <flags> <master> <ping-sent> <pong-recv> <config-epoch> <link-state> <slot> <slot> ... <slot>
type ClusterNode struct {
	ID        string
	IP        string // IPv4 or IPv6
	Port      uint16
	BusPort   uint16
	Hostname  string
	Flags     []Flag
	Master    string
	PingSent  time.Time
	PongRecv  time.Time
	ConfigEp  uint64
	LinkState LinkState
	Slots     []SlotRange
	Importing []ImportingSlot // coming in
	Migrating []MigratingSlot // going out
}

// Gets the statefulset index of the node
func (n ClusterNode) Index() int {
	if n.Hostname == "" {
		return -1
	}
	hostnameParts := strings.Split(n.Hostname, ".")
	statefulsetParts := strings.Split(hostnameParts[0], "-")
	index, err := strconv.Atoi(statefulsetParts[len(statefulsetParts)-1])
	if err != nil {
		return -1
	}
	return index
}

func ClusterNodes(client valkey.Client) ([]ClusterNode, error) {
	clusterNodes, err := GetClusterNodes(client)
	if err != nil {
		return nil, err
	}

	lines := slices.Collect(strings.SplitSeq(strings.TrimSpace(clusterNodes), "\n"))
	nodes := make([]ClusterNode, len(lines))
	for i, line := range lines {
		fields := strings.Fields(line)
		id, address, flagList, master, pingUnixTime, pongUnixTime, configEpoch, link := fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6], fields[7]
		ip, clientPort, busPort, hostname, err := addressParts(address)
		if err != nil {
			return nil, err
		}

		flags, err := flags(flagList)
		if err != nil {
			return nil, err
		}

		if master == "-" {
			master = ""
		}

		pingEpochNum, err := strconv.ParseInt(pingUnixTime, 10, 64)
		if err != nil {
			return nil, err
		}
		pingSent := time.Unix(pingEpochNum, 0)

		pongEpochNum, err := strconv.ParseInt(pongUnixTime, 10, 64)
		if err != nil {
			return nil, err
		}
		pongRecv := time.Unix(pongEpochNum, 0)

		configEp, err := strconv.ParseUint(configEpoch, 10, 64)
		if err != nil {
			return nil, err
		}

		linkState := LinkState(link)
		switch linkState {
		case Connected, Disconnected:
		default:
			return nil, fmt.Errorf("unknown link state: %s", link)
		}

		slotRanges, importingSlots, migratingSlots, err := parseSlots(fields[8:]...)
		if err != nil {
			return nil, err
		}

		nodes[i] = ClusterNode{
			ID:        id,
			IP:        ip,
			Port:      clientPort,
			BusPort:   busPort,
			Hostname:  hostname,
			Flags:     flags,
			Master:    master,
			PingSent:  pingSent,
			PongRecv:  pongRecv,
			ConfigEp:  configEp,
			LinkState: linkState,
			Slots:     slotRanges,
			Importing: importingSlots,
			Migrating: migratingSlots,
		}
	}

	return nodes, nil
}

// ip:port@cport[,hostname]
func addressParts(address string) (string, uint16, uint16, string, error) {
	lastColonIndex := strings.LastIndex(address, ":")
	if lastColonIndex == -1 {
		return "", 0, 0, "", fmt.Errorf("invalid parsing \":\" from address: %s", address)
	}

	ip := address[:lastColonIndex]
	remainingAddress := address[lastColonIndex+1:]
	commaIndex := strings.Index(remainingAddress, ",")
	var hostname = ""
	if commaIndex != -1 {
		hostname = remainingAddress[commaIndex+1:]
		remainingAddress = remainingAddress[:commaIndex]
	}
	ports := strings.Split(remainingAddress, "@")
	if len(ports) != 2 {
		return "", 0, 0, "", fmt.Errorf("client and bus ports should both be specified in address: %s", address)
	}
	clientPort, err := strconv.ParseUint(ports[0], 10, 16)
	if err != nil {
		return "", 0, 0, "", fmt.Errorf("client port should be a number: %s", ports[0])
	}
	busPort, err := strconv.ParseUint(ports[1], 10, 16)
	if err != nil {
		return "", 0, 0, "", fmt.Errorf("bus port should be a number: %s", ports[1])
	}

	return ip, uint16(clientPort), uint16(busPort), hostname, nil
}

func flags(flags string) ([]Flag, error) {
	var flagList []Flag
	for flag := range strings.SplitSeq(flags, ",") {
		switch Flag(flag) {
		case Myself, Master, Slave, Pfail, Fail, Handshake, NoAddr, NoFailover, NoFlags:
			flagList = append(flagList, Flag(flag))
		default:
			return nil, fmt.Errorf("unknown flag: %s", flag)
		}
	}
	return flagList, nil
}

func parseSlots(slots ...string) ([]SlotRange, []ImportingSlot, []MigratingSlot, error) {
	var slotRanges []SlotRange
	var importingSlots []ImportingSlot
	var migratingSlots []MigratingSlot
	for _, slot := range slots {
		if slot[0] == '[' && slot[len(slot)-1] == ']' {
			parts := strings.Split(slot[1:len(slot)-1], "-")
			if len(parts) != 3 {
				return nil, nil, nil, fmt.Errorf("invalid slot range: %s", slot)
			}

			slot, err := strconv.ParseUint(parts[0], 10, 16)
			if err != nil {
				return nil, nil, nil, fmt.Errorf("invalid slot range: %d", slot)
			}
			switch parts[1] {
			case "<":
				importingSlots = append(importingSlots, ImportingSlot{
					Slot:            uint16(slot),
					ImportingNodeID: parts[2],
				})
			case ">":
				migratingSlots = append(migratingSlots, MigratingSlot{
					Slot:            uint16(slot),
					MigratingNodeID: parts[2],
				})
			default:
				return nil, nil, nil, fmt.Errorf("invalid slot range: %d", slot)
			}
			continue
		}

		if strings.Contains(slot, "-") {
			slotParts := strings.Split(slot, "-")
			if len(slotParts) != 2 {
				return nil, nil, nil, fmt.Errorf("invalid slot range: %s", slot)
			}

			startSlot, err := strconv.ParseUint(slotParts[0], 10, 16)
			if err != nil {
				return nil, nil, nil, fmt.Errorf("invalid slot range: %s", slot)
			}
			endSlot, err := strconv.ParseUint(slotParts[1], 10, 16)
			if err != nil {
				return nil, nil, nil, fmt.Errorf("invalid slot range: %s", slot)
			}

			slotRanges = append(slotRanges, SlotRange{
				StartSlot: uint16(startSlot),
				EndSlot:   uint16(endSlot),
			})
			continue
		}

		slot, err := strconv.ParseUint(slot, 10, 16)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("invalid slot range: %d", slot)
		}
		slotRanges = append(slotRanges, SlotRange{
			StartSlot: uint16(slot),
			EndSlot:   uint16(slot),
		})
	}

	return slotRanges, importingSlots, migratingSlots, nil
}

func Replicate(replicaSingleClient valkey.Client, masterID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	cmd := replicaSingleClient.B().ClusterReplicate().NodeId(masterID).Build()
	if err := replicaSingleClient.Do(ctx, cmd).Error(); err != nil {
		return err
	}

	return nil
}
