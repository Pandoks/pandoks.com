// +kubebuilder:object:generate=true
// +groupName=valkey.pandoks.com
package v1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

// GroupVersion is the group version used in the kube yamls
var GroupVersion = schema.GroupVersion{Group: "valkey.pandoks.com", Version: "v1"}

// SchemeBuilder is used to add go types to the GroupVersionKind scheme
var SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

// AddToScheme adds the types in this group-version to the given scheme.
var AddToScheme = SchemeBuilder.AddToScheme
