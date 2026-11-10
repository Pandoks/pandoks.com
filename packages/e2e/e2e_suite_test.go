package e2e_test

import (
	"bytes"
	"fmt"
	"math/rand/v2"
	"os/exec"
	"strings"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

// NOTE: the context and registry `pnpm cluster k3d up` creates; never point the suite at another cluster
const (
	kubeContext = "k3d-local-cluster"
	registry    = "local-registry:5000"
)

func TestE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	SetDefaultEventuallyTimeout(time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)
	RunSpecs(t, "Charts e2e")
}

var _ = SynchronizedBeforeSuite(func() {
	// NOTE: a cluster from `pnpm local:init` already has them from kube-prometheus-stack
	if _, err := run("", "kubectl", "get", "crd", "servicemonitors.monitoring.coreos.com"); err != nil {
		mustRun("", "kubectl", "apply", "--server-side", "-k", ".")
	}
	mustRun("", "kubectl", "apply", "-f", "../../k3s/base/core/valkey.yaml")
	mustRun("", "kubectl", "wait", "--for=condition=Established", "crd/servicemonitors.monitoring.coreos.com")
}, func() {})

func run(stdin, command string, args ...string) (string, error) {
	contextFlag := "--context"
	if command == "helm" {
		contextFlag = "--kube-context"
	}
	cmd := exec.Command(command, append([]string{contextFlag, kubeContext}, args...)...)
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		// NOTE: %v, not %w: Gomega prints a wrapped *exec.ExitError as a struct dump
		return stdout.String(), fmt.Errorf("%s %s: %v\n%s", command, strings.Join(args, " "), err, stderr.String())
	}
	return stdout.String(), nil
}

func mustRun(stdin, command string, args ...string) string {
	GinkgoHelper()
	output, err := run(stdin, command, args...)
	Expect(err).NotTo(HaveOccurred())
	return output
}

// installChart installs packages/<chart>/chart into a new namespace holding the given credentials.secret and waits
// for its hooks. After the spec or Ordered container it dumps diagnostics if anything failed, then deletes the namespace.
func installChart(chart string, secret, values map[string]string) string {
	GinkgoHelper()
	namespace := fmt.Sprintf("e2e-%s-%04x", chart, rand.IntN(0x10000))
	mustRun("", "kubectl", "create", "namespace", namespace)
	DeferCleanup(func() {
		if CurrentSpecReport().Failed() {
			dumpDiagnostics(namespace)
		}
		mustRun("", "kubectl", "delete", "namespace", namespace, "--timeout=3m")
	})

	secretArgs := []string{"-n", namespace, "create", "secret", "generic", values["credentials.secret"]}
	for key, value := range secret {
		secretArgs = append(secretArgs, fmt.Sprintf("--from-literal=%s=%s", key, value))
	}
	mustRun("", "kubectl", secretArgs...)

	values["namespace"] = namespace
	upgradeChart(namespace, chart, values)
	return namespace
}

// upgradeChart installs or upgrades the chart's release in namespace with values on top of its previous ones and
// waits for its hooks
func upgradeChart(namespace, chart string, values map[string]string) {
	GinkgoHelper()
	args := []string{
		"-n", namespace, "upgrade", chart, "../" + chart + "/chart",
		"--install", "--reset-then-reuse-values", "--timeout=5m",
	}
	for key, value := range values {
		args = append(args, "--set", key+"="+value)
	}
	mustRun("", "helm", args...)
}

func dumpDiagnostics(namespace string) {
	for _, args := range [][]string{
		{"-n", namespace, "get", "pods,jobs,statefulsets", "-o", "wide"},
		{"-n", namespace, "get", "events", "--sort-by=.lastTimestamp"},
	} {
		output, err := run("", "kubectl", args...)
		GinkgoWriter.Printf("\n$ kubectl %s\n%s%v\n", strings.Join(args, " "), output, err)
	}
	pods, _ := run("", "kubectl", "-n", namespace, "get", "pods", "-o", "name")
	for _, pod := range strings.Fields(pods) {
		output, _ := run("", "kubectl", "-n", namespace, "logs", pod, "--all-containers", "--prefix", "--tail=30")
		GinkgoWriter.Printf("\n$ kubectl logs %s\n%s", pod, output)
	}
}
