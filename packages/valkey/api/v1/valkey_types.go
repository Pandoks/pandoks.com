package v1

import (
	"fmt"

	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ValkeyPersistenceMode string

const PersistenceRDB ValkeyPersistenceMode = "rdb"
const PersistenceAOF ValkeyPersistenceMode = "aof"
const PersistenceNA ValkeyPersistenceMode = ""

type PersistenceSpec struct {
	Modes          []ValkeyPersistenceMode `json:"modes"`
	StoragePerNode resource.Quantity       `json:"storagePerNode"`
}

// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.
type ValkeyClusterSpec struct {
	// Maximum of 255 masters becuase index is uint8.
	// 0..254 are reserved for master indeces and 255 is reserved for unassigned during reconciliation.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=255
	// +kubebuilder:validation:Required
	Masters           int32 `json:"masters"`
	ReplicasPerMaster int32 `json:"replicasPerMaster"`
	// +optional
	Persistence PersistenceSpec `json:"persistence"`
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

	Spec ValkeyClusterSpec `json:"spec"`
	// +optional
	Status ValkeyClusterStatus `json:"status"`
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

func (v *ValkeyCluster) StatefulSetName() string {
	return fmt.Sprintf("%s-valkey", v.Name)
}

func (v *ValkeyCluster) HeadlessServiceName() string {
	return fmt.Sprintf("%s-headless-valkey", v.Name)
}

func (v *ValkeyCluster) MasterServiceName() string {
	return fmt.Sprintf("%s-master-valkey", v.Name)
}

func (v *ValkeyCluster) SlaveServiceName() string {
	return fmt.Sprintf("%s-slave-valkey", v.Name)
}

func (v *ValkeyCluster) Labels() map[string]string {
	return map[string]string{
		"app":     "valkey",
		"cluster": v.Name,
	}
}
