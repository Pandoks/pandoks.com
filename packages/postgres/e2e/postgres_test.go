package postgres_test

import (
	"crypto/rand"
	"e2e"
	"encoding/json"
	"fmt"
	"maps"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

const (
	postgresChartDirectory = "../chart"
	// NOTE: with no version, Helm installs the highest release; branches publish only prereleases
	publishedPostgresChart = "oci://ghcr.io/pandoks/charts/postgres"
	database               = "app"
	adminPassword          = "admin-test-password"
	clientPassword         = "client-test-password"
	patroniConfig          = "/etc/patroni/patroni.yaml"
	pgdogHost              = database + "-pgdog"
	// NOTE: the chart's default replicasPerShard
	defaultPodCount = 3
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

// imageValues sets each image given, so the rest keep the chart's default.
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

// installPostgres installs chart with the suite's values, then valueOverrides. Its stanzas go under
// a new backup.path unless overridden, and a second install with the first's path bootstraps from
// its backups.
func installPostgres(chart string, shardCount int, valueOverrides map[string]string) string {
	GinkgoHelper()
	chartValues := map[string]string{
		"db":                        database,
		"patroni.shards":            strconv.Itoa(shardCount),
		"credentials.secret":        "postgres-creds",
		"backup.credentials.secret": "postgres-creds",
		"backup.path":               newBackupPath(),
		"backup.encryptionKey":      "e2e-encryption-key",
		// NOTE: February 30th never comes, so no scheduled backup lands among the specs' own, and the
		// leading * is YAML's alias marker, so every install checks the chart quotes the schedules
		"backup.schedules.full": "* * 30 2 *",
		"backup.schedules.diff": "* * 30 2 *",
		"backup.schedules.incr": "* * 30 2 *",
		// NOTE: only the PgDog specs go through PgDog, so the rest don't pull its image
		"pgdog.replicas": "0",
	}
	images := imageValues(patroniImage, pgbackrestImage)
	if chart == publishedPostgresChart {
		images = imageValues(previousPatroniImage, previousPgbackrestImage)
	}
	maps.Copy(chartValues, images)
	for valueKey, value := range valueOverrides {
		chartValues[valueKey] = value
	}
	return e2e.InstallChart("postgres", chart, map[string]string{
		"SUPERUSER_PASSWORD":   "superuser-test-password",
		"ADMIN_PASSWORD":       adminPassword,
		"CLIENT_PASSWORD":      clientPassword,
		"REPLICATION_PASSWORD": "replication-test-password",
		"PATRONI_PASSWORD":     "patroni-test-password",
		// NOTE: S3Mock accepts any keys
		"S3_ACCESS_KEY": "e2e",
		"S3_SECRET_KEY": "e2e",
		"users.toml":    fmt.Sprintf("[[users]]\nname = \"client\"\ndatabase = %q\npassword = %q\n", database, clientPassword),
	}, chartValues)
}

// installPostgresWithRowsTable installs the chart and waits for each shard to be healthy with an
// empty e2e_rows table.
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

// psqlOverNetwork connects from clientPodName to the shard 0 primary Service the way an app does.
func psqlOverNetwork(namespace, clientPodName, user, password, databaseName, sql string) (string, error) {
	connection := fmt.Sprintf("host=%s user=%s password=%s dbname=%s connect_timeout=2", primaryServiceHost(0), user, password, databaseName)
	return execInPod(namespace, clientPodName, "patroni", "psql", connection, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql)
}

// psqlThroughPgDog connects from clientPodName as client to PgDog, the way the README's apps do.
func psqlThroughPgDog(namespace, clientPodName, sql string) (string, error) {
	connection := fmt.Sprintf("host=%s port=6432 user=client password=%s dbname=%s connect_timeout=2", pgdogHost, clientPassword, database)
	return execInPod(namespace, clientPodName, "patroni", "psql", connection, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql)
}

// startPgDog starts PgDog once every pod is Ready, as it bans a replica it can't resolve.
func startPgDog(namespace string, shardCount int) {
	GinkgoHelper()
	for shard := range shardCount {
		e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(shard), "--timeout=5m")
	}
	e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"pgdog.replicas": "2"})
	// NOTE: k3s's helm-controller applies PgDog's HelmChart asynchronously
	Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "wait", "--for=jsonpath={.status.readyReplicas}=2", "deployment/"+pgdogHost, "--timeout=1m").
		WithTimeout(5 * time.Minute).Should(ContainSubstring("condition met"))
}

