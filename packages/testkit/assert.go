package testkit

import (
	"context"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/util/wait"
)

func Assert(t *testing.T, desc string, ok bool) {
	t.Helper()
	if !ok {
		t.Fatalf("FAIL: %s", desc)
	}
	t.Logf("✓ %s", desc)
}

func AssertEq(t *testing.T, desc, want, got string) {
	t.Helper()
	if want != got {
		t.Fatalf("FAIL: %s\n  want: %s\n  got:  %s", desc, want, got)
	}
	t.Logf("✓ %s", desc)
}

func AssertNe(t *testing.T, desc, a, b string) {
	t.Helper()
	if a == b {
		t.Fatalf("FAIL: %s\n  both values: %s", desc, a)
	}
	t.Logf("✓ %s", desc)
}

// WaitFor polls cond every 3s until it returns true or the timeout passes.
// cond must swallow transient errors and just report false.
func WaitFor(t *testing.T, timeout time.Duration, desc string, cond func(ctx context.Context) bool) {
	t.Helper()
	err := wait.PollUntilContextTimeout(context.Background(), 3*time.Second, timeout, true,
		func(ctx context.Context) (bool, error) { return cond(ctx), nil })
	if err != nil {
		t.Fatalf("FAIL: timed out waiting for %s", desc)
	}
	t.Logf("✓ %s", desc)
}
