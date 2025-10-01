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

	// Check for underlying resources and if they don't exist, create them & requeue reconciliation
	needsRequeue := false
	headlessService := &corev1.Service{}
	statefulSet := &appsv1.StatefulSet{}
	masterService := &corev1.Service{}
	slaveService := &corev1.Service{}

	namespacedName := types.NamespacedName{Name: headlessServiceName(valkeyCluster), Namespace: valkeyCluster.Namespace}
	err = r.Get(ctx, namespacedName, headlessService)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err != nil {
			logger.Error(err, "Failed to get headless service")
			return ctrlruntime.Result{}, err
		}

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
			return ctrlruntime.Result{}, err
		}

		logger.Info("Creating new headless service",
			"HeadlessService.Namespace", newHeadlessService.Namespace, "HeadlessService.Name", newHeadlessService.Name)
		if err = r.Create(ctx, newHeadlessService); err != nil {
			logger.Error(err, "Failed to create new headless service",
				"HeadlessService.Namespace", newHeadlessService.Namespace, "HeadlessService.Name", newHeadlessService.Name)
			return ctrlruntime.Result{}, err
		}
		needsRequeue = true
	}

	namespacedName = types.NamespacedName{Name: statefulSetName(valkeyCluster), Namespace: valkeyCluster.Namespace}
	err = r.Get(ctx, namespacedName, statefulSet)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err != nil {
			logger.Error(err, "Failed to get statefulset")
			return ctrlruntime.Result{}, err
		}

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
			return ctrlruntime.Result{}, err
		}

		logger.Info("Creating new statefulset",
			"StatefulSet.Namespace", newStatefulSet.Namespace, "StatefulSet.Name", newStatefulSet.Name)
		if err = r.Create(ctx, newStatefulSet); err != nil {
			logger.Error(err, "Failed to create new statefulset",
				"StatefulSet.Namespace", newStatefulSet.Namespace, "StatefulSet.Name", newStatefulSet.Name)
			return ctrlruntime.Result{}, err
		}
		needsRequeue = true
	}

	namespacedName = types.NamespacedName{Name: masterServiceName(valkeyCluster), Namespace: valkeyCluster.Namespace}
	err = r.Get(ctx, namespacedName, masterService)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err != nil {
			logger.Error(err, "Failed to get master service")
			return ctrlruntime.Result{}, err
		}

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
			return ctrlruntime.Result{}, err
		}

		logger.Info("Creating new master service",
			"MasterService.Namespace", newMasterService.Namespace, "MasterService.Name", newMasterService.Name)
		if err = r.Create(ctx, newMasterService); err != nil {
			logger.Error(err, "Failed to create new master service",
				"MasterService.Namespace", newMasterService.Namespace, "MasterService.Name", newMasterService.Name)
			return ctrlruntime.Result{}, err
		}
		needsRequeue = true
	}

	namespacedName = types.NamespacedName{Name: slaveServiceName(valkeyCluster), Namespace: valkeyCluster.Namespace}
	err = r.Get(ctx, namespacedName, slaveService)
	if err != nil {
		err = client.IgnoreNotFound(err)
		if err != nil {
			logger.Error(err, "Failed to get slave service")
			return ctrlruntime.Result{}, err
		}

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
			return ctrlruntime.Result{}, err
		}

		logger.Info("Creating new slave service",
			"SlaveService.Namespace", newSlaveService.Namespace, "SlaveService.Name", newSlaveService.Name)
		if err = r.Create(ctx, newSlaveService); err != nil {
			logger.Error(err, "Failed to create new slave service",
				"SlaveService.Namespace", newSlaveService.Namespace, "SlaveService.Name", newSlaveService.Name)
			return ctrlruntime.Result{}, err
		}
		needsRequeue = true
	}

	if needsRequeue {
		return ctrlruntime.Result{RequeueAfter: time.Minute}, nil
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
