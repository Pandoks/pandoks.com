package valkey_test

import (
	"e2e"
	"flag"
	"testing"

	. "github.com/onsi/ginkgo/v2"
)

var valkeyImage, valkeyReconcilerImage, previousValkeyImage, previousValkeyReconcilerImage string

func init() {
	flag.StringVar(&valkeyImage, "valkey-image", "", "Valkey image to test instead of the chart's default")
	flag.StringVar(&valkeyReconcilerImage, "valkey-reconciler-image", "", "reconciler image to test instead of the chart's default")
	flag.StringVar(&previousValkeyImage, "previous-valkey-image", "", "Valkey image for chart 0.1.5 instead of its default")
	flag.StringVar(&previousValkeyReconcilerImage, "previous-valkey-reconciler-image", "", "reconciler image for chart 0.1.5 instead of its default")
}

func TestValkey(t *testing.T) {
	e2e.RunSuite(t, "Valkey e2e")
}

var _ = SynchronizedBeforeSuite(func() {
	e2e.ApplyServiceMonitorCRD()
	e2e.MustRun("", "kubectl", "apply", "-f", "../../../k3s/base/core/valkey.yaml")
}, func() {})
