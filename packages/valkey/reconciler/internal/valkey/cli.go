package valkey

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"valkey/reconciler/internal/utils"

	valkeygo "github.com/valkey-io/valkey-go"
)

func doesCommandExist(cmd string) bool {
	_, err := exec.LookPath(cmd)
	if err != nil {
		return false
	}
	return true
}

type Auth struct {
	Username string
	Password string
}

type Connection struct {
	Hostname string
	Port     uint16
}

type CliBaseOptions struct {
	Auth
	Connection
}

func (o CliBaseOptions) ValidateConnection() error {
	if o.Hostname == "" {
		return fmt.Errorf("hostname is required")
	}
	if o.Port == 0 {
		return fmt.Errorf("port is required")
	}
	return nil
}

func (o CliBaseOptions) ValidateAuth() error {
	if o.Username != "" && o.Password == "" {
		return fmt.Errorf("password is required when username is set")
	}
	return nil
}

func (o CliBaseOptions) Address() string {
	return fmt.Sprintf("%s:%d", o.Hostname, o.Port)
}

type RebalanceOptions struct {
	CliBaseOptions

	// Rebalance behavior
	Threshold       *float64           // Percent deviation from ideal number of slots; default: 2.0% WARNING: never use 0 or else it will skip the rebalance
	UseEmptyMasters bool               // Allow empty masters to take on slots; default: false
	Weights         map[string]float64 // nodeID -> weight; Ratio of slots to assign to each node (0 drains all slots from master); default 1 per node

	// Execution behavior
	TimeoutMS *int // default 60000 (1 minute)
	Pipeline  *int // Keys per MIGRATE call; default 10
	Replace   bool // Overwrite keys on collision; default false
}

