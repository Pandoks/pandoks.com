package controller

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/api/resource"
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

	if valkeyCluster.Status == nil {
		valkeyCluster.Status = &valkeyv1.ValkeyClusterStatus{}
	}

	if err := validateValkeyClusterSpec(&valkeyCluster.Spec); err != nil {
		logger.Error(err, "invalid ValkeyCluster spec", "name", request.NamespacedName)

		if err := reconciler.patchReadyStatus(context, &valkeyCluster, false); err != nil {
			logger.Error(err, "unable to update ValkeyCluster status")
			return ctrlruntime.Result{}, err
		}

		return ctrlruntime.Result{}, nil
	}

	logger.Info("reconciled ValkeyCluster", "name", request.NamespacedName)
	return ctrlruntime.Result{}, nil
}

func (reconciler *ValkeyClusterReconciler) SetupWithManager(manager ctrlruntime.Manager) error {
	return ctrlruntime.NewControllerManagedBy(manager).
		For(&valkeyv1.ValkeyCluster{}).
		Complete(reconciler)
}

func (reconciler *ValkeyClusterReconciler) patchReadyStatus(context context.Context, cluster *valkeyv1.ValkeyCluster, ready bool) error {
	if cluster.Status == nil {
		cluster.Status = &valkeyv1.ValkeyClusterStatus{}
	}

	if cluster.Status.Ready == ready {
		return nil
	}

	original := cluster.DeepCopy()
	cluster.Status.Ready = ready

	return reconciler.Status().Patch(context, cluster, client.MergeFrom(original))
}

var allowedPersistenceModes = map[valkeyv1.ValkeyPersistenceMode]struct{}{
	valkeyv1.PersistenceRDB: {},
	valkeyv1.PersistenceAOF: {},
}

func validateValkeyClusterSpec(spec *valkeyv1.ValkeyClusterSpec) error {
	if spec.Masters <= 0 {
		return fmt.Errorf("spec.masters must be greater than zero")
	}

	if spec.ReplicasPerMaster < 0 {
		return fmt.Errorf("spec.replicasPerMaster must not be negative")
	}

	if spec.StoragePerNode != "" {
		if _, err := resource.ParseQuantity(spec.StoragePerNode); err != nil {
			return fmt.Errorf("spec.storagePerNode is invalid: %w", err)
		}
	}

	for _, mode := range spec.Persistence {
		if _, ok := allowedPersistenceModes[mode]; !ok {
			return fmt.Errorf("spec.persistence contains unsupported mode %q", mode)
		}
	}

	return nil
}
