package test

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"testkit"
	"time"
)

const (
	namespace   = "test-clickhouse"
	name        = "tch"
	serverSts   = "clickhouse-tch-shard-0"
	keeperSts   = "clickhouse-keeper-tch"
	credsSecret = "clickhouse-tch-creds"
)

type ch struct {
	*testkit.Cluster
	helm testkit.HelmRelease
}

func TestClickhouseCluster(t *testing.T) {
	c := &ch{
		Cluster: testkit.Connect(t),
		helm:    testkit.HelmRelease{Name: name, Namespace: namespace, Chart: "../chart"},
	}

	t.Logf("cleaning up any stale %s resources", namespace)
	c.cleanup(t)
	t.Cleanup(func() {
		switch {
		case t.Failed():
			t.Log("test resources left in place for inspection")
		case testkit.Keep():
			t.Log("--keep: leaving test resources in place")
		default:
			c.cleanup(t)
		}
	})

	testkit.Step(t, "install: keeper quorum, both replicas serving, cluster registered", c.install)
	testkit.Step(t, "replication: row inserted on replica 0 appears on replica 1", c.replication)
	testkit.Step(t, "pod recovery: deleted replica rejoins, not readonly, data intact", c.podRecovery)
	testkit.Step(t, "backup smoke: manual full backup lands in s3", c.backup)
}

func (c *ch) cleanup(t *testing.T) {
	c.helm.Uninstall()
	if err := c.DeleteNamespaceAndWait(context.Background(), namespace, 5*time.Minute); err != nil {
		t.Fatalf("delete namespace %s: %v", namespace, err)
	}
}

func (c *ch) install(t *testing.T) {
	ctx := context.Background()
	if err := c.EnsureNamespace(ctx, namespace); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateSecret(ctx, namespace, credsSecret, map[string]string{
		"ADMIN_PASSWORD":  "testpassword",
		"CLIENT_PASSWORD": "testpassword",
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateSecret(ctx, namespace, "backup-bucket-creds", map[string]string{
		"S3_ACCESS_KEY": "test",
		"S3_SECRET_KEY": "testsecret",
	}); err != nil {
		t.Fatal(err)
	}
	c.helm.Install(t, 10*time.Minute, map[string]string{
		"name":               name,
		"namespace":          namespace,
		"credentials.secret": credsSecret,
		"clickhouse.image":   "local-registry:5000/clickhouse:latest",
		"keeper.image":       "local-registry:5000/clickhouse-keeper:latest",
		"backup.image":       "local-registry:5000/clickhouse-backup:latest",
		"backup.bucket":      "database",
		"backup.path":        "kubernetes/test/clickhouse",
		"s3.endpoint":        "http://172.30.0.254:4566",
	})
	testkit.WaitFor(t, 5*time.Minute, "3 keeper pods ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, keeperSts, 3)
	})
	testkit.WaitFor(t, 10*time.Minute, "2 server pods ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, serverSts, 2)
	})
	testkit.WaitFor(t, 2*time.Minute, "keeper quorum reachable from server", func(ctx context.Context) bool {
		_, err := c.sql(ctx, serverSts+"-0", "SELECT count() FROM system.zookeeper WHERE path='/'")
		return err == nil
	})
	testkit.AssertEq(t, "cluster 'tch' has 2 replicas in system.clusters", "2",
		c.mustSQL(t, serverSts+"-0", "SELECT count() FROM system.clusters WHERE cluster='tch'"))
}

func (c *ch) replication(t *testing.T) {
	c.mustSQL(t, serverSts+"-0",
		"CREATE TABLE default.cluster_smoke ON CLUSTER 'tch' (id UInt32) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/cluster_smoke', '{replica}') ORDER BY id")
	c.mustSQL(t, serverSts+"-0", "INSERT INTO default.cluster_smoke VALUES (7)")
	testkit.WaitFor(t, time.Minute, "row visible on replica 1", c.rowVisible(serverSts+"-1"))
}

func (c *ch) podRecovery(t *testing.T) {
	ctx := context.Background()
	if err := c.DeletePod(ctx, namespace, serverSts+"-1"); err != nil {
		t.Fatal(err)
	}
	testkit.WaitFor(t, 5*time.Minute, "replica 1 recreated and ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, serverSts, 2)
	})
	testkit.WaitFor(t, 2*time.Minute, "no readonly replicas", func(ctx context.Context) bool {
		got, err := c.sql(ctx, serverSts+"-1", "SELECT count() FROM system.replicas WHERE is_readonly")
		return err == nil && got == "0"
	})
	testkit.Assert(t, "replicated row still present", c.rowVisible(serverSts+"-1")(context.Background()))
}

func (c *ch) backup(t *testing.T) {
	ctx := context.Background()
	if err := c.CreateJobFromCronJob(ctx, namespace, "clickhouse-tch-backup-full", "tch-backup-smoke"); err != nil {
		t.Fatal(err)
	}
	testkit.WaitFor(t, 10*time.Minute, "backup job succeeded", func(ctx context.Context) bool {
		return c.JobSucceeded(ctx, namespace, "tch-backup-smoke")
	})
	created := c.mustSQL(t, serverSts+"-0",
		"SELECT count() FROM clusterAllReplicas('tch', system.backups) WHERE status='BACKUP_CREATED'")
	n, err := strconv.Atoi(created)
	testkit.Assert(t, "system.backups reports BACKUP_CREATED", err == nil && n >= 1)

	// localstack runs as a compose container outside the cluster — docker is
	// the only way to inspect it
	out, err := exec.Command("docker", "exec", "s3", "sh", "-c",
		"awslocal s3 ls --recursive s3://database/kubernetes/test/clickhouse/").CombinedOutput()
	testkit.Assert(t, "backup objects visible in localstack s3", err == nil && strings.TrimSpace(string(out)) != "")
}

func (c *ch) mustSQL(t *testing.T, pod, query string) string {
	t.Helper()
	out, err := c.sql(context.Background(), pod, query)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (c *ch) sql(ctx context.Context, pod, query string) (string, error) {
	return c.Exec(ctx, namespace, pod, "clickhouse", "sh", "-c",
		`clickhouse-client --user admin --password "$CLICKHOUSE_ADMIN_PASSWORD" -q "`+query+`"`)
}

func (c *ch) rowVisible(pod string) func(ctx context.Context) bool {
	return func(ctx context.Context) bool {
		got, err := c.sql(ctx, pod, "SELECT id FROM default.cluster_smoke")
		return err == nil && got == "7"
	}
}
