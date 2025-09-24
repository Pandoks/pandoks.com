package v1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ValkeyPersistenceMode string

const PersistenceRDB ValkeyPersistenceMode = "rdb"
const PersistenceAOF ValkeyPersistenceMode = "aof"

type ValkeyClusterSpec struct {
	Masters              int32                          `json:"masters"`
	ReplicasPerMaster    int32                          `json:"replicasPerMaster"`
	Persistence          []ValkeyPersistenceMode        `json:"persistence,omitempty"`
	VolumeClaimTemplates []corev1.PersistentVolumeClaim `json:"volumeClaimTemplates,omitempty"`
}

type ValkeyClusterStatus struct {
	Ready bool `json:"ready,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:path=valkeyclusters,scope=Namespaced,shortName=vkc
// +kubebuilder:printcolumn:name="Masters",type=integer,JSONPath=`.spec.masters`
// +kubebuilder:printcolumn:name="Replicas Per Master",type=integer,JSONPath=`.spec.replicasPerMaster`
// +kubebuilder:printcolumn:name="Ready",type=boolean,JSONPath=`.status.ready`
type ValkeyCluster struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata"`

	Spec   ValkeyClusterSpec    `json:"spec"`
	Status *ValkeyClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type ValkeyClusterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata"`
	Items           []ValkeyCluster `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ValkeyCluster{}, &ValkeyClusterList{})
}
