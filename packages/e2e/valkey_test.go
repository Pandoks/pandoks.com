package e2e

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

const (
	valkeyPassword = "admin-test-password"
	keyCount       = 1000
)

func installValkey(masters int) string {
	GinkgoHelper()
	return installChart("valkey",
		map[string]string{"ADMIN_PASSWORD": valkeyPassword, "CLIENT_PASSWORD": "client-test-password"},
		map[string]string{
			"name":                    "vk",
			"image":                   registry + "/valkey:latest",
			"cluster.reconcilerImage": registry + "/valkey-reconciler:latest",
			"cluster.masters":         strconv.Itoa(masters),
			"credentials.secret":      "valkey-creds",
			// NOTE: fail on the first hook error and keep the hook Jobs for the diagnostics dump
			"hooks.restartPolicy":    "Never",
			"hooks.backoffLimit":     "0",
			"hooks.hookDeletePolicy": "before-hook-creation",
		})
}

func valkeyCli(namespace, pod, stdin string, args ...string) (string, error) {
	return run(stdin, "kubectl", append([]string{
		"-n", namespace, "exec", "-i", pod, "-c", "valkey", "--",
		"valkey-cli", "--user", "admin", "-a", valkeyPassword, "--no-auth-warning",
	}, args...)...)
}

func writeKeys(namespace string) {
	GinkgoHelper()
	var commands strings.Builder
	for i := range keyCount {
		fmt.Fprintf(&commands, "SET key:%d %d\n", i, i)
	}
	output, err := valkeyCli(namespace, "valkey-vk-0", commands.String(), "-c")
	Expect(err).NotTo(HaveOccurred())
	Expect(strings.Count(output, "OK\n")).To(Equal(keyCount), "not every SET returned OK")
}

// expectKeysReadable reads every key through the cluster from the given pod
func expectKeysReadable(g Gomega, namespace, pod string) {
	var commands, expected strings.Builder
	for i := range keyCount {
		fmt.Fprintf(&commands, "GET key:%d\n", i)
		fmt.Fprintf(&expected, "%d\n", i)
	}
	output, err := valkeyCli(namespace, pod, commands.String(), "-c")
	g.Expect(err).NotTo(HaveOccurred())
	values := regexp.MustCompile(`(?m)^-> Redirected.*\n`).ReplaceAllString(output, "")
	g.Expect(values).To(Equal(expected.String()), "not every key:N returned N")
}

var masterLine = regexp.MustCompile(`(?m)^\S+ \(\w+\.\.\.\) -> (\d+) keys \| (\d+) slots`)

// expectHealthyCluster checks that every master serves, slot coverage, open slots, master count, and that slots are
// spread over every master
func expectHealthyCluster(g Gomega, namespace string, masters int) {
	// NOTE: `--cluster create` returns before the nodes reach cluster_state:ok, and until then writes get CLUSTERDOWN
	for i := range masters {
		info, err := valkeyCli(namespace, fmt.Sprintf("valkey-vk-%d", i), "", "cluster", "info")
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(info).To(ContainSubstring("cluster_state:ok"))
	}
	address := fmt.Sprintf("valkey-vk-0.valkey-vk-headless.%s.svc.cluster.local:6379", namespace)
	// NOTE: --cluster check exits 1 on open slots; its output says why, so assert on that instead of the exit code
	output, _ := valkeyCli(namespace, "valkey-vk-0", "", "--cluster", "check", address)
	g.Expect(output).To(ContainSubstring("[OK] All 16384 slots covered."))
	g.Expect(output).To(ContainSubstring("[OK] All nodes agree about slots configuration."))
	g.Expect(output).NotTo(ContainSubstring("[WARNING]"))
	slotsPerMaster := []int{}
	for _, match := range masterLine.FindAllStringSubmatch(output, -1) {
		slots, _ := strconv.Atoi(match[2])
		slotsPerMaster = append(slotsPerMaster, slots)
	}
	g.Expect(slotsPerMaster).To(HaveLen(masters))
	g.Expect(slotsPerMaster).To(HaveEach(BeNumerically(">=", 16384/masters/2)), "slots are not spread over every master")
}

var _ = Describe("Valkey", Label("valkey"), func() {
	Context("reconciler scale down", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkey(4)
		})

		It("forms a cluster with every slot spread over 4 masters", func() {
			Eventually(expectHealthyCluster).WithArguments(namespace, 4).Should(Succeed())
		})

		It("serves every key written through the cluster", func() {
			writeKeys(namespace)
			expectKeysReadable(Default, namespace, "valkey-vk-0")
		})

		It("scales down to 3 masters with the pre-upgrade hook and keeps every key", func() {
			upgradeChart(namespace, "valkey", map[string]string{"cluster.masters": "3"})
			mustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/valkey-vk", "--timeout=2m")
			Eventually(expectHealthyCluster).WithArguments(namespace, 3).Should(Succeed())
			expectKeysReadable(Default, namespace, "valkey-vk-0")
		})
	})
})
