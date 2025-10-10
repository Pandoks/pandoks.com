package controller

import (
	"fmt"
	"os"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/cluster"

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
	replicas := r.calculateReplicas(valkeyCluster)

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
			Name:      valkeyCluster.StatefulSetName(),
			Namespace: valkeyCluster.Namespace,
			Labels:    valkeyCluster.Labels(),
		},
		Spec: appsv1.StatefulSetSpec{
			ServiceName: valkeyCluster.HeadlessServiceName(),
			Replicas:    &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: valkeyCluster.Labels(),
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: valkeyCluster.Labels(),
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Image: valkeyImage,
						Name:  "valkey",
						Ports: []corev1.ContainerPort{
							{Name: "client", ContainerPort: cluster.ValkeyClientPort},
							{Name: "gossip", ContainerPort: cluster.ValkeyGossipPort},
						},
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

func (r *ValkeyClusterReconciler) calculateReplicas(valkeyCluster *valkeyv1.ValkeyCluster) int32 {
	return valkeyCluster.Spec.Masters + valkeyCluster.Spec.Masters*valkeyCluster.Spec.ReplicasPerMaster
}

func (r *ValkeyClusterReconciler) headlessService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	headlessService := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      valkeyCluster.HeadlessServiceName(),
			Namespace: valkeyCluster.Namespace,
			Labels:    valkeyCluster.Labels(),
		},
		Spec: corev1.ServiceSpec{
			ClusterIP: "None",
			Selector:  valkeyCluster.Labels(),
			Ports: []corev1.ServicePort{
				{Name: "client", Port: cluster.ValkeyClientPort, Protocol: corev1.ProtocolTCP},
				{Name: "gossip", Port: cluster.ValkeyGossipPort, Protocol: corev1.ProtocolTCP},
			},
		},
	}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, headlessService, r.Scheme); err != nil {
		return nil, err
	}
	return headlessService, nil
}

func (r *ValkeyClusterReconciler) masterService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	selectorLabels := valkeyCluster.Labels()
	selectorLabels["role"] = "master"

	masterService := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      valkeyCluster.MasterServiceName(),
			Namespace: valkeyCluster.Namespace,
			Labels:    valkeyCluster.Labels(),
		},
		Spec: corev1.ServiceSpec{
			Selector: selectorLabels,
			Ports: []corev1.ServicePort{
				{Name: "client", Port: cluster.ValkeyClientPort, Protocol: corev1.ProtocolTCP},
			},
		},
	}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, masterService, r.Scheme); err != nil {
		return nil, err
	}
	return masterService, nil
}

func (r *ValkeyClusterReconciler) slaveService(valkeyCluster *valkeyv1.ValkeyCluster) (*corev1.Service, error) {
	selectorLabels := valkeyCluster.Labels()
	selectorLabels["role"] = "slave"

	slaveService := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      valkeyCluster.SlaveServiceName(),
			Namespace: valkeyCluster.Namespace,
			Labels:    valkeyCluster.Labels(),
		},
		Spec: corev1.ServiceSpec{
			Selector: selectorLabels,
			Ports: []corev1.ServicePort{
				{Name: "client", Port: cluster.ValkeyClientPort, Protocol: corev1.ProtocolTCP},
			},
		},
	}

	if err := ctrlruntime.SetControllerReference(valkeyCluster, slaveService, r.Scheme); err != nil {
		return nil, err
	}
	return slaveService, nil
}

// fqdn: fully qualified domain name
func (r *ValkeyClusterReconciler) podFQDNs(valkeyCluster *valkeyv1.ValkeyCluster) []string {
	replicas := r.calculateReplicas(valkeyCluster)

	var podFQDNs []string
	for index := range replicas {
		fqdn := fmt.Sprintf("%s-%d.%s.%s.svc.cluster.local:%d",
			valkeyCluster.StatefulSetName(),
			index,
			valkeyCluster.HeadlessServiceName(),
			valkeyCluster.Namespace,
			cluster.ValkeyClientPort,
		)
		podFQDNs = append(podFQDNs, fqdn)
	}
	return podFQDNs
}
