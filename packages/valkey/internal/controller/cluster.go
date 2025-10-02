package controller

import (
	"context"
	"fmt"
	valkeyv1 "valkey/operator/api/v1"

	"github.com/valkey-io/valkey-go"
	appsv1 "k8s.io/api/apps/v1"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

func (r *ValkeyClusterReconciler) reconcileClusterStatefulSet(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster, statefulSet *appsv1.StatefulSet) error {
	logger := log.FromContext(ctx)

	// fqdn: fully qualified domain name
	var podFQDNs []string
	for i := range *statefulSet.Spec.Replicas {
		fqdn := fmt.Sprintf("%s-%d.%s.%s.svc.cluster.local:%d",
			statefulSet.Name,
			i,
			valkeyCluster.HeadlessServiceName(),
			valkeyCluster.Namespace,
			ValkeyClientPort,
		)
		podFQDNs = append(podFQDNs, fqdn)
	}

	var clients []valkey.Client
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
		clients = append(clients, client)
	}

	return nil
}
