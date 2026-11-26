package postgres_test

import (
	"crypto/rand"
	"e2e"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/onsi/gomega/types"
)

const (
	postgresChartDirectory = "../chart"
	// NOTE: with no version, Helm installs the highest release; branches publish only prereleases
	publishedPostgresChart = "oci://ghcr.io/pandoks/charts/postgres"
	database               = "app"
	adminPassword          = "admin-test-password"
	clientPassword         = "client-test-password"
	patroniConfig          = "/etc/patroni/patroni.yaml"
	pgdogName              = database + "-pgdog"
	defaultPodCount        = 3
)

func clusterName(shard int) string     { return fmt.Sprintf("%s-shard-%d", database, shard) }
func statefulSetName(shard int) string { return "patroni-" + clusterName(shard) }
func podName(shard, podIndex int) string {
	return fmt.Sprintf("%s-%d", statefulSetName(shard), podIndex)
}

func primaryServiceHost(shard int) string {
	return fmt.Sprintf("patroni-%s-primary-shard-%d", database, shard)
}

func newBackupPath() string {
	return "/e2e/" + strings.ToLower(rand.Text()[:8])
}

func imageValues(patroni, pgbackrest string) map[string]string {
	images := map[string]string{}
	if patroni != "" {
		images["patroni.image"] = patroni
	}
	if pgbackrest != "" {
		images["backup.image"] = pgbackrest
	}
	return images
}

func installPostgres(chart string, shardCount int, valueOverrides map[string]string) string {
	GinkgoHelper()
	chartValues := map[string]string{
		"db":                        database,
		"patroni.shards":            strconv.Itoa(shardCount),
		"credentials.secret":        "postgres-creds",
		"backup.credentials.secret": "postgres-creds",
		"backup.path":               newBackupPath(),
		"backup.encryptionKey":      "e2e-encryption-key",
		// NOTE: Feb 30 keeps the CronJobs without firing scheduled backups mid-spec
		"backup.schedules.full": "0 0 30 2 *",
		"backup.schedules.diff": "0 0 30 2 *",
		"backup.schedules.incr": "0 0 30 2 *",
		// NOTE: non-PgDog specs don't run PgDog, and startPgDog scales it up once Patroni pods are Ready
		"pgdog.replicas": "0",
	}
	images := imageValues(patroniImage, pgbackrestImage)
	if chart == publishedPostgresChart {
		images = imageValues(previousPatroniImage, previousPgbackrestImage)
	}
	maps.Copy(chartValues, images)
	maps.Copy(chartValues, valueOverrides)
	return e2e.InstallChart("postgres", chart, map[string]string{
		"SUPERUSER_PASSWORD":   "superuser-test-password",
		"ADMIN_PASSWORD":       adminPassword,
		"CLIENT_PASSWORD":      clientPassword,
		"REPLICATION_PASSWORD": "replication-test-password",
		"PATRONI_PASSWORD":     "patroni-test-password",
		"S3_ACCESS_KEY":        "e2e",
		"S3_SECRET_KEY":        "e2e",
		"users.toml":           fmt.Sprintf("[[users]]\nname = \"client\"\ndatabase = %q\npassword = %q\n", database, clientPassword),
	}, chartValues)
}

func installPostgresWithRowsTable(chart string, shardCount int, valueOverrides map[string]string) string {
	GinkgoHelper()
	namespace := installPostgres(chart, shardCount, valueOverrides)
	for shard := range shardCount {
		waitForHealthyShard(namespace, shard, defaultPodCount)
		mustPsqlOnPrimary(namespace, shard, "CREATE TABLE e2e_rows (id int PRIMARY KEY)")
	}
	return namespace
}

func execInPod(namespace, podName, container string, command ...string) (string, error) {
	output, err := e2e.Run("", "kubectl", append([]string{"-n", namespace, "exec", podName, "-c", container, "--"}, command...)...)
	return strings.TrimSpace(output), err
}

func psql(namespace, podName, sql string) (string, error) {
	return execInPod(namespace, podName, "patroni", "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql)
}

func psqlOverNetwork(namespace, clientPodName, user, password, databaseName, sql string) (string, error) {
	connection := fmt.Sprintf("host=%s user=%s password=%s dbname=%s connect_timeout=2", primaryServiceHost(0), user, password, databaseName)
	return execInPod(namespace, clientPodName, "patroni", "psql", connection, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql)
}

func psqlThroughPgDog(namespace, clientPodName, sql string) (string, error) {
	return psqlThroughPgDogPod(namespace, clientPodName, pgdogName, sql)
}

func psqlThroughPgDogPod(namespace, clientPodName, pgdogAddress, sql string) (string, error) {
	connection := fmt.Sprintf("host=%s port=6432 user=client password=%s dbname=%s connect_timeout=2", pgdogAddress, clientPassword, database)
	return execInPod(namespace, clientPodName, "patroni", "psql", connection, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql)
}

func dumpPgDogDiagnostics(namespace string) {
	helmChartName := namespace + "-" + pgdogName
	for _, kubectlArguments := range [][]string{
		{"-n", "kube-system", "describe", "helmchart", helmChartName},
		{"-n", "kube-system", "get", "jobs,pods", "-l", "helmcharts.helm.cattle.io/chart=" + helmChartName, "-o", "wide"},
	} {
		output, err := e2e.Run("", "kubectl", kubectlArguments...)
		GinkgoWriter.Printf("\n$ kubectl %s\n%s%v\n", strings.Join(kubectlArguments, " "), output, err)
	}
	podNames, _ := e2e.Run("", "kubectl", "-n", "kube-system", "get", "pods", "-l", "helmcharts.helm.cattle.io/chart="+helmChartName, "-o", "name")
	for _, podName := range strings.Fields(podNames) {
		podLogs, _ := e2e.Run("", "kubectl", "-n", "kube-system", "logs", podName, "--all-containers", "--prefix", "--tail=30")
		GinkgoWriter.Printf("\n$ kubectl -n kube-system logs %s\n%s", podName, podLogs)
	}
}

// NOTE: PgDog starts only once every pod is Ready, as it bans a replica it can't resolve
func startPgDog(namespace string, shardCount int) {
	GinkgoHelper()
	DeferCleanup(func() {
		if CurrentSpecReport().Failed() {
			dumpPgDogDiagnostics(namespace)
		}
	})
	for shard := range shardCount {
		e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(shard), "--timeout=5m")
	}
	e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"pgdog.replicas": "2"})
	// NOTE: k3s's helm-controller applies PgDog's HelmChart asynchronously
	Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "wait", "--for=jsonpath={.status.readyReplicas}=2", "deployment/"+pgdogName, "--timeout=1m").
		WithTimeout(5 * time.Minute).Should(ContainSubstring("condition met"))
}

func restartPgDog(namespace string, shardCount int) {
	GinkgoHelper()
	Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "get", "configmap", pgdogName, "-o", `jsonpath={.data.pgdog\.toml}`).
		Should(And(ContainSubstring(statefulSetName(shardCount-1)), Not(ContainSubstring(statefulSetName(shardCount)))))
	oldPgDogPods := strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "app.kubernetes.io/name=pgdog", "-o", "name"))
	e2e.MustRun("", "kubectl", "rollout", "restart", "deploy/"+pgdogName, "-n", namespace)
	e2e.MustRun("", "kubectl", "rollout", "status", "deploy/"+pgdogName, "-n", namespace, "--timeout=3m")
	e2e.MustRun("", "kubectl", append([]string{"-n", namespace, "wait", "--for=delete", "--timeout=2m"}, oldPgDogPods...)...)
}

