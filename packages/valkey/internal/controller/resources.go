package controller

import (
	"context"
	"fmt"
	"reflect"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	valkeyv1 "valkey/operator/api/v1"
)

func (r *ValkeyClusterReconciler) validateConfigMap(ctx context.Context, cluster *valkeyv1.ValkeyCluster) error {
	var existing corev1.ConfigMap
	if err := r.Get(ctx, types.NamespacedName{Name: valkeyConfigVolumeName, Namespace: cluster.Namespace}, &existing); err != nil {
		if errors.IsNotFound(err) {
			return fmt.Errorf("configmap %q not found", valkeyConfigVolumeName)
		}

		return err
	}

	if _, ok := existing.Data[valkeyConfigFileName]; !ok {
		return fmt.Errorf("configmap %q missing required key %q", valkeyConfigVolumeName, valkeyConfigFileName)
	}

	return nil
}

func (r *ValkeyClusterReconciler) reconcileHeadlessService(ctx context.Context, cluster *valkeyv1.ValkeyCluster) error {
	selector := map[string]string{
		clusterLabelKey: cluster.Name,
	}

	desired := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      headlessServiceName(cluster),
			Namespace: cluster.Namespace,
			Labels:    labelsForCluster(cluster),
		},
		Spec: corev1.ServiceSpec{
			ClusterIP: corev1.ClusterIPNone,
			Selector:  selector,
			Ports: []corev1.ServicePort{
				{
					Name:     "client",
					Port:     valkeyPort,
					Protocol: corev1.ProtocolTCP,
				},
			},
		},
	}

	if err := controllerutil.SetControllerReference(cluster, desired, r.Scheme); err != nil {
		return err
	}

	var existing corev1.Service
	err := r.Get(ctx, types.NamespacedName{Name: desired.Name, Namespace: desired.Namespace}, &existing)
	if errors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}

	if err != nil {
		return err
	}

	needsUpdate := !reflect.DeepEqual(existing.Labels, desired.Labels) ||
		!reflect.DeepEqual(existing.Spec.Selector, desired.Spec.Selector) ||
		!reflect.DeepEqual(existing.Spec.Ports, desired.Spec.Ports) ||
		existing.Spec.ClusterIP != corev1.ClusterIPNone

	if !needsUpdate {
		return nil
	}

	existing.Labels = desired.Labels
	existing.Spec.Selector = desired.Spec.Selector
	existing.Spec.Ports = desired.Spec.Ports
	existing.Spec.ClusterIP = corev1.ClusterIPNone

	if err := controllerutil.SetControllerReference(cluster, &existing, r.Scheme); err != nil {
		return err
	}

	return r.Update(ctx, &existing)
}

func labelsForCluster(cluster *valkeyv1.ValkeyCluster) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":     "valkey-cluster",
		"app.kubernetes.io/instance": cluster.Name,
		clusterLabelKey:              cluster.Name,
	}
}

func headlessServiceName(cluster *valkeyv1.ValkeyCluster) string {
	return fmt.Sprintf("%s-valkey-headless", cluster.Name)
}
