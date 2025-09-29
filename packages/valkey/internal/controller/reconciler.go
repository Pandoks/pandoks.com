package controller

import (
	"context"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrlruntime "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	valkeyv1 "valkey/operator/api/v1"
)

const typeAvailable = "Available"

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

	if cluster.Status == nil {
		cluster.Status = &valkeyv1.ValkeyClusterStatus{}
	}

	if err := validateValkeyClusterSpec(&cluster.Spec); err != nil {
		logger.Error(err, "invalid ValkeyCluster spec", "name", req.NamespacedName)

		if err := r.patchReadyStatus(ctx, &cluster, false); err != nil {
			logger.Error(err, "unable to update ValkeyCluster status")
			return ctrlruntime.Result{}, err
		}

		return ctrlruntime.Result{}, nil
	}

	if err := r.validateConfigMap(ctx, &cluster); err != nil {
		logger.Error(err, "invalid configmap")
		return ctrlruntime.Result{}, err
	}

	if err := r.reconcileHeadlessService(ctx, &cluster); err != nil {
		logger.Error(err, "failed to reconcile headless service")
		return ctrlruntime.Result{}, err
	}

	logger.Info("reconciled ValkeyCluster", "name", req.NamespacedName)
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

func (r *ValkeyClusterReconciler) patchReadyStatus(ctx context.Context, cluster *valkeyv1.ValkeyCluster, ready bool) error {
	if cluster.Status == nil {
		cluster.Status = &valkeyv1.ValkeyClusterStatus{}
	}

	if cluster.Status.Ready == ready {
		return nil
	}

	original := cluster.DeepCopy()
	cluster.Status.Ready = ready

	return r.Status().Patch(ctx, cluster, client.MergeFrom(original))
}
