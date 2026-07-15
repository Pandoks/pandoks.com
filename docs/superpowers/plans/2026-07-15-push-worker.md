# Push worker implementation plan

> Execute this plan in the current `codex/go-push-worker` worktree. Use test-driven development for
> Go behavior and verify each infrastructure surface with its repository-native checks.

**Goal:** Add a minimal, production-shaped Go consumer that delivers SQS jobs through APNs and FCM,
plus SST and K3s infrastructure that can run it without EAS.

**Architecture:** SQS Standard and a DLQ provide at-least-once buffering. A single Go process
long-polls up to ten jobs, dispatches them concurrently to reusable APNs and Firebase clients, and
batch-deletes successes. SST provisions AWS and Firebase resources; Kustomize deploys the worker to
the existing `main` namespace.

**Stack:** Go 1.26, AWS SDK for Go v2, Firebase Admin Go SDK, `net/http` HTTP/2, SST 4/Pulumi AWS and
GCP providers, Kubernetes/Kustomize, Docker scratch image.

---

### Task 1: Specify and validate push jobs

**Files:**

- Create: `apps/push-worker/go.mod`
- Create: `apps/push-worker/job.go`
- Create: `apps/push-worker/job_test.go`

1. Write failing table tests for APNs, FCM FID, FCM legacy token, missing provider payloads, and
   invalid provider configuration.
2. Run `go test ./...` and confirm the contract tests fail for the missing implementation.
3. Implement only the job types, strict JSON decoding, and validation needed by the tests.
4. Run the tests again and confirm they pass.

### Task 2: Add provider adapters

**Files:**

- Create: `apps/push-worker/apns.go`
- Create: `apps/push-worker/apns_test.go`
- Create: `apps/push-worker/fcm.go`
- Create: `apps/push-worker/fcm_test.go`

1. Write failing APNs tests for ES256 provider-token caching, headers, success, and rejected
   responses using an HTTP test server.
2. Implement the minimal APNs client with a reused HTTP/2-capable transport.
3. Write failing FCM conversion tests for FID/token targets, notification/data payloads, priority,
   collapse key, and TTL.
4. Implement the Firebase Admin adapter and run all provider tests.

### Task 3: Add the SQS worker loop

**Files:**

- Create: `apps/push-worker/worker.go`
- Create: `apps/push-worker/worker_test.go`
- Create: `apps/push-worker/main.go`
- Create: `apps/push-worker/config.go`
- Create: `apps/push-worker/config_test.go`

1. Write failing fake-SQS tests proving ten-message long polling, concurrent dispatch, partial batch
   deletion, retry-by-non-deletion, and cancellation.
2. Implement the smallest queue and sender interfaces needed by the tests.
3. Write failing configuration tests for required queue/provider credentials and sandbox/production
   APNs selection.
4. Implement environment loading and the signal-aware main wiring.
5. Run `go test -race ./...`.

### Task 4: Add the deployable image and Kubernetes resources

**Files:**

- Create: `apps/push-worker/Dockerfile`
- Create: `apps/push-worker/kube/kustomization.yaml`
- Create: `apps/push-worker/kube/push-worker.yaml`
- Create: `apps/push-worker/README.md`
- Modify: `k3s/base/apps/kustomization.yaml`

1. Add a multi-stage, static, non-root image.
2. Add the SST-rendered Secret and one-replica Deployment with read-only credentials and a hardened
   security context.
3. Add exact example APNs/FCM queue messages and local commands to the README.
4. Render every Kustomize overlay and validate it with kubeconform.
5. Build the container and run its tests inside the builder stage.

### Task 5: Add AWS and Firebase IaC

**Files:**

- Create: `infra/push.ts`
- Modify: `infra/secrets.ts`
- Modify: `infra/kubernetes.ts`
- Modify: `sst.config.ts`

1. Add SQS/DLQ resources and least-privilege consumer IAM credentials.
2. Add the GCP provider, project APIs, Firebase project, Android app, FCM sender identity, and
   generated key.
3. Safely copy generated values into the SST secrets used by Kustomize without shell interpolation.
4. Export queue, DLQ, Firebase project, and Firebase app identifiers.
5. Run `sst install`, `pnpm check:infra`, and an SST preview without applying resources.

### Task 6: Complete repository coverage

**Files:**

- Modify: `.github/workflows/build-and-publish.yaml`
- Modify: `.github/workflows/tests.yaml`
- Modify: `.github/workflows/security.yaml`
- Modify: `.github/workflows/branch-cleanup.yaml`
- Modify: `.github/workflows/maintenance.yaml`
- Modify: `.claude/rules/architecture.md`
- Modify: `.claude/rules/workflows.md`

1. Add the worker to test, image build/publish, security scan, branch cleanup, and package cleanup
   matrices.
2. Update existing architecture and workflow coverage for the new service and commands.
3. Run actionlint, Prettier, Go formatting/linting, govulncheck, Hadolint, and relevant repository
   checks.
4. Inspect the final diff for secrets, unrelated changes, and consistency with the original dirty
   checkout.
