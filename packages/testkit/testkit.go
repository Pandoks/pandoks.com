// Package testkit is the shared harness for the per-package cluster test
// suites (packages/<pkg>/test). Suites run against the local k3d cluster via
// `pnpm cluster test <pkg>` — never against a remote cluster.
package testkit

import (
	"os"
	"testing"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

const Context = "k3d-local-cluster"

type Cluster struct {
	Client *kubernetes.Clientset
	Config *rest.Config
}

// Connect pins the kubeconfig context to the local k3d cluster so suites can
// never touch a remote cluster, regardless of current-context.
func Connect(t *testing.T) *Cluster {
	t.Helper()
	loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(),
		&clientcmd.ConfigOverrides{CurrentContext: Context},
	)
	raw, err := loader.RawConfig()
	if err != nil {
		t.Fatalf("load kubeconfig: %v", err)
	}
	if _, ok := raw.Contexts[Context]; !ok {
		t.Fatalf("kubeconfig has no %q context — run 'pnpm cluster k3d deps up && pnpm cluster k3d up'", Context)
	}
	config, err := loader.ClientConfig()
	if err != nil {
		t.Fatalf("build rest config: %v", err)
	}
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		t.Fatalf("build clientset: %v", err)
	}
	return &Cluster{Client: client, Config: config}
}

// Keep reports whether passing suites should leave their resources in place
// (--keep flag, exported by scripts/cluster/test.sh).
func Keep() bool {
	return os.Getenv("TEST_KEEP") == "1"
}

// Step runs an ordered scenario; a failed step aborts the whole suite because
// later scenarios depend on the state the failed one left behind.
func Step(t *testing.T, name string, fn func(t *testing.T)) {
	t.Helper()
	if !t.Run(name, fn) {
		t.Fatalf("step %q failed — aborting suite", name)
	}
}
