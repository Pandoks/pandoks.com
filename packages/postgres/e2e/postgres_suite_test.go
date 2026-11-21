package postgres_test

import (
	"e2e"
	"flag"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var patroniImage, pgbackrestImage, previousPatroniImage, previousPgbackrestImage string

func init() {
	flag.StringVar(&patroniImage, "patroni-image", "", "Patroni image to test instead of the chart's default")
	flag.StringVar(&pgbackrestImage, "pgbackrest-image", "", "pgBackRest image to test instead of the chart's default")
	flag.StringVar(&previousPatroniImage, "previous-patroni-image", "", "Patroni image for main's published chart instead of its default")
	flag.StringVar(&previousPgbackrestImage, "previous-pgbackrest-image", "", "pgBackRest image for main's published chart instead of its default")
}

func TestPostgres(t *testing.T) {
	e2e.RunSuite(t, "Postgres e2e")
}

var _ = SynchronizedBeforeSuite(func() {
	e2e.ApplyServiceMonitorCRD()
	e2e.MustRun("", "kubectl", "apply", "-f", "../../../k3s/base/core/postgres.yaml")
	// NOTE: the chart's certificates need cert-manager and the internal CA, which a bare k3d cluster lacks
	e2e.MustRun("", "kubectl", "apply", "-f", "../../../k3s/bootstrap/core/cert-manager.yaml")
	Eventually(e2e.Run).WithArguments("", "kubectl", "-n", "cert-manager", "rollout", "status", "deployment/cert-manager-webhook", "--timeout=1m").
		WithTimeout(5 * time.Minute).Should(ContainSubstring("successfully rolled out"))
	Eventually(e2e.Run).WithArguments("", "kubectl", "apply", "-f", "../../../k3s/base/core/cert-manager.yaml").
		Should(ContainSubstring("internal-ca-issuer"))
	e2e.MustRun("", "kubectl", "wait", "--for=condition=Ready", "clusterissuer/internal-ca-issuer", "--timeout=2m")
}, func() {})