// waitForPgDog waits for several connections in a row, so kube-proxy no longer routes to old pods.
func waitForPgDog(namespace, clientPod string) {
	GinkgoHelper()
	Eventually(func(g Gomega) {
		for range 5 {
			g.Expect(psqlThroughPgDog(namespace, clientPod, "SELECT 1")).To(Equal("1"))
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

func replicaIPs(namespace string, shard int) []string {
	GinkgoHelper()
	primaryPod := mustPrimaryPodName(namespace, shard)
	var ips []string
	for podIndex := range defaultPodCount {
		if podName(shard, podIndex) != primaryPod {
			ips = append(ips, podIP(namespace, podName(shard, podIndex)))
		}
	}
	return ips
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

// expectHealthyShard checks Patroni, Postgres and the role=primary pod label agree on one leader
// with every other pod streaming from it.
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

// expectReplicationSlots checks the primary streams to an active slot for each replica and no other.
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

// expectRows checks podName has exactly the rows firstID to lastID.
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

// switchWAL closes the current WAL segment, so it's archived, and returns its name.
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

// stopShard scales the shard to zero pods, as a restore replaces a lost cluster.
func stopShard(namespace string, shard int) {
	GinkgoHelper()
	e2e.MustRun("", "kubectl", "-n", namespace, "scale", "statefulset", statefulSetName(shard), "--replicas=0")
	e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=delete", "pod", "-l", "cluster-name="+clusterName(shard), "--timeout=120s")
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

// serviceMonitorTargets resolves a ServiceMonitor's targets as Prometheus does, as API proxy paths.
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

// writeUntilStopped inserts one row at a time into e2e_writes with psqlAsClient, recording each
// insert Postgres acknowledged, until stop closes.
func writeUntilStopped(psqlAsClient func(sql string) (string, error), stop <-chan struct{}, acknowledged chan<- []acknowledgedWrite) {
	defer GinkgoRecover()
	var writes []acknowledgedWrite
	for id := 1; ; id++ {
		select {
		case <-stop:
			acknowledged <- writes
			return
		default:
		}
		if _, err := psqlAsClient(fmt.Sprintf("INSERT INTO e2e_writes VALUES (%d)", id)); err == nil {
			writes = append(writes, acknowledgedWrite{id: id, returnedAt: time.Now()})
		}
	}
}

// writeThroughPrimaryDeletion writes with psqlAsClient while it deletes the shard 0 primary pod
// gracefully and waits for a new one, and returns the writes Postgres acknowledged.
func writeThroughPrimaryDeletion(namespace string, psqlAsClient func(sql string) (string, error)) []acknowledgedWrite {
	GinkgoHelper()
	oldPrimaryPod := mustPrimaryPodName(namespace, 0)
	stopWriting := make(chan struct{})
	stopWriter := sync.OnceFunc(func() { close(stopWriting) })
	// NOTE: a failed spec skips the stopWriter call below
	DeferCleanup(stopWriter)
	acknowledgedWrites := make(chan []acknowledgedWrite, 1)
	go writeUntilStopped(psqlAsClient, stopWriting, acknowledgedWrites)
	time.Sleep(5 * time.Second)

	e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", oldPrimaryPod)
	Eventually(primaryPodName).WithArguments(namespace, 0).WithTimeout(2 * time.Minute).
		Should(And(Not(BeEmpty()), Not(Equal(oldPrimaryPod))))
	time.Sleep(10 * time.Second)
	stopWriter()
	return <-acknowledgedWrites
}

// expectBriefWriteUnavailability reports the longest gap between writes as reportName, checks it
// stayed under maxUnavailability and writes resumed, and returns the index of the write that ended it.
func expectBriefWriteUnavailability(writes []acknowledgedWrite, reportName string, maxUnavailability time.Duration) int {
	GinkgoHelper()
	Expect(writes).NotTo(BeEmpty())
	var writeUnavailability time.Duration
	resumedWriteIndex := 0
	for writeIndex := 1; writeIndex < len(writes); writeIndex++ {
		if gap := writes[writeIndex].returnedAt.Sub(writes[writeIndex-1].returnedAt); gap > writeUnavailability {
			writeUnavailability, resumedWriteIndex = gap, writeIndex
		}
	}
	AddReportEntry(reportName, writeUnavailability.String())
	Expect(writeUnavailability).To(BeNumerically("<", maxUnavailability))
	Expect(writes[len(writes)-1].returnedAt).To(BeTemporally(">", time.Now().Add(-5*time.Second)), "writes didn't resume")
	return resumedWriteIndex
}

// expectAcknowledgedWritesKept checks the shard 0 primary has every write in writes.
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

func shardPodIPs(namespace string, shard int) []string {
	GinkgoHelper()
	return strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "cluster-name="+clusterName(shard),
		"-o", "jsonpath={.items[*].status.podIP}"))
}

var _ = Describe("Postgres", Label("postgres"), func() {
	// NOTE: first, so its spec waiting out PgDog's 5-minute ban_timeout overlaps the rest
	Context("through PgDog", Ordered, func() {
		var namespace, clientPod string

		BeforeAll(func() {
			namespace = installPostgres(postgresChartDirectory, 1, nil)
			waitForHealthyShard(namespace, 0, defaultPodCount)
			clientPod = replicaPodName(namespace, 0, defaultPodCount)
			Expect(psqlOverNetwork(namespace, clientPod, "admin", adminPassword, database, "CREATE TABLE e2e_writes (id int PRIMARY KEY)")).Error().NotTo(HaveOccurred())
			startPgDog(namespace, 1)
		})

		It("sends writes to the primary", func() {
			primaryIP := podIP(namespace, mustPrimaryPodName(namespace, 0))
			const upsert = "INSERT INTO e2e_writes VALUES (0) ON CONFLICT (id) DO UPDATE SET id = excluded.id RETURNING host(inet_server_addr())"
			// NOTE: waits only for PgDog's first connections; a write misrouted after that fails the spec
			Eventually(psqlThroughPgDog).WithArguments(namespace, clientPod, upsert).Should(Equal(primaryIP))
			for range 20 {
				Expect(psqlThroughPgDog(namespace, clientPod, upsert)).To(Equal(primaryIP))
			}
		})

		It("sends reads to the replicas", func() {
			// NOTE: the bootstrap leader, so the primary hasn't moved since PgDog detected the roles
			Expect(mustPrimaryPodName(namespace, 0)).To(Equal(podName(0, 0)))
			replicaIPs := replicaIPs(namespace, 0)
			for range 10 {
				Expect(psqlThroughPgDog(namespace, clientPod, "SELECT host(inet_server_addr())")).To(BeElementOf(replicaIPs))
			}
		})

		It("returns reads to a restarted replica and stops reading from the primary", func() {
			restartedPod := replicaPodName(namespace, 0, defaultPodCount)
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", restartedPod)
			waitForHealthyShard(namespace, 0, defaultPodCount)
			// NOTE: PgDog bans the pod while it's down, for up to its 5-minute default ban_timeout
			Eventually(psqlThroughPgDog).WithArguments(namespace, clientPod, "SELECT host(inet_server_addr())").
				WithTimeout(7 * time.Minute).Should(Equal(podIP(namespace, restartedPod)))
			replicaIPs := replicaIPs(namespace, 0)
			for range 10 {
				Expect(psqlThroughPgDog(namespace, clientPod, "SELECT host(inet_server_addr())")).To(BeElementOf(replicaIPs))
			}
		})

		It("reaches the new primary within 30s of a graceful primary deletion, keeping every acknowledged write", func() {
			writes := writeThroughPrimaryDeletion(namespace, func(sql string) (string, error) {
				return psqlThroughPgDog(namespace, clientPod, sql)
			})
			expectBriefWriteUnavailability(writes, "PgDog write unavailability on primary deletion", 30*time.Second)
			expectAcknowledgedWritesKept(namespace, writes)
		})
	})

	Context("two shards of three pods", Ordered, func() {
		const shardCount = 2
		var namespace string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(postgresChartDirectory, shardCount, nil)
		})

		It("keeps an active replication slot on each shard's primary for every replica", func() {
			for shard := range shardCount {
				expectReplicationSlots(Default, namespace, shard, defaultPodCount)
			}
		})

		It("replicates a shard's writes to each of its replicas", func() {
			insertRows(namespace, 0, 1, 1000)
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 1000)
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

		It("lets client use the tables admin creates but not create its own", func() {
			replicaPod := replicaPodName(namespace, 0, defaultPodCount)
			_, err := psqlOverNetwork(namespace, replicaPod, "client", clientPassword, database, "CREATE TABLE client_owned (id int)")
			Expect(err).To(MatchError(ContainSubstring("permission denied for schema public")))
			Expect(psqlOverNetwork(namespace, replicaPod, "admin", adminPassword, database, "CREATE TABLE admin_owned (id int)")).Error().NotTo(HaveOccurred())
			Expect(psqlOverNetwork(namespace, replicaPod, "client", clientPassword, database,
				"INSERT INTO admin_owned VALUES (1); SELECT count(*) FROM admin_owned")).To(Equal("1"))
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

		It("keeps the backup job's TLS key out of the Patroni pods", func() {
			for podIndex := range defaultPodCount {
				Expect(execInPod(namespace, podName(0, podIndex), "pgbackrest", "ls", "/etc/pgbackrest/certs")).
					To(Equal("ca.crt\nclient.crt\nclient.key"))
			}
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
			expectBriefWriteUnavailability(writes, "write unavailability on primary deletion", 30*time.Second)
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

		It("keeps the data when every pod is deleted at once", func() {
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

	It("fails over to one routed primary within ttl + 2 loop_wait of the primary's node freezing", Serial, func() {
		// NOTE: a frozen server node hangs the API requests k3d's load balancer sends it, so the
		// pods go on the agents
		agentNodes := strings.Fields(e2e.MustRun("", "kubectl", "get", "nodes", "-l", "!node-role.kubernetes.io/control-plane",
			"-o", "jsonpath={.items[*].metadata.name}"))
		Expect(agentNodes).To(HaveLen(defaultPodCount))
		for _, agentNode := range agentNodes {
			e2e.MustRun("", "kubectl", "label", "node", agentNode, "e2e-postgres-node=agent")
			DeferCleanup(e2e.MustRun, "", "kubectl", "label", "node", agentNode, "e2e-postgres-node-")
		}
		namespace := installPostgres(postgresChartDirectory, 1, map[string]string{"nodeSelector.e2e-postgres-node": "agent"})
		waitForHealthyShard(namespace, 0, defaultPodCount)
		clientPod := replicaPodName(namespace, 0, defaultPodCount)
		Expect(psqlOverNetwork(namespace, clientPod, "admin", adminPassword, database, "CREATE TABLE e2e_writes (id int PRIMARY KEY)")).Error().NotTo(HaveOccurred())
		// NOTE: resolved once, as CoreDNS may run on the frozen node
		primaryServiceAddress := strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "exec", clientPod, "-c", "patroni", "--",
			"getent", "hosts", primaryServiceHost(0)))[0]
		connection := fmt.Sprintf("host=%s user=client password=%s dbname=%s connect_timeout=2", primaryServiceAddress, clientPassword, database)

		stopWriting := make(chan struct{})
		stopWriter := sync.OnceFunc(func() { close(stopWriting) })
		DeferCleanup(stopWriter)
		acknowledgedWrites := make(chan []acknowledgedWrite, 1)
		// NOTE: the frozen node's kernel still acks TCP, so a query in flight when it froze never returns
		go writeUntilStopped(func(sql string) (string, error) {
			return execInPod(namespace, clientPod, "patroni", "timeout", "5", "psql", connection, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql)
		}, stopWriting, acknowledgedWrites)
		time.Sleep(5 * time.Second)

		// NOTE: k3d nodes are Docker containers named after their Kubernetes node
		frozenNode := e2e.MustRun("", "kubectl", "-n", namespace, "get", "pod", mustPrimaryPodName(namespace, 0), "-o", "jsonpath={.spec.nodeName}")
		Expect(exec.Command("docker", "pause", frozenNode).Run()).To(Succeed())
		unfreezeNode := sync.OnceFunc(func() { Expect(exec.Command("docker", "unpause", frozenNode).Run()).To(Succeed()) })
		DeferCleanup(unfreezeNode)
		// NOTE: Kubernetes marks the frozen node's pods unready after its 40s node-monitor-grace-period,
		// so a Service selecting role=primary routes to both primaries until then
		time.Sleep(90 * time.Second)
		stopWriter()
		writes := <-acknowledgedWrites

		// NOTE: files/patroni.yaml's ttl (30s) and loop_wait (10s): the frozen leader's lock expires within
		// ttl, a replica sees that within loop_wait, and promotion and routing fit in another loop_wait
		resumedWriteIndex := expectBriefWriteUnavailability(writes, "write unavailability on a primary node freeze", 50*time.Second)
		// NOTE: writeUntilStopped numbers every attempt, so an ID gap is a failed write
		Expect(writes[len(writes)-1].id-writes[resumedWriteIndex].id).To(Equal(len(writes)-1-resumedWriteIndex),
			"a write failed after the failover, so the primary Service still routed to the frozen pod")
		unfreezeNode()
		waitForHealthyShard(namespace, 0, defaultPodCount)
	})

	Context("planned operations", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(postgresChartDirectory, 1, nil)
			insertRows(namespace, 0, 1, 1000)
		})

		It("switches over to the candidate with the README's patronictl command", func() {
			oldPrimaryPod := mustPrimaryPodName(namespace, 0)
			switchover(namespace, 0, replicaPodName(namespace, 0, 3))
			waitForHealthyShard(namespace, 0, 3)
			insertRows(namespace, 0, 1001, 2000)
			Eventually(expectRows).WithArguments(namespace, oldPrimaryPod, 1, 2000).Should(Succeed())
		})

		It("rolls every pod on a pod spec change and takes writes once it finishes", func() {
			oldPodUIDs := podUIDs(namespace, 0)
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.resources.postgresExporter.requests.memory": "64Mi"})
			e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(0), "--timeout=10m")
			Expect(podUIDs(namespace, 0)).NotTo(ContainElement(BeElementOf(oldPodUIDs)))

			waitForHealthyShard(namespace, 0, 3)
			insertRows(namespace, 0, 2001, 3000)
			expectRowsOnEveryPod(namespace, 0, 3, 1, 3000)
		})

		It("adds a replica cloned by pgBackRest that catches up when replicasPerShard goes up", func() {
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.replicasPerShard": "4"})
			waitForHealthyShard(namespace, 0, 4)
			// NOTE: Patroni falls back to pg_basebackup from the primary when the pgBackRest restore fails
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "logs", podName(0, 3), "-c", "patroni")).
				To(ContainSubstring("replica has been created using pgbackrest"))
			Eventually(expectReplicationSlots).WithArguments(namespace, 0, 4).Should(Succeed())
			Eventually(expectRows).WithArguments(namespace, podName(0, 3), 1, 3000).Should(Succeed())
		})

		It("removes the highest pod cleanly and keeps its PVCs when replicasPerShard goes down", func() {
			// NOTE: put the leader on the pod being removed, then follow the README and switch over off it
			switchover(namespace, 0, podName(0, 3))
			waitForHealthyShard(namespace, 0, 4)
			switchover(namespace, 0, podName(0, 0))
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.replicasPerShard": "3"})
			waitForHealthyShard(namespace, 0, 3)
			// NOTE: Patroni keeps a removed member's slot, inactive, for member_slots_ttl (30 minutes)
			Eventually(expectReplicationSlots).WithArguments(namespace, 0, 3).Should(Succeed())
			insertRows(namespace, 0, 3001, 4000)
			expectRowsOnEveryPod(namespace, 0, 3, 1, 4000)
			e2e.MustRun("", "kubectl", "-n", namespace, "get", "pvc", "patroni-data-"+podName(0, 3), "patroni-wal-archives-"+podName(0, 3))
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
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", oldPrimaryPod, "--wait=false")
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "logs", "job/failover-full")).
				To(MatchRegexp(`wait for replay on the standby.*\n$`), "the backup's first attempt stopped waiting before the delete")
			Expect(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "job-name=failover-full",
				"-o", "jsonpath={.items[*].status.containerStatuses[0].restartCount}")).To(Equal("0"), "the backup's first attempt ended before the delete")
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

		It("restores a shard to a point in time with the README's runbook", func() {
			targetRowID := lastRowID + 1000
			insertRows(namespace, 0, lastRowID+1, targetRowID)
			targetTime := mustPsqlOnPrimary(namespace, 0, "SELECT clock_timestamp()")
			// NOTE: the newest backup is past the target, so it can't seed the restored shard's replicas,
			// and the one the restore picks still has the 1h apply delay of the previous spec's replica
			runBackupJob(namespace, 0, "full", "past-target-full")
			insertRows(namespace, 0, targetRowID+1, targetRowID+1000)
			walSegment := switchWAL(namespace, 0)
			Eventually(expectArchived).WithArguments(namespace, 0, walSegment).Should(Succeed())

			stopShard(namespace, 0)
			statefulSetJSON := e2e.MustRun("", "kubectl", "-n", namespace, "get", "statefulset", statefulSetName(0), "-o", "json")
			// NOTE: Step 3's jq program, verbatim
			recoveryPodCommand := exec.Command("jq", `. as $sts | {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "pitr-restore", namespace: .metadata.namespace },
  spec: (.spec.template.spec
    | .containers |= map(select(.name == "patroni") | .args = ["sleep", "infinity"] | del(.readinessProbe))
    | .volumes += [$sts.spec.volumeClaimTemplates[].metadata.name
        | { name: ., persistentVolumeClaim: { claimName: "\(.)-\($sts.metadata.name)-0" } }])
}`)
			recoveryPodCommand.Stdin = strings.NewReader(statefulSetJSON)
			recoveryPod, err := recoveryPodCommand.Output()
			Expect(err).NotTo(HaveOccurred())
			e2e.MustRun(string(recoveryPod), "kubectl", "apply", "-f", "-")
			e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=condition=Ready", "pod/pitr-restore", "--timeout=120s")
			e2e.MustRun("", "kubectl", "-n", namespace, "exec", "pitr-restore", "--",
				"pgbackrest", "--stanza="+clusterName(0), "--type=time", "--target="+targetTime, "--target-action=promote", "restore")
			e2e.MustRun("", "kubectl", "-n", namespace, "exec", "pitr-restore", "--",
				"pg_ctl", "start", "-D", "/var/lib/postgresql/pgdata", "-l", "/tmp/pitr-restore.log", "-o", "-c recovery_min_apply_delay=0")
			Eventually(psql).WithArguments(namespace, "pitr-restore", "SELECT pg_is_in_recovery()").Should(Equal("f"))
			e2e.MustRun("", "kubectl", "-n", namespace, "exec", "pitr-restore", "--", "pg_ctl", "stop", "-w", "-D", "/var/lib/postgresql/pgdata")
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", "pitr-restore")
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "endpoints", clusterName(0), clusterName(0)+"-config")
			for podIndex := 1; podIndex < defaultPodCount; podIndex++ {
				e2e.MustRun("", "kubectl", "delete", "pvc", "-n", namespace, "patroni-data-"+podName(0, podIndex), "patroni-wal-archives-"+podName(0, podIndex))
			}
			e2e.MustRun("", "kubectl", "-n", namespace, "scale", "statefulset", statefulSetName(0), "--replicas=1")
			e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=condition=Ready", "pod/"+podName(0, 0), "--timeout=5m")
			runBackupJob(namespace, 0, "full", "pitr-full")
			e2e.MustRun("", "kubectl", "-n", namespace, "scale", "statefulset", statefulSetName(0), fmt.Sprintf("--replicas=%d", defaultPodCount))

			waitForHealthyShard(namespace, 0, defaultPodCount)
			expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, targetRowID)
			lastRowID = targetRowID
		})

		It("bootstraps a new cluster from the stanza's backups and WAL", func() {
			insertRows(namespace, 0, lastRowID+1, lastRowID+1000)
			lastRowID += 1000
			walSegment := switchWAL(namespace, 0)
			Eventually(expectArchived).WithArguments(namespace, 0, walSegment).Should(Succeed())
			stopShard(namespace, 0)

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

	It("installs and replicates with no backup CronJobs or WAL archiving when backup.enabled is false", func() {
		namespace := installPostgresWithRowsTable(postgresChartDirectory, 1, map[string]string{"backup.enabled": "false"})
		Expect(e2e.MustRun("", "kubectl", "-n", namespace, "get", "cronjobs", "-o", "name")).To(BeEmpty())
		Expect(mustPsqlOnPrimary(namespace, 0, "SHOW archive_mode")).To(Equal("off"))
		insertRows(namespace, 0, 1, 1000)
		expectRowsOnEveryPod(namespace, 0, defaultPodCount, 1, 1000)
	})

	Context("from main's published chart", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			// NOTE: main's published chart doesn't quote the schedules
			namespace = installPostgresWithRowsTable(publishedPostgresChart, 1, map[string]string{
				"backup.schedules.full": "0 0 30 2 *",
				"backup.schedules.diff": "0 0 30 2 *",
				"backup.schedules.incr": "0 0 30 2 *",
			})
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
			exporterMemoryRequests := func() []string {
				return strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "cluster-name="+clusterName(0),
					"-o", `jsonpath={.items[*].spec.containers[?(@.name=="postgres-exporter")].resources.requests.memory}`))
			}
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.resources.postgresExporter.requests.memory": "64Mi"})
			e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(0), "--timeout=10m")
			Expect(exporterMemoryRequests()).To(Equal(slices.Repeat([]string{"64Mi"}, defaultPodCount)))
			changedPodUIDs := podUIDs(namespace, 0)

			// NOTE: a revert on main restores its chart and values, which helm-controller upgrades to
			mainValues := e2e.MustRun("", "helm", "-n", namespace, "get", "values", "postgres", "--revision=1", "-o", "yaml")
			e2e.MustRun(mainValues, "helm", "-n", namespace, "upgrade", "postgres", publishedPostgresChart, "--reset-values", "-f", "-", "--timeout=5m")
			e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(0), "--timeout=10m")
			Expect(podUIDs(namespace, 0)).NotTo(ContainElement(BeElementOf(changedPodUIDs)))
			Expect(exporterMemoryRequests()).To(BeEmpty(), "a pod still runs the reverted change")

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
		})

		It("restores the stanza on a reinstall without the PVCs once the README's stale endpoints fix is applied", func() {
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pvc", "-l", "cluster-name="+clusterName(0))
			e2e.MustRun(installValues, "helm", "-n", namespace, "install", "postgres", postgresChartDirectory, "-f", "-", "--timeout=5m")
			Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "logs", podName(0, 0), "-c", "patroni").
				WithTimeout(3*time.Minute).Should(ContainSubstring("waiting for leader to bootstrap"), "the stale endpoints didn't block the bootstrap")

			// NOTE: the README's fix, verbatim but for the names
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

		It("routes each sharded row to one shard and reads it back from that shard by its key", func() {
			for shard := range 2 {
				mustPsqlOnPrimary(namespace, shard, "SET ROLE admin; CREATE TABLE e2e_users (id bigint PRIMARY KEY)")
			}
			startPgDog(namespace, 2)
			shardsByPrimaryIP := map[string]int{}
			for shard := range 2 {
				shardsByPrimaryIP[podIP(namespace, mustPrimaryPodName(namespace, shard))] = shard
			}
			waitForPgDog(namespace, clientPod)

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
				shardIPs := shardPodIPs(namespace, shard)
				for _, id := range ids {
					Expect(psqlThroughPgDog(namespace, clientPod, "SELECT host(inet_server_addr()) FROM e2e_users WHERE id = "+id)).To(BeElementOf(shardIPs))
				}
			}
		})

		It("removes a shard with the README's steps and keeps its backups in the bucket", func() {
			// NOTE: Removing Shards' Step 1, restarting PgDog as in Adding Shards' Step 3
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.shards": "1"})
			e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=delete", "pod", "-l", "cluster-name="+clusterName(1), "--timeout=2m")
			waitForHealthyShard(namespace, 0, defaultPodCount)
			Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "get", "configmap", pgdogHost, "-o", `jsonpath={.data.pgdog\.toml}`).
				Should(And(ContainSubstring(statefulSetName(0)), Not(ContainSubstring(statefulSetName(1)))))
			oldPgDogPods := strings.Fields(e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "app.kubernetes.io/name=pgdog", "-o", "name"))
			e2e.MustRun("", "kubectl", "rollout", "restart", "deploy/"+pgdogHost, "-n", namespace)
			e2e.MustRun("", "kubectl", "rollout", "status", "deploy/"+pgdogHost, "-n", namespace, "--timeout=3m")
			e2e.MustRun("", "kubectl", append([]string{"-n", namespace, "wait", "--for=delete", "--timeout=2m"}, oldPgDogPods...)...)

			// NOTE: Step 2
			mustPsqlOnPrimary(namespace, 0, "DELETE FROM e2e_users")
			waitForPgDog(namespace, clientPod)
			for id := 1; id <= shardedRowCount; id++ {
				Expect(psqlThroughPgDog(namespace, clientPod, fmt.Sprintf("INSERT INTO e2e_users VALUES (%d)", id))).Error().NotTo(HaveOccurred())
			}
			for podIndex := range defaultPodCount {
				Eventually(psql).WithArguments(namespace, podName(0, podIndex), "SELECT count(*) FROM e2e_users").Should(Equal(strconv.Itoa(shardedRowCount)))
			}
			for id := 1; id <= shardedRowCount; id++ {
				Expect(psqlThroughPgDog(namespace, clientPod, fmt.Sprintf("SELECT id FROM e2e_users WHERE id = %d", id))).To(Equal(strconv.Itoa(id)))
			}

			// NOTE: Step 3, verbatim but for the names
			e2e.MustRun("", "kubectl", "delete", "service,endpoints", clusterName(1), clusterName(1)+"-config", "-n", namespace, "--ignore-not-found")
			e2e.MustRun("", "kubectl", "delete", "secret", statefulSetName(1)+"-tls", clusterName(1)+"-pgbackrest-backup-tls", "-n", namespace)
			e2e.MustRun("", "kubectl", "delete", "pvc", "-n", namespace, "-l", "cluster-name="+clusterName(1))

			removedStanzaJSON, err := execInPod(namespace, mustPrimaryPodName(namespace, 0), "patroni", "pgbackrest", "--stanza="+clusterName(1), "info", "--output=json")
			Expect(err).NotTo(HaveOccurred())
			var removedStanza []stanzaInfo
			Expect(json.Unmarshal([]byte(removedStanzaJSON), &removedStanza)).To(Succeed())
			Expect(removedStanza).To(HaveLen(1))
			Expect(backupTypes(removedStanza[0])).To(Equal([]string{"full"}), "the removed shard's backups aren't in the bucket")
		})

		It("leaves nothing of the removed shard after Removing Shards' Step 3", func() {
			leftovers := e2e.MustRun("", "kubectl", "-n", namespace, "get", "-o", "name",
				"all,endpoints,endpointslices,configmaps,secrets,pvc,serviceaccounts,rolebindings,certificates,certificaterequests,servicemonitors")
			Expect(strings.Fields(leftovers)).NotTo(ContainElement(ContainSubstring(clusterName(1))))
		})
	})
})