func waitForPgDogWrites(namespace, clientPod string, rowCount int) {
	GinkgoHelper()
	Eventually(func(g Gomega) {
		for id := 1; id <= rowCount; id++ {
			// NOTE: deletes nothing, as no row has the key yet, but still needs the key's primary
			g.Expect(psqlThroughPgDog(namespace, clientPod, fmt.Sprintf("DELETE FROM e2e_users WHERE id = %d", id))).Error().NotTo(HaveOccurred())
		}
	}).Should(Succeed())
}

func podIP(namespace, podName string) string {
	GinkgoHelper()
	return e2e.MustRun("", "kubectl", "-n", namespace, "get", "pod", podName, "-o", "jsonpath={.status.podIP}")
}

func primaryPodName(namespace string, shard int) (string, error) {
	primaryPods, err := e2e.Run("", "kubectl", "-n", namespace, "get", "pods", "-l", "role=primary,cluster-name="+clusterName(shard),
		"-o", "jsonpath={.items[*].metadata.name}")
	if err != nil {
		return "", err
	}
	if len(strings.Fields(primaryPods)) != 1 {
		return "", fmt.Errorf("want one pod labeled role=primary in %s, got %q", clusterName(shard), primaryPods)
	}
	return primaryPods, nil
}

func mustPrimaryPodName(namespace string, shard int) string {
	GinkgoHelper()
	primaryPod, err := primaryPodName(namespace, shard)
	Expect(err).NotTo(HaveOccurred())
	return primaryPod
}

func replicaPodName(namespace string, shard, podCount int) string {
	GinkgoHelper()
	primaryPod := mustPrimaryPodName(namespace, shard)
	for podIndex := range podCount {
		if podName(shard, podIndex) != primaryPod {
			return podName(shard, podIndex)
		}
	}
	Fail("shard has no replica")
	return ""
}

func psqlOnPrimary(namespace string, shard int, sql string) (string, error) {
	primaryPod, err := primaryPodName(namespace, shard)
	if err != nil {
		return "", err
	}
	return psql(namespace, primaryPod, sql)
}

func mustPsqlOnPrimary(namespace string, shard int, sql string) string {
	GinkgoHelper()
	output, err := psqlOnPrimary(namespace, shard, sql)
	Expect(err).NotTo(HaveOccurred())
	return output
}

type patroniMember struct {
	Member   string `json:"Member"`
	Role     string `json:"Role"`
	State    string `json:"State"`
	Timeline int    `json:"TL"`
}

func expectHealthyShard(g Gomega, namespace string, shard, podCount int) {
	membersJSON, err := execInPod(namespace, podName(shard, 0), "patroni", "patronictl", "-c", patroniConfig, "list", "-f", "json")
	g.Expect(err).NotTo(HaveOccurred())
	var members []patroniMember
	g.Expect(json.Unmarshal([]byte(membersJSON), &members)).To(Succeed())
	g.Expect(members).To(HaveLen(podCount))

	var leaders []patroniMember
	for _, member := range members {
		if member.Role == "Leader" {
			leaders = append(leaders, member)
		}
	}
	g.Expect(leaders).To(HaveLen(1), "want exactly one leader: %+v", members)
	g.Expect(leaders[0].State).To(Equal("running"))
	for _, member := range members {
		if member.Role != "Leader" {
			g.Expect(member).To(And(HaveField("Role", "Replica"), HaveField("State", "streaming"), HaveField("Timeline", leaders[0].Timeline)))
		}
		expectedInRecovery := "t"
		if member.Role == "Leader" {
			expectedInRecovery = "f"
		}
		inRecovery, err := psql(namespace, member.Member, "SELECT pg_is_in_recovery()")
		g.Expect(err).NotTo(HaveOccurred())
		g.Expect(inRecovery).To(Equal(expectedInRecovery), "%s's Postgres disagrees with Patroni on its role", member.Member)
	}

	primaryPod, err := primaryPodName(namespace, shard)
	g.Expect(err).NotTo(HaveOccurred())
	g.Expect(primaryPod).To(Equal(leaders[0].Member), "the pod labeled role=primary isn't the leader")
}

func expectReplicationSlots(g Gomega, namespace string, shard, podCount int) {
	primaryPod, err := primaryPodName(namespace, shard)
	g.Expect(err).NotTo(HaveOccurred())
	var expectedSlots []string
	for podIndex := range podCount {
		if podName(shard, podIndex) != primaryPod {
			expectedSlots = append(expectedSlots, strings.ReplaceAll(podName(shard, podIndex), "-", "_"))
		}
	}
	slots, err := psql(namespace, primaryPod, "SELECT slot_name FROM pg_replication_slots WHERE active ORDER BY slot_name")
	g.Expect(err).NotTo(HaveOccurred())
	g.Expect(strings.Fields(slots)).To(Equal(expectedSlots))
}

func insertRows(namespace string, shard, firstID, lastID int) {
	GinkgoHelper()
	mustPsqlOnPrimary(namespace, shard, fmt.Sprintf("INSERT INTO e2e_rows SELECT generate_series(%d, %d)", firstID, lastID))
}

func expectRows(g Gomega, namespace, podName string, firstID, lastID int) {
	rowSummary, err := psql(namespace, podName, "SELECT count(*), min(id), max(id) FROM e2e_rows")
	g.Expect(err).NotTo(HaveOccurred())
	g.Expect(rowSummary).To(Equal(fmt.Sprintf("%d|%d|%d", lastID-firstID+1, firstID, lastID)))
}

func expectRowsOnEveryPod(namespace string, shard, podCount, firstID, lastID int) {
	GinkgoHelper()
	for podIndex := range podCount {
		Eventually(expectRows).WithArguments(namespace, podName(shard, podIndex), firstID, lastID).Should(Succeed())
	}
}

func waitForHealthyShard(namespace string, shard, podCount int) {
	GinkgoHelper()
	Eventually(expectHealthyShard).WithArguments(namespace, shard, podCount).WithTimeout(6 * time.Minute).Should(Succeed())
}

func switchover(namespace string, shard int, candidatePod string) {
	GinkgoHelper()
	leaderPod := mustPrimaryPodName(namespace, shard)
	// NOTE: patronictl exits 0 when Patroni refuses the switchover
	Expect(e2e.MustRun("", "kubectl", "-n", namespace, "exec", leaderPod, "-c", "patroni", "--",
		"patronictl", "-c", patroniConfig, "switchover", "--leader", leaderPod, "--candidate", candidatePod, "--force")).
		To(ContainSubstring("Successfully switched over"))
	Eventually(primaryPodName).WithArguments(namespace, shard).Should(Equal(candidatePod))
}

type stanzaInfo struct {
	Cipher string `json:"cipher"`
	Status struct {
		Message string `json:"message"`
	} `json:"status"`
	Backup []struct {
		Type    string `json:"type"`
		Label   string `json:"label"`
		Error   bool   `json:"error"`
		Archive struct {
			Start string `json:"start"`
		} `json:"archive"`
	} `json:"backup"`
	Archive []struct {
		Min string `json:"min"`
		Max string `json:"max"`
	} `json:"archive"`
}

