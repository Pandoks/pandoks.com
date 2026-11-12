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

func installValkey(masterCount, replicasPerMaster int) string {
	GinkgoHelper()
	chartValues := map[string]string{
		"name":                      "vk",
		"cluster.masters":           strconv.Itoa(masterCount),
		"cluster.replicasPerMaster": strconv.Itoa(replicasPerMaster),
		"credentials.secret":        "valkey-creds",
		// NOTE: keep the hook Jobs for the diagnostics dump, and don't let retries hide a failure
		"hooks.hookDeletePolicy": "before-hook-creation",
		"hooks.restartPolicy":    "Never",
		"hooks.backoffLimit":     "0",
	}
	if valkeyImage != "" {
		chartValues["image"] = valkeyImage
	}
	if valkeyReconcilerImage != "" {
		chartValues["cluster.reconcilerImage"] = valkeyReconcilerImage
	}
	return e2e.InstallChart("valkey", valkeyChartDirectory,
		map[string]string{"ADMIN_PASSWORD": adminPassword, "CLIENT_PASSWORD": "client-test-password"},
		chartValues)
}

func valkeyCli(namespace, podName, stdin string, cliArguments ...string) (string, error) {
	return valkeyCliAs(namespace, podName, adminPassword, stdin, cliArguments...)
}

func valkeyCliAs(namespace, podName, password, stdin string, cliArguments ...string) (string, error) {
	return e2e.Run(stdin, "kubectl", append([]string{
		"-n", namespace, "exec", "-i", podName, "-c", "valkey", "--",
		"valkey-cli", "--user", "admin", "-a", password, "--no-auth-warning",
	}, cliArguments...)...)
}

func podNames(namespace string) []string {
	GinkgoHelper()
	return strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "app=valkey-vk", "-o", "jsonpath={.items[*].metadata.name}"))
}

