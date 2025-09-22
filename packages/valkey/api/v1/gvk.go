package v1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	crscheme "sigs.k8s.io/controller-runtime/pkg/scheme"
)

var GroupVersion = schema.GroupVersion{Group: "valkey.pandoks.dev", Version: "v1"}

var SchemeBuilder = &crscheme.Builder{GroupVersion: GroupVersion}

var AddToScheme = SchemeBuilder.AddToScheme