func readStanzaInfo(g Gomega, namespace string, shard int) stanzaInfo {
	primaryPod, err := primaryPodName(namespace, shard)
	g.Expect(err).NotTo(HaveOccurred())
	infoJSON, err := execInPod(namespace, primaryPod, "patroni", "pgbackrest", "--stanza="+clusterName(shard), "info", "--output=json")
	g.Expect(err).NotTo(HaveOccurred())
	var stanzas []stanzaInfo
	g.Expect(json.Unmarshal([]byte(infoJSON), &stanzas)).To(Succeed())
	g.Expect(stanzas).To(HaveLen(1))
	return stanzas[0]
}

func backupTypes(info stanzaInfo) []string {
	var types []string
	for _, backup := range info.Backup {
		types = append(types, backup.Type)
	}
	return types
}

func expectValidBackups(g Gomega, namespace string, shard int) {
	info := readStanzaInfo(g, namespace, shard)
	g.Expect(info.Status.Message).To(Equal("ok"))
	g.Expect(info.Backup).NotTo(BeEmpty())
	g.Expect(info.Backup).To(HaveEach(HaveField("Error", false)), "a backup is recorded with an error")
}

func switchWAL(namespace string, shard int) string {
	GinkgoHelper()
	return mustPsqlOnPrimary(namespace, shard, "SELECT pg_walfile_name(pg_switch_wal())")
}

func expectArchived(g Gomega, namespace string, shard int, walSegment string) {
	info := readStanzaInfo(g, namespace, shard)
	g.Expect(info.Archive).NotTo(BeEmpty())
	// NOTE: WAL segment names are fixed-width hex, so they compare in WAL order
	newestArchivedSegment := info.Archive[len(info.Archive)-1].Max
	g.Expect(newestArchivedSegment >= walSegment).To(BeTrue(), "the repo's newest WAL is %s, want %s", newestArchivedSegment, walSegment)
}

func startBackupJob(namespace string, shard int, backupType, jobName string) {
	GinkgoHelper()
	e2e.MustRun("", "kubectl", "-n", namespace, "create", "job", jobName,
		fmt.Sprintf("--from=cronjob/%s-pgbackrest-backup-%s", clusterName(shard), backupType))
}

func runBackupJob(namespace string, shard int, backupType, jobName string) {
	GinkgoHelper()
	startBackupJob(namespace, shard, backupType, jobName)
	e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=condition=Complete", "job/"+jobName, "--timeout=5m")
}

type serviceMonitor struct {
	Spec struct {
		Selector struct {
			MatchLabels map[string]string `json:"matchLabels"`
		} `json:"selector"`
		Endpoints []struct {
			Port string `json:"port"`
			Path string `json:"path"`
		} `json:"endpoints"`
	} `json:"spec"`
}

type endpointSliceList struct {
	Items []struct {
		Endpoints []struct {
			TargetRef struct {
				Name string `json:"name"`
			} `json:"targetRef"`
		} `json:"endpoints"`
		Ports []struct {
			Name string `json:"name"`
			Port int    `json:"port"`
		} `json:"ports"`
	} `json:"items"`
}

func serviceMonitorTargets(namespace, serviceMonitorName string) []string {
	GinkgoHelper()
	var monitor serviceMonitor
	Expect(json.Unmarshal([]byte(e2e.MustRun("", "kubectl", "-n", namespace, "get", "servicemonitor", serviceMonitorName, "-o", "json")), &monitor)).To(Succeed())
	var selector []string
	for labelKey, labelValue := range monitor.Spec.Selector.MatchLabels {
		selector = append(selector, labelKey+"="+labelValue)
	}
	services := strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "services", "-l", strings.Join(selector, ","),
		"-o", "jsonpath={.items[*].metadata.name}"))
	Expect(services).NotTo(BeEmpty(), "%s selects no Service", serviceMonitorName)
	var endpointSlices endpointSliceList
	Expect(json.Unmarshal([]byte(e2e.MustRun("", "kubectl", "-n", namespace, "get", "endpointslices",
		"-l", fmt.Sprintf("kubernetes.io/service-name in (%s)", strings.Join(services, ",")), "-o", "json")), &endpointSlices)).To(Succeed())

	var targets []string
	for _, endpoint := range monitor.Spec.Endpoints {
		for _, slice := range endpointSlices.Items {
			for _, port := range slice.Ports {
				if port.Name != endpoint.Port {
					continue
				}
				for _, address := range slice.Endpoints {
					targets = append(targets, fmt.Sprintf("/api/v1/namespaces/%s/pods/%s:%d/proxy%s", namespace, address.TargetRef.Name, port.Port, endpoint.Path))
				}
			}
		}
	}
	return targets
}

type acknowledgedWrite struct {
	id         int
	returnedAt time.Time
}

func writeThroughPrimaryDeletion(namespace string, psqlAsClient func(sql string) (string, error)) []acknowledgedWrite {
	GinkgoHelper()
	oldPrimaryPod := mustPrimaryPodName(namespace, 0)
	var writesMutex sync.Mutex
	var writes []acknowledgedWrite
	snapshot := func() []acknowledgedWrite {
		writesMutex.Lock()
		defer writesMutex.Unlock()
		return slices.Clone(writes)
	}
	stopWriting := make(chan struct{})
	writerDone := make(chan struct{})
	stopWriter := sync.OnceFunc(func() { close(stopWriting) })
	DeferCleanup(stopWriter)
	go func() {
		defer GinkgoRecover()
		defer close(writerDone)
		for id := 1; ; id++ {
			select {
			case <-stopWriting:
				return
			default:
			}
			if _, err := psqlAsClient(fmt.Sprintf("INSERT INTO e2e_writes VALUES (%d)", id)); err == nil {
				writesMutex.Lock()
				writes = append(writes, acknowledgedWrite{id: id, returnedAt: time.Now()})
				writesMutex.Unlock()
			}
		}
	}()

	Eventually(snapshot).ShouldNot(BeEmpty(), "no write succeeded before deleting the primary")
	e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", oldPrimaryPod)
	Eventually(primaryPodName).WithArguments(namespace, 0).WithTimeout(2 * time.Minute).
		Should(And(Not(BeEmpty()), Not(Equal(oldPrimaryPod))))
	promotedAt := time.Now()
	Eventually(func() time.Time {
		current := snapshot()
		return current[len(current)-1].returnedAt
	}).WithTimeout(35*time.Second).Should(BeTemporally(">", promotedAt), "writes didn't resume after failover")
	stopWriter()
	<-writerDone
	return snapshot()
}

func expectBriefWriteUnavailability(writes []acknowledgedWrite, reportName string) {
	GinkgoHelper()
	Expect(len(writes)).To(BeNumerically(">=", 2))
	var writeUnavailability time.Duration
	for writeIndex := 1; writeIndex < len(writes); writeIndex++ {
		writeUnavailability = max(writeUnavailability, writes[writeIndex].returnedAt.Sub(writes[writeIndex-1].returnedAt))
	}
	AddReportEntry(reportName, writeUnavailability.String())
	Expect(writeUnavailability).To(BeNumerically("<", 30*time.Second))
}

