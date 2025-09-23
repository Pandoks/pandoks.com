package controller

import (
	"context"

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

func (reconciler *ValkeyClusterReconciler) Reconcile(context context.Context, request ctrlruntime.Request) (ctrlruntime.Result, error) {
	logger := log.FromContext(context)
	var valkeyCluster valkeyv1.ValkeyCluster
	if err := reconciler.Get(context, request.NamespacedName, &valkeyCluster); err != nil {
		return ctrlruntime.Result{}, client.IgnoreNotFound(err)
	}
	logger.Info("reconciled ValkeyCluster", "name", request.NamespacedName)
	return ctrlruntime.Result{}, nil
}

func (reconciler *ValkeyClusterReconciler) SetupWithManager(manager ctrlruntime.Manager) error {
	return ctrlruntime.NewControllerManagedBy(manager).
		For(&valkeyv1.ValkeyCluster{}).
		Complete(reconciler)
}
