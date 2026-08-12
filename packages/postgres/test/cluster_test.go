package test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"testkit"
	"time"
)

const (
	namespace       = "test-postgres"
	db              = "tpg"
	app             = "patroni-tpg-shard-0"
	clusterName     = "tpg-shard-0"
	credsSecret     = "postgres-tpg-creds"
	appSelector     = "app=" + app
	primarySelector = "cluster-name=" + clusterName + ",role=primary"
)

type pg struct {
	*testkit.Cluster
	helm testkit.HelmRelease
}

func TestPostgresCluster(t *testing.T) {
	c := &pg{
		Cluster: testkit.Connect(t),
		helm:    testkit.HelmRelease{Name: db, Namespace: namespace, Chart: "../chart"},
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

	testkit.Step(t, "install: 3/3 ready, 1 leader + 2 streaming replicas, values live", c.install)
	testkit.Step(t, "reload-class dcs change applies live with zero pod churn", c.reloadClassZeroChurn)
	testkit.Step(t, "postmaster-class dcs change parks as pending_restart until patronictl restart", c.postmasterPendingRestart)
	testkit.Step(t, "dcs-restricted parameter is helm-manageable", c.dcsRestrictedParameter)
	testkit.Step(t, "local-map change rolls all pods", c.localMapRollsPods)
	testkit.Step(t, "failover: no data loss, old leader rejoins", c.failover)
	testkit.Step(t, "scale up to 4 members, back down to 3", c.scale)
}

func (c *pg) cleanup(t *testing.T) {
	c.helm.Uninstall()
	if err := c.DeleteNamespaceAndWait(context.Background(), namespace, 5*time.Minute); err != nil {
		t.Fatalf("delete namespace %s: %v", namespace, err)
	}
}

func (c *pg) install(t *testing.T) {
	ctx := context.Background()
	if err := c.EnsureNamespace(ctx, namespace); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateSecret(ctx, namespace, credsSecret, map[string]string{
		"SUPERUSER_PASSWORD":   "testpassword",
		"ADMIN_PASSWORD":       "testpassword",
		"CLIENT_PASSWORD":      "testpassword",
		"REPLICATION_PASSWORD": "testpassword",
		"PATRONI_PASSWORD":     "testpassword",
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateSecret(ctx, namespace, "backup-bucket-creds", map[string]string{
		"S3_ACCESS_KEY": "test",
		"S3_SECRET_KEY": "testsecret",
	}); err != nil {
		t.Fatal(err)
	}
	c.helm.Install(t, 15*time.Minute, map[string]string{
		"db":                   db,
		"namespace":            namespace,
		"credentials.secret":   credsSecret,
		"patroni.image":        "local-registry:5000/patroni:latest",
		"backup.image":         "local-registry:5000/pgbackrest:latest",
		"backup.bucket":        "database",
		"backup.path":          "kubernetes/test/postgres",
		"backup.encryptionKey": "1f2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff00",
		"s3.host":              "172.30.0.254:4566",
	})
	testkit.WaitFor(t, 10*time.Minute, "all 3 patroni pods ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, app, 3)
	})
	testkit.WaitFor(t, 2*time.Minute, "leader elected", func(ctx context.Context) bool {
		return c.leader(ctx) != ""
	})
	testkit.WaitFor(t, 2*time.Minute, "2 replicas streaming", c.streaming(2))
	testkit.WaitFor(t, time.Minute, "dcs values live (max_connections=100)", c.allShow("max_connections", "100"))
	ctx = context.Background()
	testkit.Assert(t, "shared_buffers=128MB on all pods", c.allShow("shared_buffers", "128MB")(ctx))
	testkit.Assert(t, "work_mem=4MB on all pods", c.allShow("work_mem", "4MB")(ctx))
}

func (c *pg) reloadClassZeroChurn(t *testing.T) {
	before := c.mustFingerprint(t)
	checksumBefore := c.mustChecksum(t)
	c.helm.Upgrade(t, 10*time.Minute, map[string]string{"patroni.parameters.dcs.work_mem": "8MB"})
	testkit.WaitFor(t, time.Minute, "work_mem=8MB live on all pods", c.allShow("work_mem", "8MB"))
	testkit.AssertEq(t, "pod fingerprints unchanged (zero churn)", before, c.mustFingerprint(t))
	testkit.AssertEq(t, "checksum/config annotation unchanged", checksumBefore, c.mustChecksum(t))
}

func (c *pg) postmasterPendingRestart(t *testing.T) {
	ctx := context.Background()
	before := c.mustFingerprint(t)
	c.helm.Upgrade(t, 10*time.Minute, map[string]string{"patroni.parameters.dcs.shared_buffers": "256MB"})
	testkit.WaitFor(t, 90*time.Second, "pending_restart flagged on all pods", c.allPendingRestart)
	testkit.Assert(t, "shared_buffers still 128MB before restart", c.allShow("shared_buffers", "128MB")(ctx))
	testkit.AssertEq(t, "no pod churn from upgrade", before, c.mustFingerprint(t))
	c.restartCluster(t)
	testkit.WaitFor(t, 2*time.Minute, "shared_buffers=256MB after in-place restart", c.allShow("shared_buffers", "256MB"))
	testkit.AssertEq(t, "pods restarted in place (fingerprints unchanged)", before, c.mustFingerprint(t))
}

func (c *pg) dcsRestrictedParameter(t *testing.T) {
	c.helm.Upgrade(t, 10*time.Minute, map[string]string{"patroni.parameters.dcs.max_connections": "150"})
	testkit.WaitFor(t, 90*time.Second, "pending_restart flagged on all pods", c.allPendingRestart)
	c.restartCluster(t)
	testkit.WaitFor(t, 2*time.Minute, "max_connections=150 after restart", c.allShow("max_connections", "150"))
}

func (c *pg) localMapRollsPods(t *testing.T) {
	ctx := context.Background()
	checksumBefore := c.mustChecksum(t)
	oldUIDs, err := c.PodUIDs(ctx, namespace, appSelector)
	if err != nil {
		t.Fatal(err)
	}
	c.helm.Upgrade(t, 10*time.Minute, map[string]string{"patroni.parameters.local.log_min_duration_statement": "1000"})
	testkit.AssertNe(t, "checksum/config annotation changed", checksumBefore, c.mustChecksum(t))
	testkit.WaitFor(t, 10*time.Minute, "all pods recreated and ready", func(ctx context.Context) bool {
		uids, err := c.PodUIDs(ctx, namespace, appSelector)
		if err != nil || len(uids) != 3 {
			return false
		}
		for uid := range uids {
			if oldUIDs[uid] {
				return false
			}
		}
		return c.StsReady(ctx, namespace, app, 3)
	})
	testkit.WaitFor(t, 2*time.Minute, "2 replicas streaming after roll", c.streaming(2))
	testkit.WaitFor(t, time.Minute, "log_min_duration_statement=1s on all pods", c.allShow("log_min_duration_statement", "1s"))
}

func (c *pg) failover(t *testing.T) {
	ctx := context.Background()
	leader := c.leader(ctx)
	c.mustSQL(t, leader, "create table if not exists failover_marker(id int primary key)")
	c.mustSQL(t, leader, "insert into failover_marker values (42) on conflict do nothing")
	if err := c.DeletePod(ctx, namespace, leader); err != nil {
		t.Fatal(err)
	}
	testkit.WaitFor(t, time.Minute, "new leader elected", func(ctx context.Context) bool {
		now := c.leader(ctx)
		return now != "" && now != leader
	})
	testkit.AssertEq(t, "marker row survived failover", "42", c.mustSQL(t, c.leader(ctx), "select id from failover_marker"))
	testkit.WaitFor(t, 5*time.Minute, "old leader rejoined (3/3 ready)", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, app, 3)
	})
	testkit.WaitFor(t, 2*time.Minute, "2 replicas streaming again", c.streaming(2))
}