func expectAcknowledgedWritesKept(namespace string, writes []acknowledgedWrite) {
	GinkgoHelper()
	acknowledgedIDs := make([]string, len(writes))
	for writeIndex, write := range writes {
		acknowledgedIDs[writeIndex] = strconv.Itoa(write.id)
	}
	Expect(mustPsqlOnPrimary(namespace, 0, fmt.Sprintf("SELECT count(*) FROM e2e_writes WHERE id IN (%s)",
		strings.Join(acknowledgedIDs, ",")))).To(Equal(strconv.Itoa(len(writes))), "an acknowledged write was lost")
}

func podUIDs(namespace string, shard int) []string {
	GinkgoHelper()
	return strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "cluster-name="+clusterName(shard),
		"-o", "jsonpath={.items[*].metadata.uid}"))
}

var _ = Describe("Postgres", Label("postgres"), func() {
	Context("through PgDog", Ordered, func() {
		const (
			selectServerIP = "SELECT host(inet_server_addr())"
			upsertServerIP = "INSERT INTO e2e_writes VALUES (0) ON CONFLICT (id) DO UPDATE SET id = excluded.id RETURNING host(inet_server_addr())"
		)
		var namespace, clientPod, pgdogPodIP string

		BeforeAll(func() {
			// NOTE: PgDog defaults banTimeout to 5m, past the ban spec's 1m timeout
			namespace = installPostgres(postgresChartDirectory, 1, map[string]string{"pgdog.banTimeout": "10000"})
			waitForHealthyShard(namespace, 0, defaultPodCount)
			// NOTE: PgDog breaks least-active ties in config order, so the read specs need pod 0 to lead
			if mustPrimaryPodName(namespace, 0) != podName(0, 0) {
				switchover(namespace, 0, podName(0, 0))
				waitForHealthyShard(namespace, 0, defaultPodCount)
			}
			// NOTE: the specs delete the other two pods
			clientPod = podName(0, 2)
			Expect(psqlOverNetwork(namespace, clientPod, "admin", adminPassword, database, "CREATE TABLE e2e_writes (id int PRIMARY KEY)")).Error().NotTo(HaveOccurred())
			startPgDog(namespace, 1)
			// NOTE: each PgDog pod balances and bans on its own, so the read specs go through one
			pgdogPodIP = strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "app.kubernetes.io/name=pgdog",
				"-o", "jsonpath={.items[*].status.podIP}"))[0]
		})

		It("sends writes to the primary", func() {
			primaryIP := podIP(namespace, mustPrimaryPodName(namespace, 0))
			Eventually(psqlThroughPgDog).WithArguments(namespace, clientPod, upsertServerIP).Should(Equal(primaryIP))
			for range 20 {
				Expect(psqlThroughPgDog(namespace, clientPod, upsertServerIP)).To(Equal(primaryIP))
			}
		})

		It("reports each pod's detected role in its metrics on 9090, as the README's curl reads them", func() {
			var roleLineMatchers []types.GomegaMatcher
			for podIndex := range defaultPodCount {
				role := "replica"
				if podIndex == 0 {
					role = "primary"
				}
				roleLineMatchers = append(roleLineMatchers, ContainElement(SatisfyAll(
					ContainSubstring(fmt.Sprintf(`host="%s.%s.%s.svc.cluster.local"`, podName(0, podIndex), statefulSetName(0), namespace)),
					ContainSubstring(fmt.Sprintf(`role="%s"`, role)))))
			}
			metricsBySource := map[string]string{
				"the README's curl": e2e.MustRun("", "kubectl", "-n", namespace, "exec", "deploy/"+pgdogName, "--", "curl", "-s", "http://127.0.0.1:9090/metrics"),
			}
			targets := serviceMonitorTargets(namespace, pgdogName)
			Expect(targets).To(HaveLen(2), "the ServiceMonitor doesn't target each PgDog pod once")
			for _, target := range targets {
				metricsBySource[target] = e2e.MustRun("", "kubectl", "get", "--raw", target)
			}
			for source, metrics := range metricsBySource {
				for _, roleLineMatcher := range roleLineMatchers {
					Expect(strings.Split(metrics, "\n")).To(roleLineMatcher, source)
				}
			}
		})

		It("sends reads to both replicas", func() {
			replicaIPs := []string{podIP(namespace, podName(0, 1)), podIP(namespace, podName(0, 2))}
			var heldReadServerIP string
			heldReadDone := make(chan error, 1)
			go func() {
				var err error
				heldReadServerIP, err = psqlThroughPgDogPod(namespace, clientPod, pgdogPodIP, selectServerIP+" FROM pg_sleep(30)")
				heldReadDone <- err
			}()
			var sleepingReplicaIP string
			Eventually(func(g Gomega) {
				for podIndex := 1; podIndex < defaultPodCount; podIndex++ {
					sleeping, err := psql(namespace, podName(0, podIndex), "SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'PgSleep'")
					g.Expect(err).NotTo(HaveOccurred())
					if sleeping == "1" {
						sleepingReplicaIP = podIP(namespace, podName(0, podIndex))
					}
				}
				g.Expect(sleepingReplicaIP).NotTo(BeEmpty())
			}).Should(Succeed())

			// NOTE: PgDog's LSN monitor can tie checkouts to the sleeping replica, so retry past them
			var readServerIP string
			Eventually(func(g Gomega) {
				var err error
				readServerIP, err = psqlThroughPgDogPod(namespace, clientPod, pgdogPodIP, selectServerIP)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(readServerIP).NotTo(Equal(sleepingReplicaIP))
			}).Should(Succeed())
			Expect(<-heldReadDone).To(Succeed())
			Expect([]string{heldReadServerIP, readServerIP}).To(ConsistOf(replicaIPs))
		})

		It("reads from the primary while a deleted replica is banned, then from the replica again", func() {
			primaryIP := podIP(namespace, podName(0, 0))
			bannedPod := podName(0, 1)
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", bannedPod)
			Eventually(psqlThroughPgDogPod).WithArguments(namespace, clientPod, pgdogPodIP, selectServerIP).Should(Equal(primaryIP))
			waitForHealthyShard(namespace, 0, defaultPodCount)
			Eventually(psqlThroughPgDogPod).WithArguments(namespace, clientPod, pgdogPodIP, selectServerIP).Should(Equal(podIP(namespace, bannedPod)))
		})

		It("reaches the new primary within 30s of a graceful primary deletion, keeping every acknowledged write", func() {
			writes := writeThroughPrimaryDeletion(namespace, func(sql string) (string, error) {
				return psqlThroughPgDog(namespace, clientPod, sql)
			})
			expectBriefWriteUnavailability(writes, "PgDog write unavailability on primary deletion")
			expectAcknowledgedWritesKept(namespace, writes)

			newPrimaryIP := podIP(namespace, mustPrimaryPodName(namespace, 0))
			pgdogPodIPs := strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "app.kubernetes.io/name=pgdog",
				"-o", "jsonpath={.items[*].status.podIP}"))
			Expect(pgdogPodIPs).To(HaveLen(2))
			// NOTE: each PgDog pod detects the promotion on its own loop
			for _, pgdogAddress := range pgdogPodIPs {
				Eventually(psqlThroughPgDogPod).WithArguments(namespace, clientPod, pgdogAddress, upsertServerIP).
					WithTimeout(30 * time.Second).Should(Equal(newPrimaryIP))
			}
		})
	})

	Context("two shards of three pods", Ordered, func() {
		const shardCount = 2
		var namespace string

		BeforeAll(func() {
			namespace = installPostgres(postgresChartDirectory, shardCount, nil)
			for shard := range shardCount {
				waitForHealthyShard(namespace, shard, defaultPodCount)
			}
		})

		It("gives each shard its own encrypted stanza with a full backup from bootstrap", func() {
			for shard := range shardCount {
				info := readStanzaInfo(Default, namespace, shard)
				Expect(info.Status.Message).To(Equal("ok"))
				Expect(info.Cipher).To(Equal("aes-256-cbc"))
				Expect(backupTypes(info)).To(Equal([]string{"full"}))
			}
		})

		It("creates pg_stat_statements in each shard's app database at bootstrap", func() {
			for shard := range shardCount {
				Expect(psqlOnPrimary(namespace, shard, "SELECT count(*) > 0 FROM pg_stat_statements")).To(Equal("t"))
			}
		})

		It("lets client query pgvector and PostGIS columns once the superuser creates the extensions", func() {
			mustPsqlOnPrimary(namespace, 0, "CREATE EXTENSION vector; CREATE EXTENSION postgis")
			replicaPod := replicaPodName(namespace, 0, defaultPodCount)
			Expect(psqlOverNetwork(namespace, replicaPod, "admin", adminPassword, database,
				"CREATE TABLE e2e_places (id int PRIMARY KEY, embedding vector(2), location geography(Point))")).Error().NotTo(HaveOccurred())
			Expect(psqlOverNetwork(namespace, replicaPod, "client", clientPassword, database, `
				INSERT INTO e2e_places VALUES (1, '[0,0]', 'POINT(0 0)'), (2, '[1,1]', 'POINT(1 1)');
				SELECT id FROM e2e_places ORDER BY embedding <-> '[0.9,0.9]' LIMIT 1;
				SELECT id FROM e2e_places WHERE ST_DWithin(location, 'POINT(0.001 0)', 1000)`)).To(Equal("2\n1"))
		})

		It("runs pg_cron jobs in the app database once the superuser creates pg_cron", func() {
			mustPsqlOnPrimary(namespace, 0, `CREATE EXTENSION pg_cron; CREATE TABLE e2e_cron_runs (ran_at timestamptz);
				SELECT cron.schedule('e2e', '1 seconds', 'INSERT INTO e2e_cron_runs VALUES (now())')`)
			Eventually(psqlOnPrimary).WithArguments(namespace, 0, "SELECT count(*) >= 2 FROM e2e_cron_runs").Should(Equal("t"))
		})

		It("serves every pod's Patroni and Postgres metrics at its ServiceMonitors' targets", func() {
			for serviceMonitorName, upMetric := range map[string]string{
				"patroni-" + database:  `(?m)^patroni_postgres_running\{.*\} 1$`,
				"postgres-" + database: `(?m)^pg_up 1$`,
			} {
				targets := serviceMonitorTargets(namespace, serviceMonitorName)
				Expect(targets).To(HaveLen(shardCount*defaultPodCount), "%s doesn't target every pod", serviceMonitorName)
				for _, target := range targets {
					Expect(e2e.MustRun("", "kubectl", "get", "--raw", target)).To(MatchRegexp(upMetric), target)
				}
			}
		})

		It("rejects remote logins to the app database as the superuser or with a wrong password", func() {
			replicaPod := replicaPodName(namespace, 0, defaultPodCount)
			_, err := psqlOverNetwork(namespace, replicaPod, "postgres", "superuser-test-password", database, "SELECT 1")
			Expect(err).To(MatchError(ContainSubstring(`no pg_hba.conf entry for host`)))
			_, err = psqlOverNetwork(namespace, replicaPod, "client", "wrong-password", database, "SELECT 1")
			Expect(err).To(MatchError(ContainSubstring(`password authentication failed for user "client"`)))
			Expect(psqlOverNetwork(namespace, replicaPod, "postgres", "superuser-test-password", "postgres", "SELECT 1")).To(Equal("1"))
		})

		It("lets client use the tables, sequences and functions admin creates but not create its own", func() {
			replicaPod := replicaPodName(namespace, 0, defaultPodCount)
			_, err := psqlOverNetwork(namespace, replicaPod, "client", clientPassword, database, "CREATE TABLE client_owned (id int)")
			Expect(err).To(MatchError(ContainSubstring("permission denied for schema public")))
			// NOTE: revoke PUBLIC's default EXECUTE so only client's grant lets it run
			Expect(psqlOverNetwork(namespace, replicaPod, "admin", adminPassword, database, `CREATE TABLE admin_owned (id serial PRIMARY KEY);
				CREATE FUNCTION admin_doubled(n int) RETURNS int LANGUAGE sql RETURN n * 2;
				REVOKE EXECUTE ON FUNCTION admin_doubled FROM PUBLIC`)).Error().NotTo(HaveOccurred())
			Expect(psqlOverNetwork(namespace, replicaPod, "client", clientPassword, database,
				"INSERT INTO admin_owned DEFAULT VALUES; SELECT admin_doubled(id) FROM admin_owned")).To(Equal("2"))
		})

		It("denies a Patroni pod's certificate access to the primary's pgBackRest TLS server", func() {
			// NOTE: in the sidecar, client.crt is the Patroni pod's own identity
			output, err := execInPod(namespace, replicaPodName(namespace, 0, defaultPodCount), "pgbackrest",
				"pgbackrest", "--stanza="+clusterName(0), "--archive-check=n", "--log-level-console=warn",
				fmt.Sprintf("--pg1-host=%s.%s.svc.cluster.local", primaryServiceHost(0), namespace), "--pg1-host-type=tls",
				"--pg1-host-cert-file=/etc/pgbackrest/certs/client.crt", "--pg1-host-key-file=/etc/pgbackrest/certs/client.key",
				"--pg1-host-ca-file=/etc/pgbackrest/certs/ca.crt", "check")
			Expect(err).To(HaveOccurred())
			// NOTE: check warns with the server's AccessError, then fails as it found no database
			Expect(output).To(MatchRegexp(`\[AccessError\].*access denied`))
		})
	})

	Context("failures", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(postgresChartDirectory, 1, nil)
			Expect(psqlOverNetwork(namespace, podName(0, 0), "admin", adminPassword, database, "CREATE TABLE e2e_writes (id int PRIMARY KEY)")).Error().NotTo(HaveOccurred())
		})

		It("fails over when the primary pod is deleted gracefully, keeping every acknowledged write", func() {
			clientPod := replicaPodName(namespace, 0, defaultPodCount)
			writes := writeThroughPrimaryDeletion(namespace, func(sql string) (string, error) {
				return psqlOverNetwork(namespace, clientPod, "client", clientPassword, database, sql)
			})
			expectBriefWriteUnavailability(writes, "write unavailability on primary deletion")
			expectAcknowledgedWritesKept(namespace, writes)
		})

		It("brings the old primary back as a streaming replica", func() {
			waitForHealthyShard(namespace, 0, defaultPodCount)
			Eventually(expectReplicationSlots).WithArguments(namespace, 0, defaultPodCount).Should(Succeed())
		})

		It("catches up a deleted replica on the writes it missed", func() {
			replicaPod := replicaPodName(namespace, 0, defaultPodCount)
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", replicaPod)
			insertRows(namespace, 0, 1, 1000)
			waitForHealthyShard(namespace, 0, defaultPodCount)
			Eventually(expectRows).WithArguments(namespace, replicaPod, 1, 1000).Should(Succeed())
		})

		It("keeps the data when every pod is deleted at once while pod 0 leads", func() {
			// TODO: OrderedReady deadlocks when the primary isn't pod 0; #320 removes this switchover
			if mustPrimaryPodName(namespace, 0) != podName(0, 0) {
				switchover(namespace, 0, podName(0, 0))
				waitForHealthyShard(namespace, 0, defaultPodCount)
			}
			writeCount := mustPsqlOnPrimary(namespace, 0, "SELECT count(*) FROM e2e_writes")
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", "-l", "cluster-name="+clusterName(0))
			waitForHealthyShard(namespace, 0, defaultPodCount)
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 1000)
			Expect(psqlOnPrimary(namespace, 0, "SELECT count(*) FROM e2e_writes")).To(Equal(writeCount))
		})

		It("restarts a replica's killed Postgres and catches it up on the writes it missed", func() {
			replicaPod := replicaPodName(namespace, 0, defaultPodCount)
			podState := func() string {
				return e2e.MustRun("", "kubectl", "-n", namespace, "get", "pod", replicaPod,
					"-o", `jsonpath={.metadata.uid} {.status.containerStatuses[?(@.name=="patroni")].restartCount}`)
			}
			podStateBeforeKill := podState()
			startTime, err := psql(namespace, replicaPod, "SELECT pg_postmaster_start_time()")
			Expect(err).NotTo(HaveOccurred())
			Expect(execInPod(namespace, replicaPod, "patroni", "sh", "-c",
				`kill -KILL "$(head -n 1 /var/lib/postgresql/pgdata/postmaster.pid)"`)).Error().NotTo(HaveOccurred())
			insertRows(namespace, 0, 1001, 2000)
			Eventually(psql).WithArguments(namespace, replicaPod, "SELECT pg_postmaster_start_time()").Should(Not(Equal(startTime)))
			waitForHealthyShard(namespace, 0, defaultPodCount)
			Eventually(expectRows).WithArguments(namespace, replicaPod, 1, 2000).Should(Succeed())
			Expect(podState()).To(Equal(podStateBeforeKill), "Postgres came back with a new pod or container, not from Patroni")
		})
	})

	Context("planned operations", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(postgresChartDirectory, 1, nil)
			insertRows(namespace, 0, 1, 1000)
		})

		It("switches over to the candidate with the README's patronictl command", func() {
			oldPrimaryPod := mustPrimaryPodName(namespace, 0)
			switchover(namespace, 0, replicaPodName(namespace, 0, defaultPodCount))
			waitForHealthyShard(namespace, 0, defaultPodCount)
			insertRows(namespace, 0, 1001, 2000)
			Eventually(expectRows).WithArguments(namespace, oldPrimaryPod, 1, 2000).Should(Succeed())
		})

		It("adds a replica cloned by pgBackRest that catches up when replicasPerShard goes up", func() {
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.replicasPerShard": "4"})
			waitForHealthyShard(namespace, 0, 4)
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "logs", podName(0, 3), "-c", "patroni")).
				To(ContainSubstring("replica has been created using pgbackrest"))
			Eventually(expectReplicationSlots).WithArguments(namespace, 0, 4).Should(Succeed())
			Eventually(expectRows).WithArguments(namespace, podName(0, 3), 1, 2000).Should(Succeed())
		})

		It("removes the highest pod cleanly and keeps its PVCs when replicasPerShard goes down", func() {
			// NOTE: put the leader on the pod being removed, then follow the README and switch over off it
			switchover(namespace, 0, podName(0, 3))
			waitForHealthyShard(namespace, 0, 4)
			switchover(namespace, 0, podName(0, 0))
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.replicasPerShard": "3"})
			waitForHealthyShard(namespace, 0, 3)
			// NOTE: Patroni retains a removed member's inactive slot for member_slots_ttl (30m)
			Eventually(expectReplicationSlots).WithArguments(namespace, 0, 3).Should(Succeed())
			insertRows(namespace, 0, 2001, 3000)
			expectRowsOnEveryPod(namespace, 0, 3, 1, 3000)
			e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=delete", "pod/"+podName(0, 3), "--timeout=2m")
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pvc",
				"patroni-data-"+podName(0, 3), "patroni-wal-archives-"+podName(0, 3),
				"-o", "jsonpath={.items[*].metadata.deletionTimestamp}{.items[*].metadata.ownerReferences}")).
				To(BeEmpty(), "a PVC is being deleted or has an ownerReference")
		})
	})

	Context("backups and restores", Ordered, func() {
		var namespace, backupPath string
		var lastRowID int

		BeforeAll(func() {
			backupPath = newBackupPath()
			namespace = installPostgresWithRowsTable(postgresChartDirectory, 1, map[string]string{"backup.path": backupPath})
			lastRowID = 1000
			insertRows(namespace, 0, 1, lastRowID)
		})

		It("takes full, differential and incremental backups from the CronJobs", func() {
			for _, backupType := range []string{"full", "diff", "incr"} {
				runBackupJob(namespace, 0, backupType, "manual-"+backupType)
			}
			info := readStanzaInfo(Default, namespace, 0)
			Expect(backupTypes(info)).To(Equal([]string{"full", "full", "diff", "incr"}))
			expectValidBackups(Default, namespace, 0)
		})

		It("retries a backup whose primary fails over mid-run until it completes", func() {
			oldPrimaryPod := mustPrimaryPodName(namespace, 0)
			var replicaPods []string
			for podIndex := range defaultPodCount {
				if podName(0, podIndex) != oldPrimaryPod {
					replicaPods = append(replicaPods, podName(0, podIndex))
				}
			}
			// NOTE: replicas hold this commit an hour (a promotion skips it), so the backup waits on them
			Expect(execInPod(namespace, oldPrimaryPod, "patroni", "patronictl", "-c", patroniConfig, "edit-config", "--force",
				"--set", "postgresql.recovery_conf.recovery_min_apply_delay=1h")).Error().NotTo(HaveOccurred())
			for _, replicaPod := range replicaPods {
				Eventually(psql).WithArguments(namespace, replicaPod, "SHOW recovery_min_apply_delay").Should(Equal("1h"))
			}
			lastRowID++
			insertRows(namespace, 0, lastRowID, lastRowID)
			startBackupJob(namespace, 0, "full", "failover-full")
			Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "logs", "job/failover-full").
				Should(ContainSubstring("wait for replay on the standby"))
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "logs", "job/failover-full")).
				To(MatchRegexp(`wait for replay on the standby.*\n$`), "the backup's first attempt stopped waiting before the delete")
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "job-name=failover-full",
				"-o", "jsonpath={.items[*].status.containerStatuses[0].restartCount}")).To(Equal("0"), "the backup's first attempt ended before the delete")
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", oldPrimaryPod, "--wait=false")
			Eventually(primaryPodName).WithArguments(namespace, 0).WithTimeout(2 * time.Minute).Should(BeElementOf(replicaPods))
			Expect(execInPod(namespace, mustPrimaryPodName(namespace, 0), "patroni", "patronictl", "-c", patroniConfig, "edit-config", "--force",
				"--set", "postgresql.recovery_conf.recovery_min_apply_delay=null")).Error().NotTo(HaveOccurred())

			e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=condition=Complete", "job/failover-full", "--timeout=8m")
			restartCount := e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "job-name=failover-full",
				"-o", "jsonpath={.items[*].status.containerStatuses[0].restartCount}")
			Expect(strconv.Atoi(restartCount)).To(BeNumerically(">=", 1), "the backup's first attempt wasn't interrupted")
			waitForHealthyShard(namespace, 0, defaultPodCount)
		})

		It("passes pgbackrest verify", func() {
			verifyOutput, err := execInPod(namespace, mustPrimaryPodName(namespace, 0), "patroni",
				"pgbackrest", "--stanza="+clusterName(0), "--output=text", "--verbose", "verify")
			Expect(err).NotTo(HaveOccurred())
			// NOTE: verify exits 0 on an invalid backup too, and only its summary says "status: error"
			Expect(verifyOutput).To(MatchRegexp(`(?m)^status: ok$`))
		})

		It("bootstraps a new cluster from the stanza's backups and WAL", func() {
			insertRows(namespace, 0, lastRowID+1, lastRowID+1000)
			lastRowID += 1000
			walSegment := switchWAL(namespace, 0)
			Eventually(expectArchived).WithArguments(namespace, 0, walSegment).Should(Succeed())
			// NOTE: two live shards can't share a stanza, so stop the source first
			e2e.MustRun("", "kubectl", "-n", namespace, "scale", "statefulset", statefulSetName(0), "--replicas=0")
			e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=delete", "pod", "-l", "cluster-name="+clusterName(0), "--timeout=120s")

			restoredNamespace := installPostgres(postgresChartDirectory, 1, map[string]string{"backup.path": backupPath})
			waitForHealthyShard(restoredNamespace, 0, defaultPodCount)
			expectRowsOnEveryPod(restoredNamespace, 0, defaultPodCount, 1, lastRowID)
			walSegment = switchWAL(restoredNamespace, 0)
			Eventually(expectArchived).WithArguments(restoredNamespace, 0, walSegment).Should(Succeed())
		})
	})

	Context("backup retention", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installPostgres(postgresChartDirectory, 1, map[string]string{"backup.retention.full": "2", "backup.retention.diff": "1"})
			waitForHealthyShard(namespace, 0, defaultPodCount)
		})

		It("expires the older differential backup once backup.retention.diff is exceeded", func() {
			runBackupJob(namespace, 0, "diff", "first-diff")
			beforeExpiry := readStanzaInfo(Default, namespace, 0)
			Expect(backupTypes(beforeExpiry)).To(Equal([]string{"full", "diff"}))

			runBackupJob(namespace, 0, "diff", "second-diff")
			afterExpiry := readStanzaInfo(Default, namespace, 0)
			Expect(backupTypes(afterExpiry)).To(Equal([]string{"full", "diff"}))
			Expect(afterExpiry.Backup[0].Label).To(Equal(beforeExpiry.Backup[0].Label))
			Expect(afterExpiry.Backup[1].Label).NotTo(Equal(beforeExpiry.Backup[1].Label), "the first diff backup wasn't the one expired")
			expectValidBackups(Default, namespace, 0)
		})

		It("expires the oldest full backup and its WAL once backup.retention.full is exceeded", func() {
			// NOTE: pgBackRest counts full backups toward retention.diff, so this one expires the diff
			runBackupJob(namespace, 0, "full", "second-full")
			beforeExpiry := readStanzaInfo(Default, namespace, 0)
			Expect(backupTypes(beforeExpiry)).To(Equal([]string{"full", "full"}))

			runBackupJob(namespace, 0, "full", "third-full")
			afterExpiry := readStanzaInfo(Default, namespace, 0)
			Expect(backupTypes(afterExpiry)).To(Equal([]string{"full", "full"}))
			Expect(afterExpiry.Backup[0].Label).To(Equal(beforeExpiry.Backup[1].Label), "the bootstrap full backup wasn't the one expired")
			expectValidBackups(Default, namespace, 0)
			oldestKeptWAL := afterExpiry.Backup[0].Archive.Start
			Expect(beforeExpiry.Archive[0].Min < oldestKeptWAL).To(BeTrue(), "the repo had no WAL older than the backup that's now oldest")
			Expect(afterExpiry.Archive[0].Min).To(Equal(oldestKeptWAL), "the expired backup's WAL is still in the repo")
		})
	})

	Context("from main's published chart", Ordered, func() {
		var namespace string
		var mainExporterMemoryRequests []string

		exporterMemoryRequests := func() []string {
			return strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "cluster-name="+clusterName(0),
				"-o", `jsonpath={.items[*].spec.containers[?(@.name=="postgres-exporter")].resources.requests.memory}`))
		}

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(publishedPostgresChart, 1, nil)
			mainExporterMemoryRequests = exporterMemoryRequests()
			insertRows(namespace, 0, 1, 1000)
		})

		It("keeps the data, writes and backups when upgraded to this chart and its images", func() {
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, imageValues(patroniImage, pgbackrestImage))
			e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(0), "--timeout=10m")
			waitForHealthyShard(namespace, 0, defaultPodCount)
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 1000)
			insertRows(namespace, 0, 1001, 2000)
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 2000)
			runBackupJob(namespace, 0, "full", "upgraded-full")
			Expect(backupTypes(readStanzaInfo(Default, namespace, 0))).To(Equal([]string{"full", "full"}))
			expectValidBackups(Default, namespace, 0)
		})

		It("rolls every pod back to main's chart and keeps the data when the change is reverted on main", func() {
			changedMemoryRequest := "64Mi"
			if slices.Contains(mainExporterMemoryRequests, changedMemoryRequest) {
				changedMemoryRequest = "65Mi"
			}
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.resources.postgresExporter.requests.memory": changedMemoryRequest})
			e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(0), "--timeout=10m")
			Expect(exporterMemoryRequests()).To(Equal(slices.Repeat([]string{changedMemoryRequest}, defaultPodCount)))
			changedPodUIDs := podUIDs(namespace, 0)

			// NOTE: helm-controller applies a git revert via helm upgrade, not helm rollback
			mainValues := e2e.MustRun("", "helm", "-n", namespace, "get", "values", "postgres", "--revision=1", "-o", "yaml")
			e2e.MustRun(mainValues, "helm", "-n", namespace, "upgrade", "postgres", publishedPostgresChart, "--reset-values", "-f", "-", "--timeout=5m")
			e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(0), "--timeout=10m")
			Expect(podUIDs(namespace, 0)).NotTo(ContainElement(BeElementOf(changedPodUIDs)))
			Expect(exporterMemoryRequests()).To(Equal(mainExporterMemoryRequests), "a pod still runs the reverted change")

			waitForHealthyShard(namespace, 0, defaultPodCount)
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 2000)
			insertRows(namespace, 0, 2001, 3000)
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 3000)
		})
	})

	Context("after helm uninstall", Ordered, func() {
		var namespace, installValues string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(postgresChartDirectory, 1, nil)
			installValues = e2e.MustRun("", "helm", "-n", namespace, "get", "values", "postgres", "-o", "yaml")
			insertRows(namespace, 0, 1, 1000)
			walSegment := switchWAL(namespace, 0)
			Eventually(expectArchived).WithArguments(namespace, 0, walSegment).Should(Succeed())
		})

		It("keeps every pod's PVCs", func() {
			e2e.MustRun("", "helm", "-n", namespace, "uninstall", "postgres", "--wait")
			e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=delete", "pod", "-l", "cluster-name="+clusterName(0), "--timeout=2m")
			Expect(strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pvc", "-l", "cluster-name="+clusterName(0), "-o", "name"))).
				To(HaveLen(2 * defaultPodCount))
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pvc", "-l", "cluster-name="+clusterName(0),
				"-o", "jsonpath={.items[*].metadata.deletionTimestamp}{.items[*].metadata.ownerReferences}")).
				To(BeEmpty(), "a PVC is being deleted or has an ownerReference")
		})

		It("restores the stanza on a reinstall without the PVCs once the README's stale endpoints fix is applied", func() {
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pvc", "-l", "cluster-name="+clusterName(0))
			e2e.MustRun(installValues, "helm", "-n", namespace, "install", "postgres", postgresChartDirectory, "-f", "-", "--timeout=5m")
			Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "logs", podName(0, 0), "-c", "patroni").
				WithTimeout(3*time.Minute).Should(ContainSubstring("waiting for leader to bootstrap"), "the stale endpoints didn't block the bootstrap")

			// TODO: a starting kube-controller-manager deletes Service-less endpoints; the README's fix lacks --ignore-not-found until #320
			e2e.MustRun("", "kubectl", "delete", "endpoints", clusterName(0), clusterName(0)+"-config", "-n", namespace, "--ignore-not-found")
			e2e.MustRun("", "kubectl", "delete", "pods", "-n", namespace, "-l", fmt.Sprintf("cluster-name in (%s)", clusterName(0)))
			waitForHealthyShard(namespace, 0, defaultPodCount)
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 1000)
		})
	})

	Context("scaling shards behind PgDog", Ordered, func() {
		const shardedRowCount = 20
		var namespace, clientPod string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(postgresChartDirectory, 1, map[string]string{
				"pgdog.shardedTables[0].database": database,
				"pgdog.shardedTables[0].name":     "e2e_users",
				"pgdog.shardedTables[0].column":   "id",
				"pgdog.shardedTables[0].dataType": "bigint",
			})
			insertRows(namespace, 0, 1, 1000)
			clientPod = replicaPodName(namespace, 0, defaultPodCount)
			startPgDog(namespace, 1)
		})

		It("bootstraps an added shard with its own stanza and full backup, leaving shard 0 untouched", func() {
			shard0PodUIDs := podUIDs(namespace, 0)
			shard0Backups := readStanzaInfo(Default, namespace, 0).Backup
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.shards": "2"})
			waitForHealthyShard(namespace, 1, defaultPodCount)
			info := readStanzaInfo(Default, namespace, 1)
			Expect(info.Status.Message).To(Equal("ok"))
			Expect(backupTypes(info)).To(Equal([]string{"full"}))
			Expect(mustPsqlOnPrimary(namespace, 1, "SELECT to_regclass('e2e_rows') IS NULL")).To(Equal("t"), "shard 1 started from shard 0's data")

			Expect(podUIDs(namespace, 0)).To(ConsistOf(shard0PodUIDs))
			Expect(readStanzaInfo(Default, namespace, 0).Backup).To(Equal(shard0Backups))
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 1000)
		})

		It("routes each sharded row to one shard once PgDog restarts with Adding Shards' Step 3", func() {
			for shard := range 2 {
				mustPsqlOnPrimary(namespace, shard, "SET ROLE admin; CREATE TABLE e2e_users (id bigint PRIMARY KEY)")
			}
			restartPgDog(namespace, 2)
			shardsByPrimaryIP := map[string]int{}
			for shard := range 2 {
				shardsByPrimaryIP[podIP(namespace, mustPrimaryPodName(namespace, shard))] = shard
			}
			waitForPgDogWrites(namespace, clientPod, shardedRowCount)

			idsByShard := map[int][]string{}
			for id := 1; id <= shardedRowCount; id++ {
				serverIP, err := psqlThroughPgDog(namespace, clientPod, fmt.Sprintf("INSERT INTO e2e_users VALUES (%d) RETURNING host(inet_server_addr())", id))
				Expect(err).NotTo(HaveOccurred())
				Expect(shardsByPrimaryIP).To(HaveKey(serverIP), "the insert didn't reach a primary")
				idsByShard[shardsByPrimaryIP[serverIP]] = append(idsByShard[shardsByPrimaryIP[serverIP]], strconv.Itoa(id))
			}
			Expect(idsByShard).To(HaveLen(2), "every row went to one shard")
			for shard, ids := range idsByShard {
				for podIndex := range defaultPodCount {
					Eventually(psql).WithArguments(namespace, podName(shard, podIndex), "SELECT string_agg(id::text, ',' ORDER BY id) FROM e2e_users").
						Should(Equal(strings.Join(ids, ",")))
				}
				shardIPs := strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "cluster-name="+clusterName(shard),
					"-o", "jsonpath={.items[*].status.podIP}"))
				for _, id := range ids {
					Expect(psqlThroughPgDog(namespace, clientPod, "SELECT host(inet_server_addr()) FROM e2e_users WHERE id = "+id)).To(BeElementOf(shardIPs))
				}
			}
		})

		It("removes a shard with the README's steps and keeps its backups in the bucket", func() {
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.shards": "1"})
			e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=delete", "pod", "-l", "cluster-name="+clusterName(1), "--timeout=2m")
			waitForHealthyShard(namespace, 0, defaultPodCount)
			restartPgDog(namespace, 1)

			mustPsqlOnPrimary(namespace, 0, "DELETE FROM e2e_users")
			waitForPgDogWrites(namespace, clientPod, shardedRowCount)
			for id := 1; id <= shardedRowCount; id++ {
				Expect(psqlThroughPgDog(namespace, clientPod, fmt.Sprintf("INSERT INTO e2e_users VALUES (%d)", id))).Error().NotTo(HaveOccurred())
			}
			for podIndex := range defaultPodCount {
				Eventually(psql).WithArguments(namespace, podName(0, podIndex), "SELECT count(*) FROM e2e_users").Should(Equal(strconv.Itoa(shardedRowCount)))
			}
			for id := 1; id <= shardedRowCount; id++ {
				Expect(psqlThroughPgDog(namespace, clientPod, fmt.Sprintf("SELECT id FROM e2e_users WHERE id = %d", id))).To(Equal(strconv.Itoa(id)))
			}

			// TODO: kube-controller-manager races Removing Shards' Step 3, which lacks --ignore-not-found until #320
			e2e.MustRun("", "kubectl", "delete", "endpoints", clusterName(1), clusterName(1)+"-config", "-n", namespace, "--ignore-not-found")
			e2e.MustRun("", "kubectl", "delete", "secret", statefulSetName(1)+"-tls", clusterName(1)+"-pgbackrest-backup-tls", "-n", namespace)
			e2e.MustRun("", "kubectl", "delete", "pvc", "-n", namespace, "-l", "cluster-name="+clusterName(1))

			removedStanzaJSON, err := execInPod(namespace, mustPrimaryPodName(namespace, 0), "patroni", "pgbackrest", "--stanza="+clusterName(1), "info", "--output=json")
			Expect(err).NotTo(HaveOccurred())
			var removedStanza []stanzaInfo
			Expect(json.Unmarshal([]byte(removedStanzaJSON), &removedStanza)).To(Succeed())
			Expect(removedStanza).To(HaveLen(1))
			Expect(backupTypes(removedStanza[0])).To(Equal([]string{"full"}), "the removed shard's backups aren't in the bucket")
		})
	})
})
