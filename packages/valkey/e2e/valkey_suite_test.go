package valkey_test

import (
	"e2e"
	"flag"
	"testing"

	. "github.com/onsi/ginkgo/v2"
)

var valkeyImage, valkeyReconcilerImage string

func init() {
	flag.StringVar(&valkeyImage, "valkey-image", "", "Valkey image to test instead of the chart's default")
	flag.StringVar(&valkeyReconcilerImage, "valkey-reconciler-image", "", "reconciler image to test instead of the chart's default")
}

func TestValkey(t *testing.T) {
	e2e.RunSuite(t, "Valkey e2e")
}

var _ = SynchronizedBeforeSuite(func() {
	e2e.ApplyServiceMonitorCRD()
	e2e.MustRun("", "kubectl", "apply", "-f", "../../../k3s/base/core/valkey.yaml")
}, func() {})
