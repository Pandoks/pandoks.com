package v1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ValkeyPersistenceMode string

const PersistenceRDB ValkeyPersistenceMode = "rdb"
const PersistenceAOF ValkeyPersistenceMode = "aof"

// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.
type ValkeyClusterSpec struct {
	// +kubebuilder:validation:Minimum=1
	// +required
	Masters           int32                   `json:"masters"`
	ReplicasPerMaster int32                   `json:"replicasPerMaster"`
	StoragePerNode    string                  `json:"storagePerNode,omitempty"`
	Persistence       []ValkeyPersistenceMode `json:"persistence,omitempty"`
}

type ValkeyClusterStatus struct {
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
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
