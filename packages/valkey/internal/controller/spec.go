package controller

import (
	"fmt"

	"k8s.io/apimachinery/pkg/api/resource"

	valkeyv1 "valkey/operator/api/v1"
)

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
