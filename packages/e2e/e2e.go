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

// NOTE: every command is pinned to this context, so a suite can't write to another cluster
const KubeContext = "k3d-local-cluster"

func RunSuite(t *testing.T, suiteDescription string) {
	gomega.RegisterFailHandler(ginkgo.Fail)
	gomega.SetDefaultEventuallyTimeout(time.Minute)
	gomega.SetDefaultEventuallyPollingInterval(2 * time.Second)
	ginkgo.RunSpecs(t, suiteDescription)
}

func ApplyServiceMonitorCRD() {
	ginkgo.GinkgoHelper()
	// NOTE: kube-prometheus-stack already installs them on a `pnpm local:init` cluster
	if _, err := Run("", "kubectl", "get", "crd", "servicemonitors.monitoring.coreos.com"); err != nil {
		_, currentFile, _, _ := runtime.Caller(0)
		MustRun("", "kubectl", "apply", "--server-side", "-k", filepath.Dir(currentFile))
	}
	MustRun("", "kubectl", "wait", "--for=condition=Established", "crd/servicemonitors.monitoring.coreos.com")
}

func Run(stdin, executable string, arguments ...string) (string, error) {
	contextFlag := "--context"
	if executable == "helm" {
		contextFlag = "--kube-context"
	}
	// G204: only the specs choose the arguments, as in the _test.go files gosec already skips
	command := exec.Command(executable, append([]string{contextFlag, KubeContext}, arguments...)...) //nolint:gosec
	command.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		// NOTE: %v, not %w: Gomega prints a wrapped *exec.ExitError as a struct dump
		return stdout.String(), fmt.Errorf("%s %s: %v\n%s", executable, strings.Join(arguments, " "), err, stderr.String())
	}
	return stdout.String(), nil
}

func MustRun(stdin, executable string, arguments ...string) string {
	ginkgo.GinkgoHelper()
	output, err := Run(stdin, executable, arguments...)
	gomega.Expect(err).NotTo(gomega.HaveOccurred())
	return output
}

func InstallChart(releaseName, chartDirectory string, secretData, chartValues map[string]string) string {
	ginkgo.GinkgoHelper()
	namespace := fmt.Sprintf("e2e-%s-%s", releaseName, strings.ToLower(rand.Text()[:4]))
	MustRun("", "kubectl", "create", "namespace", namespace)
	ginkgo.DeferCleanup(func() {
		if ginkgo.CurrentSpecReport().Failed() {
			dumpDiagnostics(namespace)
		}
		MustRun("", "kubectl", "delete", "namespace", namespace, "--timeout=3m")
	})

	secretArguments := []string{"-n", namespace, "create", "secret", "generic", chartValues["credentials.secret"]}
	for secretKey, secretValue := range secretData {
		secretArguments = append(secretArguments, fmt.Sprintf("--from-literal=%s=%s", secretKey, secretValue))
	}
	MustRun("", "kubectl", secretArguments...)

	chartValues["namespace"] = namespace
	UpgradeChart(namespace, releaseName, chartDirectory, chartValues)
	return namespace
}

func UpgradeChart(namespace, releaseName, chartDirectory string, chartValues map[string]string) {
	ginkgo.GinkgoHelper()
	helmArguments := []string{
		"-n", namespace, "upgrade", releaseName, chartDirectory,
		"--install", "--reset-then-reuse-values", "--timeout=5m",
	}
	for valueKey, value := range chartValues {
		helmArguments = append(helmArguments, "--set", valueKey+"="+value)
	}
	MustRun("", "helm", helmArguments...)
}

func dumpDiagnostics(namespace string) {
	for _, kubectlArguments := range [][]string{
		{"-n", namespace, "get", "pods,jobs,statefulsets", "-o", "wide"},
		{"-n", namespace, "get", "events", "--sort-by=.lastTimestamp"},
	} {
		output, err := Run("", "kubectl", kubectlArguments...)
		ginkgo.GinkgoWriter.Printf("\n$ kubectl %s\n%s%v\n", strings.Join(kubectlArguments, " "), output, err)
	}
	podNames, _ := Run("", "kubectl", "-n", namespace, "get", "pods", "-o", "name")
	for _, podName := range strings.Fields(podNames) {
		podLogs, _ := Run("", "kubectl", "-n", namespace, "logs", podName, "--all-containers", "--prefix", "--tail=30")
		ginkgo.GinkgoWriter.Printf("\n$ kubectl logs %s\n%s", podName, podLogs)
	}
}
