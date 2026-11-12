package postgres_test

import (
	"crypto/rand"
	"e2e"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

const (
	postgresChartDirectory = "../chart"
	database               = "app"
	adminPassword          = "admin-test-password"
	clientPassword         = "client-test-password"
	patroniConfig          = "/etc/patroni/patroni.yaml"
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

// installPostgres installs the chart with its stanzas under backupPath, so a second install with
// the same path bootstraps from the first one's backups.
func installPostgres(backupPath string, shardCount int) string {
	GinkgoHelper()
	chartValues := map[string]string{
		"db":                        database,
		"patroni.shards":            strconv.Itoa(shardCount),
		"credentials.secret":        "postgres-creds",
		"backup.credentials.secret": "postgres-creds",
		"backup.path":               backupPath,
		"backup.encryptionKey":      "e2e-encryption-key",
		// NOTE: February 30th never comes, so no scheduled backup lands among the specs' own
		"backup.schedules.full": "0 0 30 2 *",
		"backup.schedules.diff": "0 0 30 2 *",
		"backup.schedules.incr": "0 0 30 2 *",
		// NOTE: no spec goes through PgDog, so don't pull its image
		"pgdog.replicas": "0",
	}
	if patroniImage != "" {
		chartValues["patroni.image"] = patroniImage
	}
	if pgbackrestImage != "" {
		chartValues["backup.image"] = pgbackrestImage
	}
	return e2e.InstallChart("postgres", postgresChartDirectory, map[string]string{
		"SUPERUSER_PASSWORD":   "superuser-test-password",
		"ADMIN_PASSWORD":       adminPassword,
		"CLIENT_PASSWORD":      clientPassword,
		"REPLICATION_PASSWORD": "replication-test-password",
		"PATRONI_PASSWORD":     "patroni-test-password",
		// NOTE: S3Mock accepts any keys
		"S3_ACCESS_KEY": "e2e",
		"S3_SECRET_KEY": "e2e",
	}, chartValues)
}

// installPostgresWithRowsTable installs the chart and waits for each shard to be healthy with an
// empty e2e_rows table.
func installPostgresWithRowsTable(backupPath string, shardCount int) string {
	GinkgoHelper()
	namespace := installPostgres(backupPath, shardCount)
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
		Type  string `json:"type"`
		Label string `json:"label"`
		Error bool   `json:"error"`
	} `json:"backup"`
	Archive []struct {
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

// stopShard scales the shard to zero pods, as a restore replaces a lost cluster.
func stopShard(namespace string, shard int) {
	GinkgoHelper()
	e2e.MustRun("", "kubectl", "-n", namespace, "scale", "statefulset", statefulSetName(shard), "--replicas=0")
	e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=delete", "pod", "-l", "cluster-name="+clusterName(shard), "--timeout=120s")
}

type acknowledgedWrite struct {
	id         int
	returnedAt time.Time
}

// writeUntilStopped inserts one row at a time as client through the primary Service, recording
// each insert Postgres acknowledged, until stop closes.
func writeUntilStopped(namespace, clientPodName string, stop <-chan struct{}, acknowledged chan<- []acknowledgedWrite) {
	defer GinkgoRecover()
	var writes []acknowledgedWrite
	for id := 1; ; id++ {
		select {
		case <-stop:
			acknowledged <- writes
			return
		default:
		}
		if _, err := psqlOverNetwork(namespace, clientPodName, "client", clientPassword, database,
			fmt.Sprintf("INSERT INTO e2e_writes VALUES (%d)", id)); err == nil {
			writes = append(writes, acknowledgedWrite{id: id, returnedAt: time.Now()})
		}
	}
}

func longestGapBetweenWrites(writes []acknowledgedWrite) time.Duration {
	var longestGap time.Duration
	for writeIndex := 1; writeIndex < len(writes); writeIndex++ {
		longestGap = max(longestGap, writes[writeIndex].returnedAt.Sub(writes[writeIndex-1].returnedAt))
	}
	return longestGap
}

var _ = Describe("Postgres", Label("postgres"), func() {
	Context("two shards of three pods", Ordered, func() {
		const shardCount = 2
		var namespace string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(newBackupPath(), shardCount)
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
	})

	Context("failures", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(newBackupPath(), 1)
			Expect(psqlOverNetwork(namespace, podName(0, 0), "admin", adminPassword, database, "CREATE TABLE e2e_writes (id int PRIMARY KEY)")).Error().NotTo(HaveOccurred())
		})

		It("fails over when the primary pod is deleted gracefully, keeping every acknowledged write", func() {
			oldPrimaryPod := mustPrimaryPodName(namespace, 0)
			stopWriting := make(chan struct{})
			stopWriter := sync.OnceFunc(func() { close(stopWriting) })
			// NOTE: a failed spec skips the stopWriter call below
			DeferCleanup(stopWriter)
			acknowledgedWrites := make(chan []acknowledgedWrite, 1)
			go writeUntilStopped(namespace, replicaPodName(namespace, 0, defaultPodCount), stopWriting, acknowledgedWrites)
			time.Sleep(5 * time.Second)

			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", oldPrimaryPod)
			Eventually(primaryPodName).WithArguments(namespace, 0).WithTimeout(2 * time.Minute).
				Should(And(Not(BeEmpty()), Not(Equal(oldPrimaryPod))))
			time.Sleep(10 * time.Second)
			stopWriter()
			writes := <-acknowledgedWrites
			Expect(writes).NotTo(BeEmpty())

			writeUnavailability := longestGapBetweenWrites(writes)
			AddReportEntry("write unavailability on primary deletion", writeUnavailability.String())
			Expect(writeUnavailability).To(BeNumerically("<", 30*time.Second))
			Expect(writes[len(writes)-1].returnedAt).To(BeTemporally(">", time.Now().Add(-5*time.Second)), "writes didn't resume")
			acknowledgedIDs := make([]string, len(writes))
			for writeIndex, write := range writes {
				acknowledgedIDs[writeIndex] = strconv.Itoa(write.id)
			}
			Expect(mustPsqlOnPrimary(namespace, 0, fmt.Sprintf("SELECT count(*) FROM e2e_writes WHERE id IN (%s)",
				strings.Join(acknowledgedIDs, ",")))).To(Equal(strconv.Itoa(len(writes))), "an acknowledged write was lost")
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
	})

	Context("planned operations", Ordered, func() {
		var namespace string

		BeforeAll(func() {
			namespace = installPostgresWithRowsTable(newBackupPath(), 1)
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
			oldPodUIDs := e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "cluster-name="+clusterName(0), "-o", "jsonpath={.items[*].metadata.uid}")
			e2e.UpgradeChart(namespace, "postgres", postgresChartDirectory, map[string]string{"patroni.resources.postgresExporter.requests.memory": "64Mi"})
			e2e.MustRun("", "kubectl", "-n", namespace, "rollout", "status", "statefulset/"+statefulSetName(0), "--timeout=10m")
			newPodUIDs := e2e.MustRun("", "kubectl", "-n", namespace, "get", "pods", "-l", "cluster-name="+clusterName(0), "-o", "jsonpath={.items[*].metadata.uid}")
			Expect(strings.Fields(newPodUIDs)).NotTo(ContainElement(BeElementOf(strings.Fields(oldPodUIDs))))

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

		It("removes the highest pod cleanly when replicasPerShard goes down", func() {
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
		})
	})

	Context("backups and restores", Ordered, func() {
		var namespace, backupPath string
		var lastRowID int

		BeforeAll(func() {
			backupPath = newBackupPath()
			namespace = installPostgresWithRowsTable(backupPath, 1)
			lastRowID = 1000
			insertRows(namespace, 0, 1, lastRowID)
		})

		It("takes full, differential and incremental backups from the CronJobs", func() {
			for _, backupType := range []string{"full", "diff", "incr"} {
				startBackupJob(namespace, 0, backupType, "manual-"+backupType)
				e2e.MustRun("", "kubectl", "-n", namespace, "wait", "--for=condition=Complete", "job/manual-"+backupType, "--timeout=5m")
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
			// NOTE: the backup waits for a standby to replay past its start, so it can't finish first
			for _, replicaPod := range replicaPods {
				Expect(psql(namespace, replicaPod, "SELECT pg_wal_replay_pause()")).Error().NotTo(HaveOccurred())
			}
			startBackupJob(namespace, 0, "full", "failover-full")
			Eventually(e2e.Run).WithArguments("", "kubectl", "-n", namespace, "logs", "job/failover-full").
				Should(ContainSubstring("wait for replay on the standby"))
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", oldPrimaryPod)
			Eventually(primaryPodName).WithArguments(namespace, 0).WithTimeout(2 * time.Minute).Should(BeElementOf(replicaPods))
			newPrimaryPod := mustPrimaryPodName(namespace, 0)
			for _, replicaPod := range replicaPods {
				if replicaPod != newPrimaryPod {
					Expect(psql(namespace, replicaPod, "SELECT pg_wal_replay_resume()")).Error().NotTo(HaveOccurred())
				}
			}

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

		// TODO: un-pend once the README's PITR runbook stops Patroni from dropping pgBackRest's recovery target
		It("restores a shard to a point in time with the README's runbook", Pending, func() {
			targetRowID := lastRowID + 1000
			insertRows(namespace, 0, lastRowID+1, targetRowID)
			targetTime := mustPsqlOnPrimary(namespace, 0, "SELECT clock_timestamp()")
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
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "pod", "pitr-restore")
			e2e.MustRun("", "kubectl", "-n", namespace, "delete", "endpoints", clusterName(0), clusterName(0)+"-config")
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

			restoredNamespace := installPostgres(backupPath, 1)
			waitForHealthyShard(restoredNamespace, 0, defaultPodCount)
			expectRowsOnEveryPod(restoredNamespace, 0, defaultPodCount, 1, lastRowID)
			walSegment = switchWAL(restoredNamespace, 0)
			Eventually(expectArchived).WithArguments(restoredNamespace, 0, walSegment).Should(Succeed())
		})
	})
})
