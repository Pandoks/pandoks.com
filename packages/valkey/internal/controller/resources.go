package controller

import (
	"fmt"
	"os"
	valkeyv1 "valkey/operator/api/v1"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	ctrlruntime "sigs.k8s.io/controller-runtime"
)

var dev bool
var valkeyImage string

func init() {
	dev = os.Getenv("DEV") == "true"
	if dev {
		valkeyImage = "local-registry:12345/valkey:latest"
	} else {
		valkeyImage = "ghcr.io/pandoks/valkey:latest"
	}
}

func (r *ValkeyClusterReconciler) statefulSet(valkeyCluster *valkeyv1.ValkeyCluster) (*appsv1.StatefulSet, error) {
	statefulSet := &appsv1.StatefulSet{}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, statefulSet, r.Scheme); err != nil {
		return nil, err
	}
	return statefulSet, nil
}
func statefulSetName(valkeyCluster *valkeyv1.ValkeyCluster) string {
	return fmt.Sprintf("%s-valkey", valkeyCluster.Name)
}

func (r *ValkeyClusterReconciler) headlessService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	headlessService := &corev1.Service{}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, headlessService, r.Scheme); err != nil {
		return nil, err
	}
	return headlessService, nil
}
func headlessServiceName(valkeyCluster *valkeyv1.ValkeyCluster) string {
	return fmt.Sprintf("%s-headless-valkey", valkeyCluster.Name)
}

func (r *ValkeyClusterReconciler) masterService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	masterService := &corev1.Service{}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, masterService, r.Scheme); err != nil {
		return nil, err
	}
	return masterService, nil
}
func masterServiceName(valkeyCluster *valkeyv1.ValkeyCluster) string {
	return fmt.Sprintf("%s-master-valkey", valkeyCluster.Name)
}

func (r *ValkeyClusterReconciler) slaveService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	slaveService := &corev1.Service{}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, slaveService, r.Scheme); err != nil {
		return nil, err
	}
	return slaveService, nil
}
func slaveServiceName(valkeyCluster *valkeyv1.ValkeyCluster) string {
	return fmt.Sprintf("%s-slave-valkey", valkeyCluster.Name)
}
