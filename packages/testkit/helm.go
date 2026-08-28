package testkit

import (
	"fmt"
	"os/exec"
	"sort"
	"testing"
	"time"
)

// HelmRelease wraps the helm binary; every k8s test framework does the same —
// helm's Go SDK drags in its full dependency tree for no test-side gain.
type HelmRelease struct {
	Name      string
	Namespace string
	Chart     string
}

func (r HelmRelease) run(t *testing.T, timeout time.Duration, args []string, sets map[string]string) {
	t.Helper()
	keys := make([]string, 0, len(sets))
	for k := range sets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--set", fmt.Sprintf("%s=%s", k, sets[k]))
	}
	args = append(args, "--timeout", timeout.String())
	cmd := exec.Command("helm", args...) //nolint:gosec // args are test-controlled by design
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helm %v: %v\n%s", args, err, out)
	}
}

func (r HelmRelease) Install(t *testing.T, timeout time.Duration, sets map[string]string) {
	r.run(t, timeout, []string{"install", r.Name, r.Chart, "-n", r.Namespace}, sets)
}

// Upgrade reuses the release's existing values, mirroring incremental
// `helm upgrade --reuse-values --set k=v` operator changes.
func (r HelmRelease) Upgrade(t *testing.T, timeout time.Duration, sets map[string]string) {
	r.run(t, timeout, []string{"upgrade", r.Name, r.Chart, "-n", r.Namespace, "--reuse-values"}, sets)
}

func (r HelmRelease) Uninstall() {
	// best-effort: stale-state cleanup runs this when the release may not exist
	_ = exec.Command("helm", "uninstall", r.Name, "-n", r.Namespace).Run() //nolint:gosec // args are test-controlled by design
}
