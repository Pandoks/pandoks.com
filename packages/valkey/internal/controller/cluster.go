package controller

import (
	"context"
	"fmt"
	valkeyv1 "valkey/operator/api/v1"

	appsv1 "k8s.io/api/apps/v1"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

func (r *ValkeyClusterReconciler) reconcileClusterStatefulSet(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster, statefulSet *appsv1.StatefulSet) error {
	logger := log.FromContext(ctx)

	var podFQDNs []string
	for i := range *statefulSet.Spec.Replicas {
		fqdn := fmt.Sprintf("%s-%d.%s.%s.svc.cluster.local:6379",
			statefulSet.Name,
			i,
			headlessServiceName(valkeyCluster),
			valkeyCluster.Namespace,
		)
		podFQDNs = append(podFQDNs, fqdn)
	}

	return nil
}
