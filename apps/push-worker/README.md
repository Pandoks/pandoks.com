# Push worker

The push worker consumes notification jobs from SQS and sends them directly to Apple Push Notification service (APNs) or Firebase Cloud Messaging (FCM). It has no HTTP server or database.

```text
app/backend -> SQS -> push-worker -> APNs or FCM -> device
```

SQS is a Standard queue with long polling, a dead-letter queue, and a five-attempt redrive policy. The app composes the SQS adapter and shared runner in `packages/queueworker` with its push-specific handler and APNs/FCM senders. One worker pod receives up to ten jobs at a time. Successful and permanently invalid messages are acknowledged as a batch; retryable failures remain for SQS to redeliver.

## Bootstrap

Google requires accepting the Firebase terms once in the Google/Firebase console. Then authenticate the first local deployment and create the production resources:

```sh
mise install
gcloud auth application-default login
pnpm sst deploy --stage production
```

That deployment creates the Google Cloud project, Firebase Android app, FCM sender service account, SQS queue, dead-letter queue, and narrow worker credentials. It also configures GitHub Actions to use short-lived Google Workload Identity Federation credentials.

Apple does not provide an API for creating an APNs signing key. Set the existing `.p8` key once:

```sh
pnpm sst secret set ApplePushNotificationApnsKey "$(< ~/Desktop/AuthKey_XXXXXXXXXX.p8)" --stage production
```

Update `ApplePushNotificationKeyId` and `ApplePushNotificationTeamId` only if their defaults in `infra/secrets.ts` do not match the key.

The generated Firebase Android configuration is stored as the `FirebaseGoogleServicesJson` SST secret. The Android application integration can write that value to `google-services.json` during its native build instead of committing it.

The K3s worker currently receives a generated, narrowly scoped Google service-account key because the cluster does not expose an external OIDC issuer. SST state and the rendered Kubernetes Secret protect the key. Move the cluster to Google Workload Identity Federation once it has a stable public issuer and JWKS endpoint.

Production uses an immutable image tag containing the Git tree hashes of both `apps/push-worker` and `packages/queueworker`. Identical worker inputs resolve to the same image across merge strategies; a worker or shared-runner change rolls the Deployment forward, while an unrelated monorepo commit keeps the previous image.

## Jobs

Normal iOS notification:

```json
{
  "id": "notification-123",
  "provider": "apns",
  "apns": {
    "token": "device-token",
    "topic": "com.pandoks.mobile-template",
    "pushType": "alert",
    "priority": 10,
    "payload": {
      "aps": {
        "alert": { "title": "Updated", "body": "Open the app for details." },
        "sound": "default"
      }
    }
  }
}
```

iOS Live Activity update:

```json
{
  "id": "activity-123-update-4",
  "provider": "apns",
  "apns": {
    "token": "live-activity-push-token",
    "topic": "com.pandoks.mobile-template.push-type.liveactivity",
    "pushType": "liveactivity",
    "priority": 10,
    "payload": {
      "aps": {
        "timestamp": 1784070000,
        "event": "update",
        "content-state": { "status": "arriving", "progress": 0.8 }
      }
    }
  }
}
```

Android notification or live-state update:

```json
{
  "id": "android-state-123-update-4",
  "provider": "fcm",
  "fcm": {
    "fid": "firebase-installation-id",
    "notification": { "title": "Updated", "body": "Your order is arriving." },
    "data": { "kind": "live-state", "status": "arriving", "progress": "0.8" },
    "android": { "priority": "high", "collapseKey": "order-123", "ttlSeconds": 3600 }
  }
}
```

Publish a job directly for testing:

```sh
aws sqs send-message \
  --queue-url "$(aws sqs get-queue-url --queue-name push-production --query QueueUrl --output text)" \
  --message-body file://job.json
```

New Android integrations should enqueue a Firebase Installation ID (`fid`). A legacy FCM registration `token` is also accepted during migration, but a job must contain exactly one target.

The mobile app still needs to register APNs/Live Activity and Firebase installation identities with the backend and handle incoming FCM data. On Android, the handler updates the ongoing notification or widget state; FCM is delivery, not the UI implementation. Unregistered APNs/FCM identities are logged and acknowledged immediately; transient provider failures retry through SQS.

## Scaling

Start with the single pod in `kube/push-worker.yaml`. Each long poll receives up to ten jobs and the shared runner bounds delivery concurrency at ten, while SQS buffers bursts. Track queue age, DLQ depth, provider throttling, and pod CPU before adding replicas. If queue latency becomes user-visible, add KEDA's SQS scaler with a small maximum replica count; provider throttling should reduce concurrency rather than trigger more pods.

## Local test

```sh
(cd packages/queueworker && go test -race ./...)
(cd apps/push-worker && go test -race ./...)
```
