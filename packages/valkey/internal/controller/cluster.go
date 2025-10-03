package controller

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	valkeyv1 "valkey/operator/api/v1"

	"github.com/valkey-io/valkey-go"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

const (
	totalSlots = 16384
)

type NodeRole string

const (
	NodeRoleMaster  NodeRole = "master"
	NodeRoleSlave   NodeRole = "slave"
	NodeRoleReplica NodeRole = "replica"
)

type ClusterNode struct {
	ID        string
	FQDN      string
	Host      string
	Port      int
	Role      NodeRole
	MasterID  string
	Slots     []int
	Connected bool
}

type ClusterTopology struct {
	Nodes          map[string]*ClusterNode // nodeID -> node
	Masters        []*ClusterNode
	Replicas       []*ClusterNode
	SlotMap        map[int]string // slot -> nodeID
	IsBootstrapped bool
	TotalSlots     int
}

func (r *ValkeyClusterReconciler) reconcileClusterStatefulSet(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster, statefulSet *appsv1.StatefulSet) error {
	logger := log.FromContext(ctx)

	// fqdn: fully qualified domain name
	podFQDNs := r.podFQDNs(valkeyCluster)

	clients := map[string]valkey.Client{}
	for _, fqdn := range podFQDNs {
		client, err := r.connectToValkeyNode(ctx, fqdn)
		if err != nil {
			for _, client := range clients {
				client.Close()
			}
			logger.Error(err, "Failed to connect to valkey node", "FQDN", fqdn)
			return err
		}
		clients[fqdn] = client
	}

	return nil
}

func (r *ValkeyClusterReconciler) connectToValkeyNode(ctx context.Context, fqdn string) (valkey.Client, error) {
	client, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{fqdn}})
	if err != nil {
		return nil, fmt.Errorf("failed to create client for %s: %w", fqdn, err)
	}

	if err := client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
		client.Close()
		return nil, fmt.Errorf("failed to ping client for %s: %w", fqdn, err)
	}

	return client, nil
}

// returns the string output of the CLUSTER NODES command
func (r *ValkeyClusterReconciler) queryClusterNodes(ctx context.Context, client valkey.Client) (string, error) {
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
