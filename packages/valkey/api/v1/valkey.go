package v1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ValkeyClusterSpec struct {
	Masters           int32 `json:"masters"`
	ReplicasPerMaster int32 `json:"replicasPerMaster"`
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
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ValkeyClusterSpec   `json:"spec,omitempty"`
	Status ValkeyClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type ValkeyClusterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ValkeyCluster `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ValkeyCluster{}, &ValkeyClusterList{})
}