func (c *pg) scale(t *testing.T) {
	c.helm.Upgrade(t, 10*time.Minute, map[string]string{"patroni.replicasPerShard": "4"})
	testkit.WaitFor(t, 10*time.Minute, "4th member ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, app, 4)
	})
	testkit.WaitFor(t, 2*time.Minute, "3 replicas streaming", c.streaming(3))
	testkit.WaitFor(t, time.Minute, "4 members in patronictl list", c.memberCount(4))
	c.helm.Upgrade(t, 10*time.Minute, map[string]string{"patroni.replicasPerShard": "3"})
	testkit.WaitFor(t, 5*time.Minute, "back to 3/3 ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, app, 3)
	})
	testkit.WaitFor(t, 2*time.Minute, "removed member gone from patronictl list", c.memberCount(3))
	testkit.WaitFor(t, 2*time.Minute, "2 replicas streaming", c.streaming(2))
}

func (c *pg) mustFingerprint(t *testing.T) string {
	t.Helper()
	fp, err := c.Fingerprint(context.Background(), namespace, appSelector)
	if err != nil {
		t.Fatal(err)
	}
	return fp
}

func (c *pg) mustChecksum(t *testing.T) string {
	t.Helper()
	sum, err := c.checksum(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return sum
}

func (c *pg) mustSQL(t *testing.T, pod, query string) string {
	t.Helper()
	out, err := c.sql(context.Background(), pod, query)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (c *pg) sql(ctx context.Context, pod, query string) (string, error) {
	return c.Exec(ctx, namespace, pod, "patroni", "psql", "-U", "postgres", "-d", "postgres", "-tAc", query)
}

func (c *pg) leader(ctx context.Context) string {
	names, err := c.PodNames(ctx, namespace, primarySelector)
	if err != nil || len(names) == 0 {
		return ""
	}
	return names[0]
}

func (c *pg) allShow(setting, want string) func(ctx context.Context) bool {
	return func(ctx context.Context) bool {
		pods, err := c.PodNames(ctx, namespace, appSelector)
		if err != nil || len(pods) == 0 {
			return false
		}
		for _, pod := range pods {
			got, err := c.sql(ctx, pod, "show "+setting)
			if err != nil || got != want {
				return false
			}
		}
		return true
	}
}

func (c *pg) streaming(want int) func(ctx context.Context) bool {
	return func(ctx context.Context) bool {
		leader := c.leader(ctx)
		if leader == "" {
			return false
		}
		got, err := c.sql(ctx, leader, "select count(*) from pg_stat_replication where state='streaming'")
		return err == nil && got == fmt.Sprint(want)
	}
}

func (c *pg) allPendingRestart(ctx context.Context) bool {
	pods, err := c.PodNames(ctx, namespace, appSelector)
	if err != nil || len(pods) == 0 {
		return false
	}
	for _, pod := range pods {
		raw, err := c.PodProxyGet(ctx, namespace, pod, 8008, "patroni")
		if err != nil {
			return false
		}
		var status struct {
			PendingRestart bool `json:"pending_restart"`
		}
		if json.Unmarshal(raw, &status) != nil || !status.PendingRestart {
			return false
		}
	}
	return true
}

func (c *pg) restartCluster(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	if _, err := c.Exec(ctx, namespace, c.leader(ctx), "patroni",
		"patronictl", "-c", "/etc/patroni/patroni.yaml", "restart", clusterName, "--force"); err != nil {
		t.Fatal(err)
	}
}

func (c *pg) memberCount(want int) func(ctx context.Context) bool {
	return func(ctx context.Context) bool {
		leader := c.leader(ctx)
		if leader == "" {
			return false
		}
		out, err := c.Exec(ctx, namespace, leader, "patroni",
			"patronictl", "-c", "/etc/patroni/patroni.yaml", "list", "-f", "json")
		if err != nil {
			return false
		}
		var members []json.RawMessage
		return json.Unmarshal([]byte(out), &members) == nil && len(members) == want
	}
}

func (c *pg) checksum(ctx context.Context) (string, error) {
	return c.StsPodTemplateAnnotation(ctx, namespace, app, "checksum/config")
}
