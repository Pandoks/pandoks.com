package controller

import (
	"context"
	"fmt"
	"os"
	"strconv"
	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/cluster"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlruntime "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/log"
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

const (
	valkeyConfigMapName = "valkey-config"
	valkeyMountPath     = "/tmp/conf_templates/valkey.conf"
	valkeyMountSubPath  = "valkey.conf"
	valkeyDataMountName = "valkey-data"
	valkeyDataMountPath = "/data"
)

func (r *ValkeyClusterReconciler) statefulSet(valkeyCluster *valkeyv1.ValkeyCluster) (*appsv1.StatefulSet, error) {
	replicas := r.calculateReplicas(valkeyCluster)

	persistentVolumeClaims := []corev1.PersistentVolumeClaim{}
	volumeMounts := []corev1.VolumeMount{
		{
			Name:      valkeyConfigMapName,
			MountPath: valkeyMountPath,
			SubPath:   valkeyMountSubPath,
		},
	}

	if len(valkeyCluster.Spec.Persistence) > 0 {
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      valkeyDataMountName,
			MountPath: valkeyDataMountPath,
		})

		persistentVolumeClaims = append(persistentVolumeClaims, corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{
				Name: valkeyDataMountName,
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
		})
	}

	envs := []corev1.EnvVar{
		{Name: "PORT", Value: strconv.Itoa(cluster.ValkeyClientPort)},
		{
			Name: "POD_NAME",
			ValueFrom: &corev1.EnvVarSource{
				FieldRef: &corev1.ObjectFieldSelector{
					FieldPath: "metadata.name",
				},
			},
		},
		{
			Name: "NAMESPACE",
			ValueFrom: &corev1.EnvVarSource{
				FieldRef: &corev1.ObjectFieldSelector{
					FieldPath: "metadata.namespace",
				},
			},
		},
		{Name: "HEADLESS_SERVICE", Value: valkeyCluster.HeadlessServiceName()},
		{Name: "ANNOUNCE_PORT", Value: strconv.Itoa(cluster.ValkeyClientPort)},
		{Name: "ANNOUNCE_BUS_PORT", Value: strconv.Itoa(cluster.ValkeyGossipPort)},
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
						Env:          envs,
						VolumeMounts: volumeMounts,
					}},
					Volumes: []corev1.Volume{
						{
							Name: valkeyConfigMapName,
							VolumeSource: corev1.VolumeSource{
								ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: valkeyConfigMapName}},
							},
						},
					},
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
func (r *ValkeyClusterReconciler) createStatefulSet(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster) error {
	logger := log.FromContext(ctx)
	newStatefulSet, err := r.statefulSet(valkeyCluster)
	if err != nil {
		logger.Error(err, "Failed to define a new statefulset for valkey cluster")
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeAvailable,
				Status:  metav1.ConditionFalse,
				Reason:  "Reconciling",
				Message: fmt.Sprintf("Failed to create statefulset for the custom resource (%s): (%s)", valkeyCluster.Name, err),
			},
		)
		if err = r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}
		return err
	}

	logger.Info("Creating new statefulset",
		"StatefulSet.Namespace", newStatefulSet.Namespace, "StatefulSet.Name", newStatefulSet.Name)
	if err = r.Create(ctx, newStatefulSet); err != nil {
		logger.Error(err, "Failed to create new statefulset",
			"StatefulSet.Namespace", newStatefulSet.Namespace, "StatefulSet.Name", newStatefulSet.Name)
		return err
	}
	return nil
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
func (r *ValkeyClusterReconciler) createHeadlessService(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster) error {
	logger := log.FromContext(ctx)

	newHeadlessService, err := r.headlessService(valkeyCluster)
	if err != nil {
		logger.Error(err, "Failed to define new headless service for valkey cluster")
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeAvailable,
				Status:  metav1.ConditionFalse,
				Reason:  "Reconciling",
				Message: fmt.Sprintf("Failed to create headlessService for the custom resource (%s): (%s)", valkeyCluster.Name, err),
			},
		)
		if err = r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}
		return err
	}

	logger.Info("Creating new headless service",
		"HeadlessService.Namespace", newHeadlessService.Namespace, "HeadlessService.Name", newHeadlessService.Name)
	if err = r.Create(ctx, newHeadlessService); err != nil {
		logger.Error(err, "Failed to create new headless service",
			"HeadlessService.Namespace", newHeadlessService.Namespace, "HeadlessService.Name", newHeadlessService.Name)
		return err
	}
	return nil
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
func (r *ValkeyClusterReconciler) createMasterService(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster) error {
	logger := log.FromContext(ctx)
	newMasterService, err := r.masterService(valkeyCluster)
	if err != nil {
		logger.Error(err, "Failed to define new master service for valkey cluster")
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeAvailable,
				Status:  metav1.ConditionFalse,
				Reason:  "Reconciling",
				Message: fmt.Sprintf("Failed to create master service for the custom resource (%s): (%s)", valkeyCluster.Name, err),
			},
		)
		if err = r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}
		return err
	}

	logger.Info("Creating new master service",
		"MasterService.Namespace", newMasterService.Namespace, "MasterService.Name", newMasterService.Name)
	if err = r.Create(ctx, newMasterService); err != nil {
		logger.Error(err, "Failed to create new master service",
			"MasterService.Namespace", newMasterService.Namespace, "MasterService.Name", newMasterService.Name)
		return err
	}
	return nil
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
func (r *ValkeyClusterReconciler) createSlaveService(ctx context.Context, valkeyCluster *valkeyv1.ValkeyCluster) error {
	logger := log.FromContext(ctx)
	newSlaveService, err := r.slaveService(valkeyCluster)
	if err != nil {
		logger.Error(err, "Failed to define new slave service for valkey cluster")
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeAvailable,
				Status:  metav1.ConditionFalse,
				Reason:  "Reconciling",
				Message: fmt.Sprintf("Failed to create slave service for the custom resource (%s): (%s)", valkeyCluster.Name, err),
			},
		)
		if err = r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}
		return err
	}

	logger.Info("Creating new slave service",
		"SlaveService.Namespace", newSlaveService.Namespace, "SlaveService.Name", newSlaveService.Name)
	if err = r.Create(ctx, newSlaveService); err != nil {
		logger.Error(err, "Failed to create new slave service",
			"SlaveService.Namespace", newSlaveService.Namespace, "SlaveService.Name", newSlaveService.Name)
		return err
	}
	return nil
}

// fqdn: fully qualified domain name
func (r *ValkeyClusterReconciler) valkeyClientAddresses(valkeyCluster *valkeyv1.ValkeyCluster) []cluster.Address {
	replicas := r.calculateReplicas(valkeyCluster)

	var addresses []cluster.Address
	for index := range replicas {
		host := fmt.Sprintf("%s-%d.%s.%s.svc.cluster.local",
			valkeyCluster.StatefulSetName(),
			index,
			valkeyCluster.HeadlessServiceName(),
			valkeyCluster.Namespace,
		)
		port := int64(cluster.ValkeyClientPort)
		addresses = append(addresses, cluster.Address{Host: host, Port: port})
	}
	return addresses
}
