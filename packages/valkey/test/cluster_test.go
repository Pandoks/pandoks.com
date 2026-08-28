package test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"testkit"
	"time"
)

const (
	namespace   = "test-valkey"
	name        = "tvk"
	app         = "valkey-tvk"
	credsSecret = "valkey-tvk-creds"
	appSelector = "app=" + app
)

type vk struct {
	*testkit.Cluster
	helm testkit.HelmRelease
}

func TestValkeyCluster(t *testing.T) {
	c := &vk{
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

	testkit.Step(t, "install: init hook succeeds, cluster_state:ok with 2 masters + 2 replicas", c.install)
	testkit.Step(t, "failover: master pod loss recovers, manual failover promotes the replica", c.failover)
	testkit.Step(t, "scale up to 3 masters", c.scaleUp)
	testkit.Step(t, "scale down to 2 masters", c.scaleDown)
}

func (c *vk) cleanup(t *testing.T) {
	c.helm.Uninstall()
	if err := c.DeleteNamespaceAndWait(context.Background(), namespace, 5*time.Minute); err != nil {
		t.Fatalf("delete namespace %s: %v", namespace, err)
	}
}

func (c *vk) install(t *testing.T) {
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
	c.helm.Install(t, 15*time.Minute, map[string]string{
		"name":                      name,
		"namespace":                 namespace,
		"credentials.secret":        credsSecret,
		"image":                     "local-registry:5000/valkey:latest",
		"cluster.reconcilerImage":   "local-registry:5000/valkey-reconciler:latest",
		"cluster.masters":           "2",
		"cluster.replicasPerMaster": "1",
		"hooks.restartPolicy":       "Never",
		"hooks.hookDeletePolicy":    "before-hook-creation",
	})
	ctx = context.Background()
	testkit.Assert(t, "init hook job completed", c.JobSucceeded(ctx, namespace, "valkey-tvk-init"))
	testkit.WaitFor(t, 2*time.Minute, "all 4 pods ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, app, 4)
	})
	testkit.WaitFor(t, 2*time.Minute, "cluster healthy (size=2, nodes=4, slots covered)", c.healthy(4, 2))
}

func (c *vk) failover(t *testing.T) {
	ctx := context.Background()
	master := c.mustFindMaster(t)
	if err := c.DeletePod(ctx, namespace, master); err != nil {
		t.Fatal(err)
	}
	testkit.WaitFor(t, 3*time.Minute, "cluster recovered (state ok on all nodes)", c.healthy(4, 2))
	testkit.WaitFor(t, time.Minute, "2 masters + 2 replicas after recovery", c.rolesBalanced)

	master = c.mustFindMaster(t)
	replica, err := c.replicaOf(ctx, master)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.cli(ctx, replica, "cluster failover"); err != nil {
		t.Fatal(err)
	}
	testkit.WaitFor(t, time.Minute, "replica promoted to master", func(ctx context.Context) bool {
		return c.roleIs(ctx, replica, "master")
	})
	testkit.WaitFor(t, time.Minute, "old master demoted to replica", func(ctx context.Context) bool {
		return c.roleIs(ctx, master, "slave")
	})
	testkit.WaitFor(t, 2*time.Minute, "cluster healthy after failover", c.healthy(4, 2))
}

func (c *vk) scaleUp(t *testing.T) {
	c.helm.Upgrade(t, 15*time.Minute, map[string]string{"cluster.masters": "3"})
	testkit.WaitFor(t, 2*time.Minute, "6 pods ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, app, 6)
	})
	testkit.WaitFor(t, 3*time.Minute, "cluster healthy (size=3, nodes=6, slots covered)", c.healthy(6, 3))
}

func (c *vk) scaleDown(t *testing.T) {
	c.helm.Upgrade(t, 15*time.Minute, map[string]string{"cluster.masters": "2"})
	testkit.WaitFor(t, 3*time.Minute, "4 pods ready", func(ctx context.Context) bool {
		return c.StsReady(ctx, namespace, app, 4)
	})
	testkit.WaitFor(t, 3*time.Minute, "cluster healthy (size=2, nodes=4, slots covered)", c.healthy(4, 2))
}

func (c *vk) cli(ctx context.Context, pod, args string) (string, error) {
	return c.Exec(ctx, namespace, pod, "valkey", "sh", "-c",
		`valkey-cli --user admin -a "$ADMIN_PASSWORD" --no-auth-warning `+args)
}

func (c *vk) clusterInfoHas(ctx context.Context, pod, field string) bool {
	out, err := c.cli(ctx, pod, "cluster info")
	return err == nil && strings.Contains(out, field)
}

func (c *vk) roleIs(ctx context.Context, pod, role string) bool {
	out, err := c.cli(ctx, pod, "info replication")
	return err == nil && strings.Contains(strings.ReplaceAll(out, "\r", ""), "\nrole:"+role+"\n")
}

func (c *vk) mustFindMaster(t *testing.T) string {
	t.Helper()
	master, err := c.findMaster(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return master
}

func (c *vk) findMaster(ctx context.Context) (string, error) {
	pods, err := c.PodNames(ctx, namespace, appSelector)
	if err != nil {
		return "", err
	}
	for _, pod := range pods {
		if c.roleIs(ctx, pod, "master") {
			return pod, nil
		}
	}
	return "", fmt.Errorf("no master pod found in %s", namespace)
}

func (c *vk) replicaOf(ctx context.Context, master string) (string, error) {
	ip, err := c.PodIP(ctx, namespace, master)
	if err != nil {
		return "", err
	}
	pods, err := c.PodNames(ctx, namespace, appSelector)
	if err != nil {
		return "", err
	}
	for _, p := range pods {
		out, err := c.cli(ctx, p, "info replication")
		if err == nil && strings.Contains(strings.ReplaceAll(out, "\r", ""), "\nmaster_host:"+ip+"\n") {
			return p, nil
		}
	}
	return "", fmt.Errorf("no replica of %s found", master)
}

func (c *vk) roleCount(ctx context.Context, role string) int {
	pods, err := c.PodNames(ctx, namespace, appSelector)
	if err != nil {
		return -1
	}
	n := 0
	for _, pod := range pods {
		if c.roleIs(ctx, pod, role) {
			n++
		}
	}
	return n
}

func (c *vk) rolesBalanced(ctx context.Context) bool {
	return c.roleCount(ctx, "master") == 2 && c.roleCount(ctx, "slave") == 2
}

func (c *vk) healthy(nodes, size int) func(ctx context.Context) bool {
	return func(ctx context.Context) bool {
		if !c.StsReady(ctx, namespace, app, int32(nodes)) {
			return false
		}
		pods, err := c.PodNames(ctx, namespace, appSelector)
		if err != nil || len(pods) != nodes {
			return false
		}
		for _, pod := range pods {
			if !c.clusterInfoHas(ctx, pod, "cluster_state:ok") {
				return false
			}
		}
		first := pods[0]
		for _, field := range []string{
			fmt.Sprintf("cluster_size:%d", size),
			fmt.Sprintf("cluster_known_nodes:%d", nodes),
			"cluster_slots_assigned:16384",
			"cluster_slots_ok:16384",
		} {
			if !c.clusterInfoHas(ctx, first, field) {
				return false
			}
		}
		nodesOut, err := c.cli(ctx, first, "cluster nodes")
		return err == nil && !strings.Contains(nodesOut, "fail")
	}
}
