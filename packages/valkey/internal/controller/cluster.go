package controller

import (
	"context"
	valkeyv1 "valkey/operator/api/v1"

	"github.com/valkey-io/valkey-go"
	appsv1 "k8s.io/api/apps/v1"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

type NodeRole string

const (
	NodeRoleMaster NodeRole = "master"
	NodeRoleSlave  NodeRole = "slave"
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
	Nodes          map[string]*ClusterNode // node id -> node
	Masters        map[string]*ClusterNode
	Slaves         map[string]*ClusterNode
	SlotMap        map[int]string // slot -> node id
	IsBootstrapped bool
	TotalSlots     int
}

func (r *ValkeyClusterReconciler) reconcileClusterStatefulSet(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster, statefulSet *appsv1.StatefulSet) error {
	logger := log.FromContext(ctx)

	// fqdn: fully qualified domain name
	podFQDNs := r.podFQDNs(valkeyCluster)

	clients := map[string]valkey.Client{}
	for _, fqdn := range podFQDNs {
		client, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{fqdn}})
		if err != nil {
			for _, c := range clients {
				c.Close()
			}
			logger.Error(err, "failed to create client")
			return err
		}

		if err = client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
			client.Close()
			for _, c := range clients {
				c.Close()
			}
			logger.Error(err, "failed to ping client")
			return err
		}
		clients[fqdn] = client
	}

	return nil
}
