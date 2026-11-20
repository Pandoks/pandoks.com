package valkey_test

import (
	"e2e"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

const (
	valkeyChartDirectory = "../chart"
	adminPassword        = "admin-test-password"
	clientPassword       = "client-test-password"
	newAdminPassword     = "admin-test-password-2"
	keyCount             = 1000
	// NOTE: the parameters default
	clusterNodeTimeout = 5 * time.Second
)

// imageValues sets the images the suite's flags give, and otherwise leaves the chart's defaults.
func imageValues() map[string]string {
	chartValues := map[string]string{}
	if valkeyImage != "" {
		chartValues["image"] = valkeyImage
	}
	if valkeyReconcilerImage != "" {
		chartValues["cluster.reconcilerImage"] = valkeyReconcilerImage
	}
	return chartValues
}

func installChart(chartDirectory string, masterCount, replicasPerMaster int, chartImages map[string]string) string {
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
		// NOTE: every context's pods fit on the 6 k3d nodes at once
		"resources.requests.cpu":    "100m",
		"resources.requests.memory": "128Mi",
	}
	for valueKey, value := range chartImages {
		chartValues[valueKey] = value
	}
	return e2e.InstallChart("valkey", chartDirectory,
		map[string]string{"ADMIN_PASSWORD": adminPassword, "CLIENT_PASSWORD": clientPassword},
		chartValues)
}

func installValkey(masterCount, replicasPerMaster int) string {
	GinkgoHelper()
	return installChart(valkeyChartDirectory, masterCount, replicasPerMaster, imageValues())
}

// installValkeyWithKeys installs the chart and waits for a healthy cluster holding every key, synced to every replica.
func installValkeyWithKeys(masterCount, replicasPerMaster int) string {
	GinkgoHelper()
	namespace := installValkey(masterCount, replicasPerMaster)
	Eventually(expectHealthyCluster).WithArguments(namespace, masterCount, replicasPerMaster).Should(Succeed())
	writeKeys(namespace)
	Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
	return namespace
}

func upgradeValkey(namespace string, chartValues map[string]string) {
	GinkgoHelper()
	e2e.UpgradeChart(namespace, "valkey", valkeyChartDirectory, chartValues)
}

func valkeyCli(namespace, podName, stdin string, cliArguments ...string) (string, error) {
	return valkeyCliAs(namespace, podName, "admin", adminPassword, stdin, cliArguments...)
}

func valkeyCliAs(namespace, podName, user, password, stdin string, cliArguments ...string) (string, error) {
	return e2e.Run(stdin, "kubectl", append([]string{
		"-n", namespace, "exec", "-i", podName, "-c", "valkey", "--",
		"valkey-cli", "--user", user, "-a", password, "--no-auth-warning",
	}, cliArguments...)...)
}

func valkeyCliUnauthenticated(namespace, podName string, cliArguments ...string) (string, error) {
	return e2e.Run("", "kubectl", append([]string{"-n", namespace, "exec", podName, "-c", "valkey", "--", "valkey-cli"}, cliArguments...)...)
}

func podNames(namespace string) []string {
	GinkgoHelper()
	return strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "app=valkey-vk", "-o", "jsonpath={.items[*].metadata.name}"))
}

func podUIDs(namespace string) []string {
	GinkgoHelper()
	return strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "app=valkey-vk", "-o", "jsonpath={.items[*].metadata.uid}"))
}

func expectConfigOnEveryPod(namespace, parameter, value string) {
	GinkgoHelper()
	for _, podName := range podNames(namespace) {
		Expect(valkeyCli(namespace, podName, "", "config", "get", parameter)).To(Equal(parameter+"\n"+value+"\n"), podName)
	}
}

// clusterNode is a line of CLUSTER NODES.
type clusterNode struct {
	id, podName, masterID string
	flags, slots          []string
}

func (node clusterNode) isMaster() bool { return slices.Contains(node.flags, "master") }

func (node clusterNode) servesSlot(slot int) bool {
	for _, slotRange := range node.slots {
		firstSlot, lastSlot, isRange := strings.Cut(slotRange, "-")
		if !isRange {
			lastSlot = firstSlot
		}
		first, firstErr := strconv.Atoi(firstSlot)
		last, lastErr := strconv.Atoi(lastSlot)
		// NOTE: an open slot, like [5-<-id], doesn't parse
		if firstErr == nil && lastErr == nil && first <= slot && slot <= last {
			return true
		}
	}
	return false
}

