package valkey_test

import (
	"e2e"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

const (
	valkeyChartDirectory = "../chart"
	adminPassword        = "admin-test-password"
	keyCount             = 1000
)

func installValkey(masterCount int) string {
	GinkgoHelper()
	chartValues := map[string]string{
		"name":               "vk",
		"cluster.masters":    strconv.Itoa(masterCount),
		"credentials.secret": "valkey-creds",
		// NOTE: keep the hook Jobs for the diagnostics dump
		"hooks.hookDeletePolicy": "before-hook-creation",
	}
	if valkeyImage != "" {
		chartValues["image"] = valkeyImage
	}
	if valkeyReconcilerImage != "" {
		chartValues["cluster.valkeyReconcilerImage"] = valkeyReconcilerImage
	}
	return e2e.InstallChart("valkey", valkeyChartDirectory,
		map[string]string{"ADMIN_PASSWORD": adminPassword, "CLIENT_PASSWORD": "client-test-password"},
		chartValues)
}

func valkeyCli(namespace, podName, stdin string, cliArguments ...string) (string, error) {
	return e2e.Run(stdin, "kubectl", append([]string{
		"-n", namespace, "exec", "-i", podName, "-c", "valkey", "--",
		"valkey-cli", "--user", "admin", "-a", adminPassword, "--no-auth-warning",
	}, cliArguments...)...)
}

func writeKeys(namespace string) {
	GinkgoHelper()
	var setCommands strings.Builder
	for keyIndex := range keyCount {
		fmt.Fprintf(&setCommands, "SET key:%d %d\n", keyIndex, keyIndex)
	}
	output, err := valkeyCli(namespace, "valkey-vk-0", setCommands.String(), "-c")
	Expect(err).NotTo(HaveOccurred())
	Expect(strings.Count(output, "OK\n")).To(Equal(keyCount), "not every SET returned OK")
}

func expectKeysReadable(g Gomega, namespace, podName string) {
	var getCommands, expectedValues strings.Builder
	for keyIndex := range keyCount {
		fmt.Fprintf(&getCommands, "GET key:%d\n", keyIndex)
		fmt.Fprintf(&expectedValues, "%d\n", keyIndex)
	}
	output, err := valkeyCli(namespace, podName, getCommands.String(), "-c")
	g.Expect(err).NotTo(HaveOccurred())
	returnedValues := regexp.MustCompile(`(?m)^-> Redirected.*\n`).ReplaceAllString(output, "")
	g.Expect(returnedValues).To(Equal(expectedValues.String()), "not every key:N returned N")
}

var clusterCheckMasterLine = regexp.MustCompile(`(?m)^\S+ \(\w+\.\.\.\) -> (\d+) keys \| (\d+) slots`)

func expectHealthyCluster(g Gomega, namespace string, masterCount int) {
	statefulSetReplicas, err := e2e.Run("", "kubectl", "-n", namespace, "get", "statefulset", "valkey-vk", "-o", "jsonpath={.spec.replicas}")
	g.Expect(err).NotTo(HaveOccurred())
	podCount, err := strconv.Atoi(statefulSetReplicas)
	g.Expect(err).NotTo(HaveOccurred())
	// NOTE: `--cluster create` returns before the nodes reach cluster_state:ok, and until then writes get CLUSTERDOWN
	for podIndex := range podCount {
		clusterInfo, err := valkeyCli(namespace, fmt.Sprintf("valkey-vk-%d", podIndex), "", "cluster", "info")
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(clusterInfo).To(ContainSubstring("cluster_state:ok"))
	}
	seedNodeAddress := fmt.Sprintf("valkey-vk-0.valkey-vk-headless.%s.svc.cluster.local:6379", namespace)
	// NOTE: --cluster check exits 1 on open slots; its output says why, so assert on that instead of the exit code
	clusterCheckOutput, err := valkeyCli(namespace, "valkey-vk-0", "", "--cluster", "check", seedNodeAddress)
	g.Expect(clusterCheckOutput).To(ContainSubstring("[OK] All 16384 slots covered."), "%v", err)
	g.Expect(clusterCheckOutput).To(ContainSubstring("[OK] All nodes agree about slots configuration."))
	g.Expect(clusterCheckOutput).NotTo(ContainSubstring("[WARNING]"))
	slotsPerMaster := []int{}
	for _, masterLineMatch := range clusterCheckMasterLine.FindAllStringSubmatch(clusterCheckOutput, -1) {
		masterSlotCount, _ := strconv.Atoi(masterLineMatch[2])
		slotsPerMaster = append(slotsPerMaster, masterSlotCount)
	}
	g.Expect(slotsPerMaster).To(HaveLen(masterCount))
	g.Expect(slotsPerMaster).To(HaveEach(BeNumerically(">=", 16384/masterCount/2)), "slots are not spread over every master")
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
			e2e.UpgradeChart(namespace, "valkey", valkeyChartDirectory, map[string]string{"cluster.masters": "3"})
			Eventually(expectHealthyCluster).WithArguments(namespace, 3).Should(Succeed())
			expectKeysReadable(Default, namespace, "valkey-vk-0")
		})
	})
})
