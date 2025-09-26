package controller

import (
	"context"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrlruntime "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	valkeyv1 "valkey/operator/api/v1"
)

type ValkeyClusterReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *ValkeyClusterReconciler) Reconcile(ctx context.Context, req ctrlruntime.Request) (ctrlruntime.Result, error) {
	logger := log.FromContext(ctx)

	var cluster valkeyv1.ValkeyCluster
	if err := r.Get(ctx, req.NamespacedName, &cluster); err != nil {
		return ctrlruntime.Result{}, client.IgnoreNotFound(err)
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
