// Package e2e holds the helpers the per-package Ginkgo suites share to test charts on the local k3d cluster.
package e2e

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
)

// NOTE: the context and registry `pnpm cluster k3d up` creates; every command is pinned to this context, so a suite
// can never write to another cluster
const (
	KubeContext = "k3d-local-cluster"
	Registry    = "local-registry:5000"
)

// RunSuite runs the package's specs with the shared Eventually defaults
func RunSuite(t *testing.T, description string) {
	gomega.RegisterFailHandler(ginkgo.Fail)
	gomega.SetDefaultEventuallyTimeout(time.Minute)
	gomega.SetDefaultEventuallyPollingInterval(2 * time.Second)
	ginkgo.RunSpecs(t, description)
}

// ApplyServiceMonitorCRD applies the Prometheus Operator CRDs the charts' monitoring templates need, unless the cluster
// already has them, and waits for them
func ApplyServiceMonitorCRD() {
	ginkgo.GinkgoHelper()
	// NOTE: a cluster from `pnpm local:init` already has them from kube-prometheus-stack
	if _, err := Run("", "kubectl", "get", "crd", "servicemonitors.monitoring.coreos.com"); err != nil {
		_, file, _, _ := runtime.Caller(0)
		MustRun("", "kubectl", "apply", "--server-side", "-k", filepath.Dir(file))
	}
	MustRun("", "kubectl", "wait", "--for=condition=Established", "crd/servicemonitors.monitoring.coreos.com")
}

// Run runs kubectl or helm against the local k3d cluster
func Run(stdin, command string, args ...string) (string, error) {
	contextFlag := "--context"
	if command == "helm" {
		contextFlag = "--kube-context"
	}
	// G204: only the specs choose the arguments, as in the _test.go files gosec already skips
	cmd := exec.Command(command, append([]string{contextFlag, KubeContext}, args...)...) //nolint:gosec
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		// NOTE: %v, not %w: Gomega prints a wrapped *exec.ExitError as a struct dump
		return stdout.String(), fmt.Errorf("%s %s: %v\n%s", command, strings.Join(args, " "), err, stderr.String())
	}
	return stdout.String(), nil
}

func MustRun(stdin, command string, args ...string) string {
	ginkgo.GinkgoHelper()
	output, err := Run(stdin, command, args...)
	gomega.Expect(err).NotTo(gomega.HaveOccurred())
	return output
}

// InstallChart installs chartDir as release into a new namespace holding the given credentials.secret and waits for
// its hooks. After the spec or Ordered container it dumps diagnostics if anything failed, then deletes the namespace.
func InstallChart(release, chartDir string, secret, values map[string]string) string {
	ginkgo.GinkgoHelper()
	namespace := fmt.Sprintf("e2e-%s-%s", release, strings.ToLower(rand.Text()[:4]))
	MustRun("", "kubectl", "create", "namespace", namespace)
	ginkgo.DeferCleanup(func() {
		if ginkgo.CurrentSpecReport().Failed() {
			dumpDiagnostics(namespace)
		}
		MustRun("", "kubectl", "delete", "namespace", namespace, "--timeout=3m")
	})

	secretArgs := []string{"-n", namespace, "create", "secret", "generic", values["credentials.secret"]}
	for key, value := range secret {
		secretArgs = append(secretArgs, fmt.Sprintf("--from-literal=%s=%s", key, value))
	}
	MustRun("", "kubectl", secretArgs...)

	values["namespace"] = namespace
	UpgradeChart(namespace, release, chartDir, values)
	return namespace
}

// UpgradeChart installs or upgrades release in namespace from chartDir with values on top of its previous ones and
// waits for its hooks
func UpgradeChart(namespace, release, chartDir string, values map[string]string) {
	ginkgo.GinkgoHelper()
	args := []string{
		"-n", namespace, "upgrade", release, chartDir,
		"--install", "--reset-then-reuse-values", "--timeout=5m",
	}
	for key, value := range values {
		args = append(args, "--set", key+"="+value)
	}
	MustRun("", "helm", args...)
}

func dumpDiagnostics(namespace string) {
	for _, args := range [][]string{
		{"-n", namespace, "get", "pods,jobs,statefulsets", "-o", "wide"},
		{"-n", namespace, "get", "events", "--sort-by=.lastTimestamp"},
	} {
		output, err := Run("", "kubectl", args...)
		ginkgo.GinkgoWriter.Printf("\n$ kubectl %s\n%s%v\n", strings.Join(args, " "), output, err)
	}
	pods, _ := Run("", "kubectl", "-n", namespace, "get", "pods", "-o", "name")
	for _, pod := range strings.Fields(pods) {
		output, _ := Run("", "kubectl", "-n", namespace, "logs", pod, "--all-containers", "--prefix", "--tail=30")
		ginkgo.GinkgoWriter.Printf("\n$ kubectl logs %s\n%s", pod, output)
	}
}
