package controller

import (
	"fmt"
	"os"
	valkeyv1 "valkey/operator/api/v1"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
	replicas := valkeyCluster.Spec.Masters + valkeyCluster.Spec.Masters*valkeyCluster.Spec.ReplicasPerMaster

	persistentVolumeClaims := []corev1.PersistentVolumeClaim{}
	volumeMounts := []corev1.VolumeMount{}
	if len(valkeyCluster.Spec.Persistence) > 0 {
		dataName := "valkey-data"
		volumeMounts = []corev1.VolumeMount{{
			Name:      dataName,
			MountPath: "/data",
		}}
		persistentVolumeClaims = []corev1.PersistentVolumeClaim{{
			ObjectMeta: metav1.ObjectMeta{
				Name: dataName,
			},
			Spec: corev1.PersistentVolumeClaimSpec{
				AccessModes: []corev1.PersistentVolumeAccessMode{
					corev1.ReadWriteOnce,
				},
				Resources: corev1.VolumeResourceRequirements{
					Requests: corev1.ResourceList{
						corev1.ResourceStorage: valkeyCluster.Spec.StoragePerNode,
					},
				},
			},
		}}
	}

	statefulSet := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      statefulSetName(valkeyCluster),
			Namespace: valkeyCluster.Namespace,
		},
		Spec: appsv1.StatefulSetSpec{
			Replicas: &replicas,
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Image: valkeyImage,
						Name:  "valkey",
						Ports: []corev1.ContainerPort{{
							ContainerPort: 6379,
						}},
						VolumeMounts: volumeMounts,
					}},
				},
			},
			VolumeClaimTemplates: persistentVolumeClaims,
		},
	}

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