func clusterNodes(namespace, podName string) ([]clusterNode, error) {
	output, err := valkeyCli(namespace, podName, "", "cluster", "nodes")
	if err != nil {
		return nil, err
	}
	var nodes []clusterNode
	for line := range strings.Lines(strings.TrimSpace(output)) {
		fields := strings.Fields(line)
		if len(fields) < 8 {
			return nil, fmt.Errorf("%s: unexpected CLUSTER NODES line %q", podName, line)
		}
		// NOTE: the address is ip:port@bus-port,hostname
		_, hostname, _ := strings.Cut(fields[1], ",")
		nodePodName, _, _ := strings.Cut(hostname, ".")
		nodes = append(nodes, clusterNode{
			id: fields[0], podName: nodePodName, masterID: fields[3],
			flags: strings.Split(fields[2], ","), slots: fields[8:],
		})
	}
	return nodes, nil
}

func nodeByID(nodes []clusterNode, nodeID string) (clusterNode, bool) {
	for _, node := range nodes {
		if node.id == nodeID {
			return node, true
		}
	}
	return clusterNode{}, false
}

// shardOfKey returns the pods of the master serving key and of its first replica.
func shardOfKey(namespace, key string) (masterPodName, replicaPodName string) {
	GinkgoHelper()
	slotOutput, err := valkeyCli(namespace, "valkey-vk-0", "", "cluster", "keyslot", key)
	Expect(err).NotTo(HaveOccurred())
	slot, err := strconv.Atoi(strings.TrimSpace(slotOutput))
	Expect(err).NotTo(HaveOccurred())
	nodes, err := clusterNodes(namespace, "valkey-vk-0")
	Expect(err).NotTo(HaveOccurred())
	for _, master := range nodes {
		if !master.isMaster() || !master.servesSlot(slot) {
			continue
		}
		for _, replica := range nodes {
			if replica.masterID == master.id {
				return master.podName, replica.podName
			}
		}
	}
	Fail(fmt.Sprintf("no master with a replica serves slot %d: %+v", slot, nodes))
	return "", ""
}

var clusterCheckMasterLine = regexp.MustCompile(`(?m)^\S+ \(\w+\.\.\.\) -> (\d+) keys \| (\d+) slots`)