func expectReplicasSynced(g Gomega, namespace string, replicaCount int) {
	syncedReplicaCount, replicaKeyCount := 0, 0
	for _, podName := range podNames(namespace) {
		replicationInfo, err := valkeyCli(namespace, podName, "", "info", "replication")
		g.Expect(err).NotTo(HaveOccurred())
		if !strings.Contains(replicationInfo, "role:slave") {
			continue
		}
		g.Expect(replicationInfo).To(ContainSubstring("master_link_status:up"), podName)
		dbsizeOutput, err := valkeyCli(namespace, podName, "", "dbsize")
		g.Expect(err).NotTo(HaveOccurred())
		podKeyCount, err := strconv.Atoi(strings.TrimSpace(dbsizeOutput))
		g.Expect(err).NotTo(HaveOccurred())
		syncedReplicaCount++
		replicaKeyCount += podKeyCount
	}
	g.Expect(syncedReplicaCount).To(Equal(replicaCount))
	g.Expect(replicaKeyCount).To(Equal(keyCount), "the replicas don't hold every key")
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
			namespace = installValkey(4, 0)
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

	Context("replication", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkey(3, 1)
		})

		It("syncs every replica with its master", func() {
			Eventually(expectHealthyCluster).WithArguments(namespace, 3).Should(Succeed())
			writeKeys(namespace)
			Eventually(expectReplicasSynced).WithArguments(namespace, 3).Should(Succeed())
		})

		It("applies parameters to the running nodes without restarting them", func() {
			podUIDsQuery := []string{"-n", namespace, "get", "pods", "-l", "app=valkey-vk", "-o", "jsonpath={.items[*].metadata.uid}"}
			podUIDs := e2e.MustRun("", "kubectl", podUIDsQuery...)
			// NOTE: no-failover and the sync delay set up the next spec
			e2e.UpgradeChart(namespace, "valkey", valkeyChartDirectory, map[string]string{
				"parameters.maxmemory":                   "200mb",
				"parameters.cluster-replica-no-failover": "yes",
				"parameters.repl-diskless-sync-delay":    "30",
			})
			for _, podName := range podNames(namespace) {
				maxmemory, err := valkeyCli(namespace, podName, "", "config", "get", "maxmemory")
				Expect(err).NotTo(HaveOccurred())
				Expect(maxmemory).To(Equal("maxmemory\n209715200\n"), podName)
			}
			Expect(e2e.MustRun("", "kubectl", podUIDsQuery...)).To(Equal(podUIDs))
		})

		It("scales down right after a failover, while the demoted master resyncs", func() {
			masterNodeID, err := valkeyCli(namespace, "valkey-vk-0", "", "cluster", "myid")
			Expect(err).NotTo(HaveOccurred())
			replicaNodes, err := valkeyCli(namespace, "valkey-vk-0", "", "cluster", "replicas", strings.TrimSpace(masterNodeID))
			Expect(err).NotTo(HaveOccurred())
			replicaPodName := regexp.MustCompile(`,(valkey-vk-\d+)\.`).FindStringSubmatch(replicaNodes)[1]
			Expect(valkeyCli(namespace, replicaPodName, "", "cluster", "failover")).To(Equal("OK\n"))
			Eventually(valkeyCli).WithArguments(namespace, "valkey-vk-0", "", "info", "replication").Should(ContainSubstring("role:slave"))

			// NOTE: the sync delay keeps the restarted replica resyncing while scale-down runs
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", "valkey-vk-0")
			e2e.UpgradeChart(namespace, "valkey", valkeyChartDirectory, map[string]string{"cluster.replicasPerMaster": "0"})
			Eventually(expectHealthyCluster).WithArguments(namespace, 3).Should(Succeed())
			expectKeysReadable(Default, namespace, "valkey-vk-0")
		})

		const newAdminPassword = "admin-test-password-2"

		It("leaves a recreated applied Secret empty while the nodes reject the admin password", func() {
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "secret", "valkey-vk-applied")
			e2e.MustRun("", "kubectl", "-n", namespace, "patch", "secret", "valkey-creds", "--type=merge",
				"-p", fmt.Sprintf(`{"stringData":{"ADMIN_PASSWORD":%q}}`, newAdminPassword))
			upgradeOutput, err := e2e.Run("", "helm", "-n", namespace, "upgrade", "valkey", valkeyChartDirectory,
				"--reset-then-reuse-values", "--timeout=5m")
			Expect(err).To(HaveOccurred())
			Expect(upgradeOutput + err.Error()).To(ContainSubstring("accepts neither the admin password"))
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "get", "secret", "valkey-vk-applied", "-o", "jsonpath={.data}")).To(BeEmpty())

			// NOTE: the recovery the README gives, which the next spec's rotation starts from
			e2e.MustRun("", "kubectl", "-n", namespace, "patch", "secret", "valkey-vk-applied", "--type=merge",
				"-p", fmt.Sprintf(`{"stringData":{"adminPassword":%q}}`, adminPassword))
		})

		It("finishes an admin password rotation when the same upgrade has a rejected parameter", func() {
			upgradeOutput, err := e2e.Run("", "helm", "-n", namespace, "upgrade", "valkey", valkeyChartDirectory,
				"--reset-then-reuse-values", "--timeout=5m", "--set", "parameters.maxmemory=lots")
			Expect(err).To(HaveOccurred())
			// NOTE: Helm prints the failed apply-config Job's logs before deleting it
			Expect(upgradeOutput + err.Error()).To(ContainSubstring("argument must be a memory value"))

			for _, podName := range podNames(namespace) {
				// NOTE: valkey-cli goes on unauthenticated after a rejected -a
				Expect(valkeyCliAs(namespace, podName, adminPassword, "", "ping")).To(HavePrefix("NOAUTH"), podName)
				Expect(valkeyCliAs(namespace, podName, newAdminPassword, "", "ping")).To(Equal("PONG\n"), podName)
			}
		})
	})
})
