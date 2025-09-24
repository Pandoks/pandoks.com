package controller

import (
	"context"
	"fmt"
	"reflect"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
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

func (r *ValkeyClusterReconciler) reconcileMasterStatefulSets(ctx context.Context, cluster *valkeyv1.ValkeyCluster) error {
	for ordinal := int32(0); ordinal < cluster.Spec.Masters; ordinal++ {
		if err := r.ensureMasterStatefulSet(ctx, cluster, ordinal); err != nil {
			return err
		}
	}

	return nil
}

func (r *ValkeyClusterReconciler) ensureMasterStatefulSet(ctx context.Context, cluster *valkeyv1.ValkeyCluster, ordinal int32) error {
	desired := buildMasterStatefulSet(cluster, ordinal)

	if err := controllerutil.SetControllerReference(cluster, desired, r.Scheme); err != nil {
		return err
	}

	var existing appsv1.StatefulSet
	err := r.Get(ctx, types.NamespacedName{Name: desired.Name, Namespace: desired.Namespace}, &existing)
	if errors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}

	if err != nil {
		return err
	}

	needsUpdate := !reflect.DeepEqual(existing.Spec, desired.Spec) || !reflect.DeepEqual(existing.Labels, desired.Labels)

	if !needsUpdate {
		return nil
	}

	updated := existing.DeepCopy()
	updated.Spec = desired.Spec
	updated.Labels = desired.Labels

	if err := controllerutil.SetControllerReference(cluster, updated, r.Scheme); err != nil {
		return err
	}

	return r.Update(ctx, updated)
}

func buildMasterStatefulSet(cluster *valkeyv1.ValkeyCluster, ordinal int32) *appsv1.StatefulSet {
	baseLabels := labelsForCluster(cluster)
	podLabels := make(map[string]string, len(baseLabels)+2)
	for key, value := range baseLabels {
		podLabels[key] = value
	}
	podLabels["app.kubernetes.io/component"] = "valkey"
	podLabels[clusterLabelKey] = cluster.Name
	podLabels[masterOrdinalLabelKey] = fmt.Sprintf("%d", ordinal)

	replicas := int32(1 + cluster.Spec.ReplicasPerMaster)

	env := []corev1.EnvVar{
		{Name: "PORT", Value: fmt.Sprintf("%d", valkeyPort)},
		{Name: "CLUSTER_NODE_TIMEOUT", Value: defaultClusterNodeTimeout},
	}

	volumeMounts := []corev1.VolumeMount{
		{Name: valkeyConfigVolumeName, MountPath: "/tmp/conf_templates"},
		{Name: dataVolumeName, MountPath: "/data"},
	}

	volumes := []corev1.Volume{
		{
			Name: valkeyConfigVolumeName,
			VolumeSource: corev1.VolumeSource{
				ConfigMap: &corev1.ConfigMapVolumeSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: valkeyConfigVolumeName},
				},
			},
		},
	}

	if cluster.Spec.StoragePerNode == "" {
		volumes = append(volumes, corev1.Volume{
			Name:         dataVolumeName,
			VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
		})
	}

	container := corev1.Container{
		Name:            "valkey",
		Image:           defaultValkeyImage,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Env:             env,
		Ports:           []corev1.ContainerPort{{Name: "client", ContainerPort: valkeyPort, Protocol: corev1.ProtocolTCP}},
		VolumeMounts:    volumeMounts,
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("100m"),
				corev1.ResourceMemory: resource.MustParse("256Mi"),
			},
		},
	}

	podSpec := corev1.PodSpec{Containers: []corev1.Container{container}}
	if len(volumes) > 0 {
		podSpec.Volumes = volumes
	}

	volumeClaims := []corev1.PersistentVolumeClaim{}
	if cluster.Spec.StoragePerNode != "" {
		volumeClaims = append(volumeClaims, corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{Name: dataVolumeName},
			Spec: corev1.PersistentVolumeClaimSpec{
				AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
				Resources: corev1.VolumeResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(cluster.Spec.StoragePerNode)},
				},
			},
		})
	}

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      masterStatefulSetName(cluster, ordinal),
			Namespace: cluster.Namespace,
			Labels:    baseLabels,
		},
		Spec: appsv1.StatefulSetSpec{
			ServiceName: headlessServiceName(cluster),
			Replicas:    &replicas,
			Selector:    &metav1.LabelSelector{MatchLabels: podLabels},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: podLabels},
				Spec:       podSpec,
			},
			VolumeClaimTemplates: volumeClaims,
		},
	}
}

func labelsForCluster(cluster *valkeyv1.ValkeyCluster) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":     "valkey-cluster",
		"app.kubernetes.io/instance": cluster.Name,
		clusterLabelKey:              cluster.Name,
	}
}

func headlessServiceName(cluster *valkeyv1.ValkeyCluster) string {
	return fmt.Sprintf("%s-headless", cluster.Name)
}

func masterStatefulSetName(cluster *valkeyv1.ValkeyCluster, ordinal int32) string {
	return fmt.Sprintf("%s-master-%d", cluster.Name, ordinal)
}
