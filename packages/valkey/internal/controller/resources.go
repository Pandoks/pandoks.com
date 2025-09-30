package controller

import (
	"os"
	valkeyv1 "valkey/operator/api/v1"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	ctrlruntime "sigs.k8s.io/controller-runtime"
)

var dev bool

func init() {
	dev = os.Getenv("DEV") == "true"
}

func (r *ValkeyClusterReconciler) statefulSet(valkeyCluster *valkeyv1.ValkeyCluster) (*appsv1.StatefulSet, error) {
	statefulSet := &appsv1.StatefulSet{}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, statefulSet, r.Scheme); err != nil {
		return nil, err
	}
	return statefulSet, nil
}

func (r *ValkeyClusterReconciler) headlessService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	headlessService := &corev1.Service{}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, headlessService, r.Scheme); err != nil {
		return nil, err
	}
	return headlessService, nil
}

func (r *ValkeyClusterReconciler) masterService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	masterService := &corev1.Service{}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, masterService, r.Scheme); err != nil {
		return nil, err
	}
	return masterService, nil
}

func (r *ValkeyClusterReconciler) slaveService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	slaveService := &corev1.Service{}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, slaveService, r.Scheme); err != nil {
		return nil, err
	}
	return slaveService, nil
}