// expectHealthyCluster checks every pod of the StatefulSet is in the cluster, with cluster_state:ok, no failed,
// handshake or open-slot entries in any node's view, and replicasPerMaster replicas for each of masterCount masters
// that spread every slot.
func expectHealthyCluster(g Gomega, namespace string, masterCount, replicasPerMaster int) {
	podCount := masterCount * (1 + replicasPerMaster)
	statefulSetReplicas, err := e2e.Run("", "kubectl", "-n", namespace, "get", "statefulset", "valkey-vk", "-o", "jsonpath={.spec.replicas}")
	g.Expect(err).NotTo(HaveOccurred())
	g.Expect(statefulSetReplicas).To(Equal(strconv.Itoa(podCount)))
	for podIndex := range podCount {
		podName := fmt.Sprintf("valkey-vk-%d", podIndex)
		// NOTE: `--cluster create` returns before the nodes reach cluster_state:ok, and until then writes get CLUSTERDOWN
		clusterInfo, err := valkeyCli(namespace, podName, "", "cluster", "info")
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(clusterInfo).To(ContainSubstring("cluster_state:ok"), podName)

		nodes, err := clusterNodes(namespace, podName)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(nodes).To(HaveLen(podCount), "%s's view: %+v", podName, nodes)
		replicaCounts := map[string]int{}
		for _, node := range nodes {
			g.Expect(node.flags).NotTo(ContainElement(BeElementOf("fail", "fail?", "handshake", "noaddr")), "%s's view of %s", podName, node.podName)
			// NOTE: a node lists its own importing or migrating slots, so a replica's open slot only shows here
			g.Expect(node.slots).NotTo(ContainElement(HavePrefix("[")), "%s's view of %s", podName, node.podName)
			if node.isMaster() {
				replicaCounts[node.id] += 0
			} else {
				replicaCounts[node.masterID]++
			}
		}
		g.Expect(replicaCounts).To(HaveLen(masterCount), "%s's view: %+v", podName, nodes)
		g.Expect(replicaCounts).To(HaveEach(replicasPerMaster), "%s's view: %+v", podName, nodes)
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

func waitForHealthyCluster(namespace string, masterCount, replicasPerMaster int) {
	GinkgoHelper()
	Eventually(expectHealthyCluster).WithArguments(namespace, masterCount, replicasPerMaster).WithTimeout(3 * time.Minute).Should(Succeed())
}

func dbsize(g Gomega, namespace, podName string) int {
	dbsizeOutput, err := valkeyCli(namespace, podName, "", "dbsize")
	g.Expect(err).NotTo(HaveOccurred())
	podKeyCount, err := strconv.Atoi(strings.TrimSpace(dbsizeOutput))
	g.Expect(err).NotTo(HaveOccurred())
	return podKeyCount
}

// expectReplicasSynced checks every replica's link to its master is up and it holds as many keys as its master.
func expectReplicasSynced(g Gomega, namespace string) {
	nodes, err := clusterNodes(namespace, "valkey-vk-0")
	g.Expect(err).NotTo(HaveOccurred())
	for _, replica := range nodes {
		if replica.isMaster() {
			continue
		}
		replicationInfo, err := valkeyCli(namespace, replica.podName, "", "info", "replication")
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(replicationInfo).To(ContainSubstring("master_link_status:up"), replica.podName)
		master, found := nodeByID(nodes, replica.masterID)
		g.Expect(found).To(BeTrue(), "%s's master %s isn't in the cluster", replica.podName, replica.masterID)
		g.Expect(dbsize(g, namespace, replica.podName)).To(Equal(dbsize(g, namespace, master.podName)),
			"%s doesn't hold its master %s's keys", replica.podName, master.podName)
	}
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

// expectScaledCluster checks the cluster reached its new shape with every key, synced to every replica.
func expectScaledCluster(namespace string, masterCount, replicasPerMaster int) {
	GinkgoHelper()
	waitForHealthyCluster(namespace, masterCount, replicasPerMaster)
	expectKeysReadable(Default, namespace, "valkey-vk-0")
	Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
}

// writeUntilStopped sets key through the cluster client in clientPodName, recording when each SET was acknowledged,
// until stop closes, then sends the acknowledgements and the time it stopped.
func writeUntilStopped(namespace, clientPodName, key string, stop <-chan struct{}, acknowledged chan<- []time.Time) {
	defer GinkgoRecover()
	var acknowledgedAt []time.Time
	for writeIndex := 0; ; writeIndex++ {
		select {
		case <-stop:
			acknowledged <- append(acknowledgedAt, time.Now())
			return
		default:
		}
		// NOTE: a frozen node accepts connections but never answers
		output, _ := e2e.Run("", "kubectl", "-n", namespace, "exec", clientPodName, "-c", "valkey", "--",
			"timeout", "2", "valkey-cli", "--user", "admin", "-a", adminPassword, "--no-auth-warning", "-c", "set", key, strconv.Itoa(writeIndex))
		if strings.HasSuffix(output, "OK\n") {
			acknowledgedAt = append(acknowledgedAt, time.Now())
		}
	}
}

func longestGap(times []time.Time) time.Duration {
	var gap time.Duration
	for timeIndex := 1; timeIndex < len(times); timeIndex++ {
		gap = max(gap, times[timeIndex].Sub(times[timeIndex-1]))
	}
	return gap
}

// measureWriteOutage keeps writing a key that master serves from a pod outside its shard while disrupt runs and
// the cluster heals, and returns the longest time between acknowledged writes.
func measureWriteOutage(namespace string, masterCount, replicasPerMaster int, key string, disrupt func(masterPodName, replicaPodName string)) time.Duration {
	GinkgoHelper()
	masterPodName, replicaPodName := shardOfKey(namespace, key)
	clientPodName := ""
	for _, podName := range podNames(namespace) {
		if podName != masterPodName && podName != replicaPodName {
			clientPodName = podName
		}
	}
	stop, acknowledged := make(chan struct{}), make(chan []time.Time)
	go writeUntilStopped(namespace, clientPodName, key, stop, acknowledged)
	time.Sleep(3 * time.Second)
	disrupt(masterPodName, replicaPodName)
	waitForHealthyCluster(namespace, masterCount, replicasPerMaster)
	close(stop)
	acknowledgedAt := <-acknowledged
	Expect(len(acknowledgedAt)).To(BeNumerically(">", 2), "no write was acknowledged")
	writeOutage := longestGap(acknowledgedAt)
	AddReportEntry("write outage", writeOutage.String())
	return writeOutage
}

// signalValkeyServer signals the pod's valkey-server from its k3d node, since in the pod's PID namespace it's PID 1,
// which ignores SIGSTOP.
func signalValkeyServer(namespace, podName, signal string) {
	GinkgoHelper()
	nodeName := e2e.MustRun("", "kubectl", "-n", namespace, "get", "pod", podName, "-o", "jsonpath={.spec.nodeName}")
	containerID := e2e.MustRun("", "kubectl", "-n", namespace, "get", "pod", podName,
		"-o", `jsonpath={.status.containerStatuses[?(@.name=="valkey")].containerID}`)
	output, err := exec.Command("docker", "exec", nodeName, "sh", "-c", fmt.Sprintf(
		`kill -%s "$(crictl inspect --output go-template --template '{{.info.pid}}' %s)"`,
		signal, strings.TrimPrefix(containerID, "containerd://"))).CombinedOutput()
	Expect(err).NotTo(HaveOccurred(), string(output))
}

func metricsPassword(namespace string) string {
	GinkgoHelper()
	encodedPassword := e2e.MustRun("", "kubectl", "-n", namespace, "get", "secret", "valkey-vk-metrics", "-o", "jsonpath={.data.password}")
	password, err := base64.StdEncoding.DecodeString(encodedPassword)
	Expect(err).NotTo(HaveOccurred())
	return string(password)
}

// getThroughPodProxy GETs path from the pod's port through the API server.
func getThroughPodProxy(namespace, podName, port, path string) (string, error) {
	return e2e.Run("", "kubectl", "get", "--raw", fmt.Sprintf("/api/v1/namespaces/%s/pods/%s:%s/proxy%s", namespace, podName, port, path))
}

func expectExportersUp(g Gomega, namespace, port, path string) {
	for _, podName := range podNames(namespace) {
		metrics, err := getThroughPodProxy(namespace, podName, port, path)
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(metrics).To(MatchRegexp(`(?m)^redis_up 1$`), podName)
	}
}

func expectPodsReady(g Gomega, namespace string, podCount int) {
	readyStatuses, err := e2e.Run("", "kubectl", "-n", namespace, "get", "pods", "-l", "app=valkey-vk",
		"-o", `jsonpath={range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{" "}{end}`)
	g.Expect(err).NotTo(HaveOccurred())
	g.Expect(strings.Fields(readyStatuses)).To(And(HaveLen(podCount), HaveEach("True")))
}

func podReadyStatus(namespace, podName string) (string, error) {
	return e2e.Run("", "kubectl", "-n", namespace, "get", "pod", podName, "-o", `jsonpath={.status.conditions[?(@.type=="Ready")].status}`)
}

func helmRevision(namespace string) string {
	GinkgoHelper()
	return strings.TrimSpace(e2e.MustRun("", "kubectl", "-n", namespace, "get", "secret", "-l", "owner=helm,name=valkey,status=deployed",
		"-o", "jsonpath={.items[0].metadata.labels.version}"))
}

var _ = Describe("Valkey", Label("valkey"), func() {
	DescribeTable("refuses to render parameters that apply-config can't set or would leak",
		func(parameterValues, message string) {
			_, err := e2e.Run("", "helm", "template", valkeyChartDirectory, "--set", parameterValues)
			Expect(err).To(MatchError(ContainSubstring(message)))
		},
		Entry("a setting Valkey can't change at runtime", "parameters.cluster-enabled=no", "Valkey can't change it on running nodes"),
		Entry("a secret", "parameters.requirepass=leak", "keep secrets out of parameters"),
		Entry("a setting the chart sets", "parameters.primaryauth=leak", "the chart sets it"),
		Entry("an alias of a default", "parameters.slave-read-only=no", "parameters.replica-read-only sets the same setting"),
		Entry("two casings of one key", "parameters.MAXMEMORY=1mb,parameters.maxmemory=1mb", "sets the same setting"),
	)

	Context("a 3 × 1 cluster's topology, access and metrics", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkey(3, 1)
		})

		It("covers every slot with one synced replica per master", func() {
			waitForHealthyCluster(namespace, 3, 1)
			writeKeys(namespace)
			Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
		})

		It("finishes a rerun of init on the initialized cluster", func() {
			hooks := e2e.MustRun("", "helm", "-n", namespace, "get", "hooks", "valkey")
			initJobIndex := slices.IndexFunc(strings.Split(hooks, "\n---\n"), func(manifest string) bool {
				return strings.Contains(manifest, "name: valkey-vk-init\n")
			})
			Expect(initJobIndex).NotTo(Equal(-1), "no init Job in the release's hooks")
			initJob := strings.Replace(strings.Split(hooks, "\n---\n")[initJobIndex], "name: valkey-vk-init\n", "name: valkey-vk-init-rerun\n", 1)
			e2e.MustRun(initJob, "kubectl", "-n", namespace, "apply", "-f", "-")

			jobConditions := func() (string, error) {
				return e2e.Run("", "kubectl", "-n", namespace, "get", "job", "valkey-vk-init-rerun",
					"-o", `jsonpath={.status.conditions[?(@.status=="True")].type}`)
			}
			Eventually(jobConditions).WithTimeout(3 * time.Minute).Should(Or(ContainSubstring("Complete"), ContainSubstring("Failed")))
			Expect(jobConditions()).To(ContainSubstring("Complete"))
			expectKeysReadable(Default, namespace, "valkey-vk-0")
		})

		It("turns off the default user and rejects a wrong password", func() {
			Expect(valkeyCliUnauthenticated(namespace, "valkey-vk-0", "ping")).To(HavePrefix("NOAUTH"))
			defaultUserJSON, err := valkeyCli(namespace, "valkey-vk-0", "", "-3", "--json", "acl", "getuser", "default")
			Expect(err).NotTo(HaveOccurred())
			var defaultUser struct{ Flags, Passwords []string }
			Expect(json.Unmarshal([]byte(defaultUserJSON), &defaultUser)).To(Succeed())
			Expect(defaultUser.Flags).To(And(ContainElement("off"), Not(ContainElement("nopass"))))
			Expect(defaultUser.Passwords).To(BeEmpty())

			Expect(valkeyCliUnauthenticated(namespace, "valkey-vk-0", "auth", "client", "wrong-password")).To(HavePrefix("WRONGPASS"))
		})

		It("lets client read and write keys but not run admin commands", func() {
			Expect(valkeyCliAs(namespace, "valkey-vk-0", "client", clientPassword, "", "-c", "set", "client-key", "written")).To(HaveSuffix("OK\n"))
			Expect(valkeyCliAs(namespace, "valkey-vk-0", "client", clientPassword, "", "-c", "get", "client-key")).To(HaveSuffix("written\n"))
			for _, adminCommand := range [][]string{{"config", "get", "maxmemory"}, {"flushall"}, {"acl", "list"}, {"shutdown"}} {
				Expect(valkeyCliAs(namespace, "valkey-vk-0", "client", clientPassword, "", adminCommand...)).To(HavePrefix("NOPERM"), "%v", adminCommand)
			}
		})

		It("lets metrics read INFO but no keys or config", func() {
			password := metricsPassword(namespace)
			Expect(valkeyCliAs(namespace, "valkey-vk-0", "metrics", password, "", "info", "server")).To(ContainSubstring("valkey_version:"))
			for _, deniedCommand := range [][]string{{"get", "key:0"}, {"set", "key:0", "overwritten"}, {"config", "get", "primaryauth"}} {
				Expect(valkeyCliAs(namespace, "valkey-vk-0", "metrics", password, "", deniedCommand...)).To(HavePrefix("NOPERM"), "%v", deniedCommand)
			}
		})

		It("serves every node's metrics on the ServiceMonitor's endpoint, and no /scrape", func() {
			endpoints := strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "servicemonitor", "valkey-vk",
				"-o", `jsonpath={range .spec.endpoints[*]}{.port}{" "}{.path}{"\n"}{end}`))
			Expect(endpoints).To(HaveLen(2), "want one endpoint with a port and a path")
			var serviceSelector map[string]string
			Expect(json.Unmarshal([]byte(e2e.MustRun("", "kubectl", "-n", namespace, "get", "servicemonitor", "valkey-vk",
				"-o", "jsonpath={.spec.selector.matchLabels}")), &serviceSelector)).To(Succeed())
			serviceSelectorLabels := []string{}
			for labelKey, labelValue := range serviceSelector {
				serviceSelectorLabels = append(serviceSelectorLabels, labelKey+"="+labelValue)
			}
			servicePort := e2e.MustRun("", "kubectl", "-n", namespace, "get", "service", "-l", strings.Join(serviceSelectorLabels, ","),
				"-o", fmt.Sprintf(`jsonpath={.items[*].spec.ports[?(@.name==%q)].targetPort}`, endpoints[0]))
			Expect(strings.Fields(servicePort)).To(HaveLen(1), "want one Service port named %s", endpoints[0])

			Eventually(expectExportersUp).WithArguments(namespace, servicePort, endpoints[1]).Should(Succeed())
			// NOTE: with the endpoint on, /scrape answers this with Valkey's metrics, using the exporter's password
			_, err := getThroughPodProxy(namespace, "valkey-vk-0", servicePort, "/scrape?target=redis://localhost:6379")
			Expect(err).To(MatchError(ContainSubstring("NotFound")))
		})

		It("denies the exporter's scrape nothing but the documented SLOWLOG GET", func() {
			for _, podName := range podNames(namespace) {
				Expect(valkeyCli(namespace, podName, "", "acl", "log", "reset")).To(Equal("OK\n"), podName)
				_, err := getThroughPodProxy(namespace, podName, "9121", "/metrics")
				Expect(err).NotTo(HaveOccurred())

				aclLogJSON, err := valkeyCli(namespace, podName, "", "-3", "--json", "acl", "log")
				Expect(err).NotTo(HaveOccurred())
				var aclLogEntries []struct{ Reason, Object, Username string }
				Expect(json.Unmarshal([]byte(aclLogJSON), &aclLogEntries)).To(Succeed())
				metricsDenials := []string{}
				for _, aclLogEntry := range aclLogEntries {
					if aclLogEntry.Username == "metrics" {
						metricsDenials = append(metricsDenials, aclLogEntry.Reason+" "+aclLogEntry.Object)
					}
				}
				Expect(metricsDenials).To(ConsistOf("command slowlog|get"), podName)
			}
		})

		It("keeps the metrics password across upgrades", func() {
			password := metricsPassword(namespace)
			upgradeValkey(namespace, map[string]string{})
			Expect(metricsPassword(namespace)).To(Equal(password))
			Eventually(expectExportersUp).WithArguments(namespace, "9121", "/metrics").Should(Succeed())
		})
	})

	Context("scaling masters without replicas", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkeyWithKeys(4, 0)
		})

		It("scales down to 3 masters with the pre-upgrade hook and keeps every key", func() {
			upgradeValkey(namespace, map[string]string{"cluster.masters": "3"})
			expectScaledCluster(namespace, 3, 0)
		})

		It("adds a master and rebalances slots onto it, keeping every key", func() {
			upgradeValkey(namespace, map[string]string{"cluster.masters": "4"})
			expectScaledCluster(namespace, 4, 0)
		})
	})

	Context("scaling from a single master", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkeyWithKeys(1, 0)
		})

		It("adds masters and replicas in one upgrade, leaving no open slot on any new replica", func() {
			upgradeValkey(namespace, map[string]string{"cluster.masters": "3", "cluster.replicasPerMaster": "1"})
			expectScaledCluster(namespace, 3, 1)
		})

		It("removes masters and replicas in one upgrade", func() {
			upgradeValkey(namespace, map[string]string{"cluster.masters": "1", "cluster.replicasPerMaster": "0"})
			expectScaledCluster(namespace, 1, 0)
		})

		It("adds a replica to a single master", func() {
			upgradeValkey(namespace, map[string]string{"cluster.replicasPerMaster": "1"})
			expectScaledCluster(namespace, 1, 1)
		})

		It("restarts a single deleted master empty, without failing over, and serves writes again", func() {
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", "valkey-vk-0")
			waitForHealthyCluster(namespace, 1, 1)
			// NOTE: the README's promise: with fewer than 3 masters no replica wins the vote, and the master restarts empty
			Expect(valkeyCli(namespace, "valkey-vk-0", "", "info", "replication")).To(ContainSubstring("role:master"))
			Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
			Expect(dbsize(Default, namespace, "valkey-vk-1")).To(BeZero())
			writeKeys(namespace)
			expectKeysReadable(Default, namespace, "valkey-vk-1")
		})
	})

	Context("scaling masters with replicas", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkeyWithKeys(2, 1)
		})

		It("adds a master and its replica", func() {
			upgradeValkey(namespace, map[string]string{"cluster.masters": "3"})
			expectScaledCluster(namespace, 3, 1)
		})

		It("removes a master and its replica", func() {
			upgradeValkey(namespace, map[string]string{"cluster.masters": "2"})
			expectScaledCluster(namespace, 2, 1)
		})
	})

	Context("failures in a 3 × 1 cluster", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkeyWithKeys(3, 1)
		})

		It("hands a deleted master's slots to its replica with every key and a short write outage", func() {
			promotedPodName := ""
			writeOutage := measureWriteOutage(namespace, 3, 1, "graceful-probe", func(masterPodName, replicaPodName string) {
				e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", masterPodName)
				promotedPodName = replicaPodName
			})
			Expect(valkeyCli(namespace, promotedPodName, "", "info", "replication")).To(ContainSubstring("role:master"))
			Expect(writeOutage).To(BeNumerically("<", 5*time.Second))
			expectKeysReadable(Default, namespace, "valkey-vk-0")
			Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
			// NOTE: a restart would load a full sync's dump.rdb as stale data
			for _, podName := range podNames(namespace) {
				Expect(e2e.MustRun("", "kubectl", "-n", namespace, "exec", podName, "-c", "valkey", "--", "ls", "/data")).
					NotTo(ContainSubstring("dump.rdb"), podName)
			}
		})

		It("fails a frozen master over to its replica soon after the node timeout", func() {
			writeOutage := measureWriteOutage(namespace, 3, 1, "frozen-probe", func(masterPodName, replicaPodName string) {
				signalValkeyServer(namespace, masterPodName, "STOP")
				Eventually(valkeyCli).WithArguments(namespace, replicaPodName, "", "info", "replication").
					WithTimeout(time.Minute).Should(ContainSubstring("role:master"))
				// NOTE: thawed, the old master finds a newer epoch for its slots and follows the replica
				signalValkeyServer(namespace, masterPodName, "CONT")
			})
			Expect(writeOutage).To(BeNumerically("<", 3*clusterNodeTimeout))
			expectKeysReadable(Default, namespace, "valkey-vk-0")
			Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
		})

		// TODO: pending until restarted nodes find their peers' new pod IPs: with every pod recreated at once, each node
		// keeps gossiping to the old IPs in its nodes.conf, so cluster_state stays fail and writes get CLUSTERDOWN
		PIt("serves writes again after every pod is deleted at once", func() {
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pods", "-l", "app=valkey-vk")
			Eventually(expectHealthyCluster).WithArguments(namespace, 3, 1).WithTimeout(5 * time.Minute).Should(Succeed())
			writeKeys(namespace)
			expectKeysReadable(Default, namespace, "valkey-vk-0")
			Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
		})
	})

	Context("lifecycle of a 3 × 1 release", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkeyWithKeys(3, 1)
		})

		It("keeps a $ in a parameter, live and on a restarted pod", func() {
			// NOTE: maxmemory sets up the rollback spec
			upgradeValkey(namespace, map[string]string{"parameters.notify-keyspace-events": "$xKE", "parameters.maxmemory": "200mb"})
			expectConfigOnEveryPod(namespace, "notify-keyspace-events", "$xKE")

			_, replicaPodName := shardOfKey(namespace, "key:0")
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", replicaPodName)
			waitForHealthyCluster(namespace, 3, 1)
			Expect(valkeyCli(namespace, replicaPodName, "", "config", "get", "notify-keyspace-events")).To(Equal("notify-keyspace-events\n$xKE\n"))
		})

		It("reapplies the parameters of the revision it rolls back to", func() {
			revision := helmRevision(namespace)
			upgradeValkey(namespace, map[string]string{"parameters.maxmemory": "150mb"})
			expectConfigOnEveryPod(namespace, "maxmemory", "157286400")
			e2e.MustRun("", "helm", "-n", namespace, "rollback", "valkey", revision, "--timeout=5m")
			expectConfigOnEveryPod(namespace, "maxmemory", "209715200")
		})

		It("restarts every pod for a valkey.conf change and keeps every key", func() {
			changedChartDirectory := filepath.Join(GinkgoT().TempDir(), "chart")
			Expect(os.CopyFS(changedChartDirectory, os.DirFS(valkeyChartDirectory))).To(Succeed())
			configFile, err := os.OpenFile(filepath.Join(changedChartDirectory, "files/valkey.conf"), os.O_APPEND|os.O_WRONLY, 0)
			Expect(err).NotTo(HaveOccurred())
			_, err = configFile.WriteString("\n# rolled by the e2e suite\n")
			Expect(err).NotTo(HaveOccurred())
			Expect(configFile.Close()).To(Succeed())
			originalPodUIDs := podUIDs(namespace)

			e2e.UpgradeChart(namespace, "valkey", changedChartDirectory, map[string]string{})
			waitForHealthyCluster(namespace, 3, 1)
			Expect(podUIDs(namespace)).NotTo(ContainElement(BeElementOf(originalPodUIDs)))
			expectKeysReadable(Default, namespace, "valkey-vk-0")
			Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
		})

		It("deletes the applied Secret on uninstall", func() {
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "get", "secret", "valkey-vk-applied", "-o", "jsonpath={.metadata.ownerReferences[*].kind}")).
				To(Equal("StatefulSet"))
			e2e.MustRun("", "helm", "-n", namespace, "uninstall", "valkey", "--wait", "--timeout=3m")
			Eventually(func() error {
				_, err := e2e.Run("", "kubectl", "-n", namespace, "get", "secret", "valkey-vk-applied")
				return err
			}).Should(MatchError(ContainSubstring("NotFound")))
		})
	})

	Context("upgrade from chart 0.1.5", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			previousChartDirectory := GinkgoT().TempDir()
			// NOTE: the last chart before the hooks this one adds for apply-config, which a 0.1.5 release has to get on its first upgrade
			e2e.MustRun("", "helm", "pull", "oci://ghcr.io/pandoks/charts/valkey", "--version", "0.1.5", "--untar", "--untardir", previousChartDirectory)
			previousImages := map[string]string{}
			if previousValkeyImage != "" {
				previousImages["image"] = previousValkeyImage
			}
			if previousValkeyReconcilerImage != "" {
				previousImages["cluster.reconcilerImage"] = previousValkeyReconcilerImage
			}
			namespace = installChart(filepath.Join(previousChartDirectory, "valkey"), 1, 1, previousImages)
			waitForHealthyCluster(namespace, 1, 1)
		})

		It("upgrades in place, creating what apply-config needs, and syncs the replica", func() {
			upgradeValkey(namespace, imageValues())
			waitForHealthyCluster(namespace, 1, 1)
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "get", "secret", "valkey-vk-applied", "-o", "jsonpath={.metadata.ownerReferences[*].kind}")).
				To(Equal("StatefulSet"))
			Eventually(expectExportersUp).WithArguments(namespace, "9121", "/metrics").Should(Succeed())
			writeKeys(namespace)
			Eventually(expectReplicasSynced).WithArguments(namespace).Should(Succeed())
		})
	})

	Context("admin password rotation", Ordered, func() {
		var namespace, masterPodName, replicaPodName string

		BeforeAll(func() {
			namespace = installValkeyWithKeys(1, 1)
			masterPodName, replicaPodName = shardOfKey(namespace, "key:0")
		})

		It("keeps pods ready, and a pod restarted meanwhile syncing, when the admin secret changes before the upgrade", func() {
			e2e.MustRun("", "kubectl", "-n", namespace, "patch", "secret", "valkey-creds", "--type=merge",
				"-p", fmt.Sprintf(`{"stringData":{"ADMIN_PASSWORD":%q}}`, newAdminPassword))
			for _, podName := range podNames(namespace) {
				Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "exec", podName, "-c", "valkey", "--", "cat", "/etc/valkey-admin/current").
					WithTimeout(3 * time.Minute).Should(Equal(newAdminPassword))
			}
			// NOTE: the readiness probe turns a pod unready after 3 failures 5s apart
			Consistently(expectPodsReady).WithArguments(namespace, 2).WithTimeout(20 * time.Second).WithPolling(time.Second).Should(Succeed())

			// NOTE: the restarted pod reads the new password, which its master doesn't accept until the upgrade
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", replicaPodName)
			Eventually(expectReplicasSynced).WithArguments(namespace).WithTimeout(2 * time.Minute).Should(Succeed())
			Expect(valkeyCliAs(namespace, replicaPodName, "admin", newAdminPassword, "", "ping")).To(Equal("PONG\n"))

			upgradeValkey(namespace, map[string]string{})
			for _, podName := range podNames(namespace) {
				Expect(valkeyCliAs(namespace, podName, "admin", newAdminPassword, "", "ping")).To(Equal("PONG\n"), podName)
			}
			expectPodsReady(Default, namespace, 2)
		})

		It("reconnects the replica with the rotated password once its link drops", func() {
			replicaClientID := func() (string, error) {
				clientList, err := valkeyCliAs(namespace, masterPodName, "admin", newAdminPassword, "", "client", "list", "type", "replica")
				clientIDMatch := regexp.MustCompile(`(?m)^id=(\d+) `).FindStringSubmatch(clientList)
				if clientIDMatch == nil {
					return "", err
				}
				return clientIDMatch[1], err
			}
			originalReplicaClientID, err := replicaClientID()
			Expect(err).NotTo(HaveOccurred())
			Expect(originalReplicaClientID).NotTo(BeEmpty())

			// NOTE: a replica logs in to its master only on connecting, so drop the link to use primaryauth
			Expect(valkeyCliAs(namespace, masterPodName, "admin", newAdminPassword, "", "client", "kill", "type", "replica")).To(Equal("1\n"))
			Eventually(replicaClientID).Should(And(Not(BeEmpty()), Not(Equal(originalReplicaClientID))))
		})
	})

	Context("replication", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installValkeyWithKeys(3, 1)
		})

		It("applies parameters to the running nodes without restarting them", func() {
			originalPodUIDs := podUIDs(namespace)
			// NOTE: no-failover and the sync delay set up the next specs
			upgradeValkey(namespace, map[string]string{
				"parameters.maxmemory":                   "200mb",
				"parameters.cluster-replica-no-failover": "yes",
				"parameters.repl-diskless-sync-delay":    "30",
			})
			expectConfigOnEveryPod(namespace, "maxmemory", "209715200")
			Expect(podUIDs(namespace)).To(Equal(originalPodUIDs))
		})

		It("keeps a restarted replica unready until it syncs", func() {
			// NOTE: the probe first runs 10s after the container starts, so the sync delay must outlast it
			_, replicaPodName := shardOfKey(namespace, "key:0")
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", replicaPodName)

			Eventually(valkeyCli).WithArguments(namespace, replicaPodName, "", "info", "replication").
				Should(ContainSubstring("master_link_status:down"))
			Consistently(func(g Gomega) {
				replicationInfo, err := valkeyCli(namespace, replicaPodName, "", "info", "replication")
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(replicationInfo).To(ContainSubstring("master_link_status:down"))
				g.Expect(podReadyStatus(namespace, replicaPodName)).To(Equal("False"))
			}).WithTimeout(15 * time.Second).WithPolling(time.Second).Should(Succeed())

			Eventually(podReadyStatus).WithArguments(namespace, replicaPodName).Should(Equal("True"))
			Expect(valkeyCli(namespace, replicaPodName, "", "info", "replication")).To(ContainSubstring("master_link_status:up"))
		})

		It("scales down right after a failover, while the demoted master resyncs", func() {
			demotedPodName, promotedPodName := shardOfKey(namespace, "key:0")
			Expect(valkeyCli(namespace, promotedPodName, "", "cluster", "failover")).To(Equal("OK\n"))
			Eventually(valkeyCli).WithArguments(namespace, demotedPodName, "", "info", "replication").Should(ContainSubstring("role:slave"))

			// NOTE: the sync delay keeps the restarted replica resyncing while scale-down runs
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", demotedPodName)
			Eventually(valkeyCli).WithArguments(namespace, demotedPodName, "", "info", "replication").
				Should(And(ContainSubstring("role:slave"), ContainSubstring("master_link_status:down")))
			upgradeValkey(namespace, map[string]string{"cluster.replicasPerMaster": "0"})
			expectScaledCluster(namespace, 3, 0)
		})

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
				Expect(valkeyCliUnauthenticated(namespace, podName, "auth", "admin", adminPassword)).To(HavePrefix("WRONGPASS"), podName)
				Expect(valkeyCliAs(namespace, podName, "admin", newAdminPassword, "", "ping")).To(Equal("PONG\n"), podName)
			}
		})
	})
})
