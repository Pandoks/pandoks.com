# Push worker design

## Goal

Deliver normal notifications and live state updates from the existing K3s cluster without EAS.
Keep the server path small enough to use as the monorepo example:

```text
producer -> SQS Standard -> Go worker -> APNs or FCM -> device
                         \-> SQS dead-letter queue
```

APNs is the iOS delivery service. FCM HTTP v1 is the Android delivery service. Widget and Live
Activity rendering stays in the mobile app; this worker only transports provider payloads.

## Queue contract

Each SQS message contains one JSON job with an `id`, `provider`, and exactly one provider payload.

- APNs jobs contain a device token, topic, push type, priority, and an opaque JSON payload. The
  opaque payload supports both ordinary `aps.alert` notifications and ActivityKit
  `content-state` updates without duplicating app-specific schemas in the worker.
- FCM jobs contain either a Firebase Installation ID or legacy registration token, optional
  notification text, string data, and the small Android delivery configuration needed for live
  updates: priority, collapse key, and TTL.

The contract intentionally excludes persistence, user lookup, scheduling, and widget domain
models. Producers resolve those concerns before enqueueing.

## Worker behavior

The worker long-polls SQS for up to ten messages, sends the batch concurrently, and batch-deletes
only successful jobs. Invalid jobs and provider failures remain visible for SQS retry and eventually
move to the DLQ. This gives at-least-once delivery, so state updates should carry collapse keys and
consumers must tolerate duplicates.

One replica with at most ten in-flight sends is the initial deployment. That is enough until queue
age shows sustained backlog. Adding KEDA now would add an operator and credentials solely to scale a
low-volume example; it should be introduced only when the production queue needs queue-depth-based
autoscaling.

The process reuses one APNs HTTP/2 client and one Firebase Admin client, emits structured logs, and
shuts down through context cancellation. It has no HTTP server, database, or internal queue.

## Infrastructure

SST provisions:

- an encrypted SQS Standard queue and encrypted DLQ with a redrive policy;
- a least-privilege AWS IAM user for the external K3s consumer;
- a Google Cloud project, required APIs, Firebase project, and Firebase Android app;
- a least-privilege Firebase Cloud Messaging sender service account;
- a service-account key because the current K3s cluster has no externally usable OIDC issuer; and
- SST secrets consumed by the existing Kustomize/SST render pipeline.

Google recommends Workload Identity Federation for external production workloads. It is not used in
this first version because K3s issuer discovery/JWKS and token audiences are not configured. The
service-account key is encrypted in SST state and the Kubernetes Secret, never committed. Replace it
with federation when cluster workload identity is added.

Apple does not provide an equivalent resource API for creating the APNs p8 key. SST therefore owns
the p8 value as an input secret, while the worker reads it from a read-only Kubernetes volume.

## Deployment

`apps/push-worker` owns the Go module, tests, scratch-based image, and Kustomize resources. The
shared K3s app kustomization references it. CI tests, builds, scans, publishes, prunes, and cleans up
the image using the repository's existing GHCR workflows.

The worker runs as a non-root process with a read-only root filesystem. Only the provider credential
files are mounted. The pod needs outbound HTTPS to AWS, Apple, and Google; it has no inbound service.

## Out of scope

- registering Android installations or APNs tokens in an application database;
- adding Firebase native SDK configuration to the in-progress mobile widget branch;
- a producer API, notification preferences, scheduling, or fan-out;
- queue-depth autoscaling; and
- deploying cloud resources or the currently offline cluster.