func Rebalance(options RebalanceOptions) error {
	if !doesCommandExist("valkey-cli") {
		return fmt.Errorf("valkey-cli is not installed")
	}
	if err := options.ValidateConnection(); err != nil {
		return err
	}
	if err := options.ValidateAuth(); err != nil {
		return err
	}

	args := []string{"--cluster", "rebalance", options.Address(), "--cluster-yes"}

	if options.Username != "" {
		args = append(args, "--user", options.Username)
	}

	if options.Threshold != nil {
		if *options.Threshold < 0 {
			return fmt.Errorf("threshold must be >= 0")
		}
		args = append(args, "--cluster-threshold", strconv.FormatFloat(*options.Threshold, 'f', -1, 64))
	}
	if options.UseEmptyMasters {
		args = append(args, "--cluster-use-empty-masters")
	}
	if len(options.Weights) > 0 {
		weights := make([]string, len(options.Weights))
		i := 0
		for nodeID, weight := range options.Weights {
			weights[i] = fmt.Sprintf("%s=%s", nodeID, strconv.FormatFloat(weight, 'f', -1, 64))
			i++
		}
		args = append(args, "--cluster-weight")
		args = append(args, weights...)
	}

	if options.TimeoutMS != nil {
		if *options.TimeoutMS <= 0 {
			return fmt.Errorf("timeout must be > 0")
		}
		args = append(args, "--cluster-timeout", strconv.Itoa(*options.TimeoutMS))
	}
	if options.Pipeline != nil {
		if *options.Pipeline <= 0 {
			return fmt.Errorf("pipeline must be > 0")
		}
		args = append(args, "--cluster-pipeline", strconv.Itoa(*options.Pipeline))
	}
	if options.Replace {
		args = append(args, "--cluster-replace")
	}

	fmt.Printf("Command: valkey-cli %s\n", strings.Join(args, " "))
	if options.Password != "" {
		args = append(args, "-a", options.Password)
	}

	cmd := exec.Command("valkey-cli", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// NOTE: doesn't support replicas because there is a race condition in the cli
type AddNodeOptions struct {
	CliBaseOptions

	NewHostname string
	NewPort     uint16
}

func AddNode(options AddNodeOptions) error {
	if !doesCommandExist("valkey-cli") {
		return fmt.Errorf("valkey-cli is not installed")
	}
	if err := options.ValidateConnection(); err != nil {
		return err
	}
	if err := options.ValidateAuth(); err != nil {
		return err
	}
	if options.NewHostname == "" {
		return fmt.Errorf("hostname is required")
	}
	if options.NewPort == 0 {
		return fmt.Errorf("port is required")
	}

	args := []string{
		"--cluster",
		"add-node",
		fmt.Sprintf("%s:%d", options.NewHostname, options.NewPort),
		fmt.Sprintf("%s:%d", options.Hostname, options.Port),
		"--cluster-yes",
	}

	if options.Username != "" {
		args = append(args, "--user", options.Username)
	}

	fmt.Printf("Command: valkey-cli %s\n", strings.Join(args, " "))
	if options.Password != "" {
		args = append(args, "-a", options.Password)
	}

	cmd := exec.Command("valkey-cli", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

type DelNodeOptions struct {
	CliBaseOptions

	NodeID string
}

func DelNode(options DelNodeOptions) error {
	if !doesCommandExist("valkey-cli") {
		return fmt.Errorf("valkey-cli is not installed")
	}
	if err := options.ValidateConnection(); err != nil {
		return err
	}
	if err := options.ValidateAuth(); err != nil {
		return err
	}

	args := []string{"--cluster", "del-node", options.Address(), options.NodeID, "--cluster-yes"}

	if options.Username != "" {
		args = append(args, "--user", options.Username)
	}
	fmt.Printf("Command: valkey-cli %s\n", strings.Join(args, " "))
	if options.Password != "" {
		args = append(args, "-a", options.Password)
	}

	cmd := exec.Command("valkey-cli", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

type DelShardOptions struct {
	Shard    Shard
	Topology Topology
	Env      utils.Env
}

func DelShard(options DelShardOptions) (newClusterTopology Topology, err error) {
	topology := options.Topology
	shardMasterNode, exists := topology.Masters[options.Shard.MasterId]
	if !exists {
		return Topology{}, fmt.Errorf("master %s not found in topology", options.Shard.MasterId)
	}

	env := options.Env
	clusterClientHostnames, err := GetClusterConnectionInfo(utils.GetHeadlessServiceFQDN(env.ClusterName, env.Namespace), env)
	if err != nil {
		return Topology{}, err
	}
	jesusClient := clusterClientHostnames[0]
	lastColonHostnameIndex := strings.LastIndex(jesusClient, ":")
	hostname := jesusClient[:lastColonHostnameIndex]
	cliBaseOptions := CliBaseOptions{
		Connection: Connection{
			Hostname: hostname,
			Port:     uint16(6379),
		},
		Auth: Auth{
			Username: AdminUser,
			Password: env.AdminPassword,
		},
	}

	removedNodes := make(map[string]struct{}, len(shardMasterNode.SlaveIds)+1) // +1 for the master
	for _, slaveId := range shardMasterNode.SlaveIds {
		slaveNode, exists := topology.Slaves[slaveId]
		if !exists {
			return Topology{}, fmt.Errorf("slave %s not found in topology", slaveId)
		}
		if err := DelNode(DelNodeOptions{CliBaseOptions: cliBaseOptions, NodeID: slaveNode.ID}); err != nil {
			return Topology{}, err
		}
		removedNodes[slaveNode.ID] = struct{}{}
	}

	weights := make(map[string]float64)
	for _, masterNode := range topology.Masters {
		if masterNode.Node.ID == shardMasterNode.Node.ID {
			weights[masterNode.Node.ID] = 0.0
			continue
		}

		weights[masterNode.Node.ID] = 1.0
	}
	if _, included := weights[shardMasterNode.Node.ID]; !included {
		return Topology{}, fmt.Errorf("master %s not found in topology", shardMasterNode.Node.ID)
	}
	rebalanceOptions := RebalanceOptions{
		CliBaseOptions:  cliBaseOptions,
		UseEmptyMasters: true,
		Weights:         weights,
		Replace:         true,
	}
	if err := Rebalance(rebalanceOptions); err != nil {
		return Topology{}, err
	}

	if err := DelNode(DelNodeOptions{CliBaseOptions: cliBaseOptions, NodeID: shardMasterNode.Node.ID}); err != nil {
		return Topology{}, err
	}
	removedNodes[shardMasterNode.Node.ID] = struct{}{}

	leftOverNodeCount := len(topology.OrderedNodes) - len(removedNodes)
	leftOverNodeHostnames := make([]string, 0, leftOverNodeCount)
	for _, node := range topology.OrderedNodes {
		if _, exists := removedNodes[node.ID]; !exists {
			leftOverNodeHostnames = append(leftOverNodeHostnames, fmt.Sprintf("%s:%d", node.Hostname, node.Port))
		}
	}
	timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := WaitForAllNodesClusterInfoState(
		timeoutCtx,
		env,
		leftOverNodeHostnames,
		fmt.Sprintf("cluster_known_nodes:%d", leftOverNodeCount)); err != nil {
		return Topology{}, err
	}

	client, err := valkeygo.NewClient(valkeygo.ClientOption{
		InitAddress: leftOverNodeHostnames,
		Username:    AdminUser,
		Password:    env.AdminPassword,
	})
	newClusterTopology, err = GetClusterTopology(client)
	if err != nil {
		return Topology{}, err
	}

	return newClusterTopology, nil
}

// NOTE: you don't need to specify connection info
type CreateClusterOptions struct {
	CliBaseOptions

	Nodes             []string
	ReplicasPerMaster int
}

func CreateCluster(options CreateClusterOptions) error {
	if !doesCommandExist("valkey-cli") {
		return fmt.Errorf("valkey-cli is not installed")
	}
	if err := options.ValidateAuth(); err != nil {
		return err
	}

	if len(options.Nodes) == 0 {
		return fmt.Errorf("no nodes provided")
	}
	if options.ReplicasPerMaster < 0 {
		return fmt.Errorf("replicas per master must be greater than or equal to 0")
	}

	args := []string{"--cluster", "create"}
	args = append(args, options.Nodes...)
	args = append(args, "--cluster-replicas", strconv.Itoa(options.ReplicasPerMaster), "--cluster-yes")

	if options.Username != "" {
		args = append(args, "--user", options.Username)
	}
	fmt.Printf("Command: valkey-cli %s\n", strings.Join(args, " "))
	if options.Password != "" {
		args = append(args, "-a", options.Password)
	}

	cmd := exec.Command("valkey-cli", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
