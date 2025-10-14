package controller

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrlruntime "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	valkeyv1 "valkey/operator/api/v1"
)

const (
	typeAvailable              = "Available"
	typeMeetingStandaloneNodes = "MeetingStandaloneNodes"
	typeMigratingSlots         = "MigratingSlots"
	typeEnsuringReplicas       = "EnsuringReplicas"
)

type ValkeyClusterReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *ValkeyClusterReconciler) Reconcile(ctx context.Context, req ctrlruntime.Request) (ctrlruntime.Result, error) {
	logger := log.FromContext(ctx)

	valkeyCluster := &valkeyv1.ValkeyCluster{}
	err := r.Get(ctx, req.NamespacedName, valkeyCluster)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err == nil {
			logger.Info("Valkey cluster not found. Ignoring since object must be deleted")
		} else {
			logger.Error(err, "Failed to get valkey cluster")
		}
		return ctrlruntime.Result{}, err
	}

	if len(valkeyCluster.Status.Conditions) == 0 {
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeAvailable,
				Status:  metav1.ConditionUnknown,
				Reason:  "Reconciling",
				Message: "Starting reconciliation"},
		)
		if err = r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
			return ctrlruntime.Result{}, err
		}
	}

	// Check for underlying resources and if they don't exist, create them & requeue reconciliation
	needsRequeue := false
	headlessService := &corev1.Service{}
	statefulSet := &appsv1.StatefulSet{}
	masterService := &corev1.Service{}
	slaveService := &corev1.Service{}

	namespacedName := types.NamespacedName{Name: valkeyCluster.HeadlessServiceName(), Namespace: valkeyCluster.Namespace}
	err = r.Get(ctx, namespacedName, headlessService)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err != nil {
			logger.Error(err, "Failed to get headless service")
			return ctrlruntime.Result{}, err
		}
		if err = r.createHeadlessService(ctx, valkeyCluster); err != nil {
			return ctrlruntime.Result{}, err
		}
		needsRequeue = true
	}

	namespacedName = types.NamespacedName{Name: valkeyCluster.StatefulSetName(), Namespace: valkeyCluster.Namespace}
	err = r.Get(ctx, namespacedName, statefulSet)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err != nil {
			logger.Error(err, "Failed to get statefulset")
			return ctrlruntime.Result{}, err
		}
		if err = r.createStatefulSet(ctx, valkeyCluster); err != nil {
			return ctrlruntime.Result{}, err
		}
		needsRequeue = true
	}

	namespacedName = types.NamespacedName{Name: valkeyCluster.MasterServiceName(), Namespace: valkeyCluster.Namespace}
	err = r.Get(ctx, namespacedName, masterService)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err != nil {
			logger.Error(err, "Failed to get master service")
			return ctrlruntime.Result{}, err
		}
		if err = r.createMasterService(ctx, valkeyCluster); err != nil {
			return ctrlruntime.Result{}, err
		}
		needsRequeue = true
	}

	namespacedName = types.NamespacedName{Name: valkeyCluster.SlaveServiceName(), Namespace: valkeyCluster.Namespace}
	err = r.Get(ctx, namespacedName, slaveService)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err != nil {
			logger.Error(err, "Failed to get slave service")
			return ctrlruntime.Result{}, err
		}
		if err = r.createSlaveService(ctx, valkeyCluster); err != nil {
			return ctrlruntime.Result{}, err
		}
		needsRequeue = true
	}

	if statefulSet.Status.ReadyReplicas != *statefulSet.Spec.Replicas {
		logger.Info("Waiting for all pods to be ready", "ready", statefulSet.Status.ReadyReplicas, "desired", *statefulSet.Spec.Replicas)
		needsRequeue = true
	}

	if needsRequeue {
		return ctrlruntime.Result{RequeueAfter: 30 * time.Second}, nil
	}

	// underlying resources exist (but they may not be fully updated)
	currentReplicas := *statefulSet.Spec.Replicas
	desiredReplicas := r.calculateReplicas(valkeyCluster)
	if currentReplicas > desiredReplicas { // needs slot migration

	} else if currentReplicas < desiredReplicas { // simple scale up
		logger.Info("Scaling up statefulset replicas", "current", currentReplicas, "desired", desiredReplicas)
		statefulSet.Spec.Replicas = &desiredReplicas
		if err := r.Update(ctx, statefulSet); err != nil {
			logger.Error(err, "Failed to scale up statefulset replicas")
		}
	}

	if err = r.reconcileCluster(ctx, valkeyCluster, statefulSet); err != nil {
		logger.Error(err, "Failed to reconcile cluster's statefulset")
		meta.SetStatusCondition(
			&valkeyCluster.Status.Conditions,
			metav1.Condition{
				Type:    typeAvailable,
				Status:  metav1.ConditionFalse,
				Reason:  "ReconcileFailed",
				Message: fmt.Sprintf("Failed to reconcile cluster's statefulset: %s", err),
			},
		)
		if err = r.Status().Update(ctx, valkeyCluster); err != nil {
			logger.Error(err, "Failed to update valkey cluster status")
		}
		return ctrlruntime.Result{}, err
	}

	meta.SetStatusCondition(
		&valkeyCluster.Status.Conditions,
		metav1.Condition{
			Type:    typeAvailable,
			Status:  metav1.ConditionTrue,
			Reason:  "ClusterReady",
			Message: "Cluster is ready",
		},
	)
	if err = r.Status().Update(ctx, valkeyCluster); err != nil {
		logger.Error(err, "Failed to update valkey cluster status")
	}

	return ctrlruntime.Result{}, nil
}

func (r *ValkeyClusterReconciler) SetupWithManager(mgr ctrlruntime.Manager) error {
	return ctrlruntime.NewControllerManagedBy(mgr).
		For(&valkeyv1.ValkeyCluster{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.ConfigMap{}).
		Complete(r)
}
