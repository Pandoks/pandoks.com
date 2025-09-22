package controller

import (
	"context"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	valkeyv1 "valkey/operator/api/v1"
)

type ValkeyClusterReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *ValkeyClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	var vkc valkeyv1.ValkeyCluster
	if err := r.Get(ctx, req.NamespacedName, &vkc); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	logger.Info("reconciled ValkeyCluster", "name", req.NamespacedName)
	return ctrl.Result{}, nil
}

func (r *ValkeyClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&valkeyv1.ValkeyCluster{}).
		Complete(r)
}
