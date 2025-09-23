package v1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrlscheme "sigs.k8s.io/controller-runtime/pkg/scheme"
)

var GroupVersion = schema.GroupVersion{Group: "valkey", Version: "v1"}

var SchemeBuilder = &ctrlscheme.Builder{GroupVersion: GroupVersion}

var AddToScheme = SchemeBuilder.AddToScheme
