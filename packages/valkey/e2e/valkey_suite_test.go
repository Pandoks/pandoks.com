package valkey_test

import (
	"e2e"
	"testing"

	. "github.com/onsi/ginkgo/v2"
)

func TestValkey(t *testing.T) {
	e2e.RunSuite(t, "Valkey e2e")
}

var _ = SynchronizedBeforeSuite(func() {
	e2e.ApplyServiceMonitorCRD()
	e2e.MustRun("", "kubectl", "apply", "-f", "../../../k3s/base/core/valkey.yaml")
}, func() {})
