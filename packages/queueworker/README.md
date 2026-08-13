# Queue worker

`queueworker` is the transport-neutral Go core for at-least-once pipelines.

```text
producer -> input adapter -> runner -> handler -> output adapter -> next queue
                                         |
                                         +-> success/discard: acknowledge input
                                         +-> failure: retry input
```

The package owns polling, bounded concurrency, handler deadlines, cancellation,
panic recovery, settlement, generic publishing, and generic structured logs.
Adapters own provider API limits and delivery leases. Application packages own
job schemas and business logic.

## Adapters

| Transport         | Consume                | Publish            | Default batching | Retry and DLQ                                |
| ----------------- | ---------------------- | ------------------ | ---------------- | -------------------------------------------- |
| SQS               | Long poll              | `SendMessageBatch` | 10               | Visibility timeout and queue redrive policy  |
| Valkey            | Streams consumer group | pipelined `XADD`   | 100              | `XAUTOCLAIM` and a dead-letter stream        |
| Cloudflare Queues | HTTP pull              | REST batch push    | 100              | Explicit lease retry and provider DLQ policy |

SQS long polling defaults to 20 seconds because it minimizes empty receive
requests. Set `SQS_RETRY_DELAY` only when failed messages should be returned
before their current visibility timeout expires.

All transports are at-least-once. Handlers and downstream consumers must use a
durable message ID for idempotency. A pipeline publishes all downstream output
before acknowledging its source, so a crash or acknowledgement failure can
duplicate output but cannot silently lose it.

Keep portable payloads UTF-8 encoded and at or below 128 KB. Store larger
artifacts in object storage and queue a durable reference instead.

## Go

Go workers should normally embed the runner and implement `Handler` or
`Processor`:

```go
handler, err := queueworker.NewPipelineHandler(processor, output)
runner := queueworker.New(input, handler, queueworker.Options{})
err = runner.Run(ctx)
```

`adapter.ConfigFromEnv` and `adapter.Open` select SQS, Valkey, or Cloudflare at
runtime. `Publication.ID` correlates partial batch failures and can be used for
SQS FIFO deduplication; the payload still needs its own durable idempotency key.

## Python and TypeScript

Python and TypeScript workers run as a handler container beside the Go
`queue-runtime` container. The runtime owns queue credentials and delivery
semantics. The handler implements the versioned `runtime/v1/handler.proto`
contract and returns one of `SUCCESS`, `RETRY`, or `DISCARD` plus optional
downstream publications.

The runtime waits for the local gRPC endpoint, sends the message ID, body, and
delivery attempt, confirms downstream publications, then settles the source
message. Kubernetes should terminate both containers together and give the pod
enough grace time for the configured handler and settlement deadlines.

## Environment

An input uses `QUEUE_INPUT_`; an output uses `QUEUE_OUTPUT_`. Set the prefix's
`TRANSPORT` to `sqs`, `valkey`, or `cloudflare`.

```text
QUEUE_INPUT_TRANSPORT=sqs
QUEUE_INPUT_SQS_QUEUE_URL=...
QUEUE_INPUT_SQS_REGION=us-west-1
QUEUE_INPUT_SQS_ENDPOINT_URL=...       # LocalStack/testing only
QUEUE_INPUT_SQS_MAX_MESSAGES=10
QUEUE_INPUT_SQS_WAIT_TIME=20s
QUEUE_INPUT_SQS_VISIBILITY_TIMEOUT=60s
QUEUE_INPUT_SQS_RETRY_DELAY=0s         # optional; unset avoids an extra API call
QUEUE_INPUT_SQS_PUBLISH_BATCH_SIZE=10

QUEUE_INPUT_TRANSPORT=valkey
QUEUE_INPUT_VALKEY_ADDRESSES=host-a:6379,host-b:6379
QUEUE_INPUT_VALKEY_USERNAME=client
QUEUE_INPUT_VALKEY_PASSWORD=...
QUEUE_INPUT_VALKEY_STREAM=pipeline:{jobs}:input
QUEUE_INPUT_VALKEY_GROUP=worker-name
QUEUE_INPUT_VALKEY_CONSUMER=pod-name
QUEUE_INPUT_VALKEY_BATCH_SIZE=100
QUEUE_INPUT_VALKEY_BLOCK_TIME=5s
QUEUE_INPUT_VALKEY_VISIBILITY_TIMEOUT=60s
QUEUE_INPUT_VALKEY_MAX_DELIVERIES=5
QUEUE_INPUT_VALKEY_DLQ_STREAM=pipeline:{jobs}:input:dlq

QUEUE_INPUT_TRANSPORT=cloudflare
QUEUE_INPUT_CLOUDFLARE_ACCOUNT_ID=...
QUEUE_INPUT_CLOUDFLARE_QUEUE_ID=...
QUEUE_INPUT_CLOUDFLARE_API_TOKEN=...
QUEUE_INPUT_CLOUDFLARE_PULL_BATCH_SIZE=100
QUEUE_INPUT_CLOUDFLARE_VISIBILITY_TIMEOUT=60s
QUEUE_INPUT_CLOUDFLARE_EMPTY_POLL_DELAY=1s
QUEUE_INPUT_CLOUDFLARE_RETRY_DELAY=0s
QUEUE_INPUT_CLOUDFLARE_PUBLISH_BATCH_SIZE=100
```

Worker runtime settings are `HANDLER_GRPC_ADDRESS`, `HANDLER_READY_TIMEOUT`,
`WORKER_CONCURRENCY`, `WORKER_HANDLER_TIMEOUT`, `WORKER_POLL_ERROR_DELAY`, and
`WORKER_SETTLE_TIMEOUT`.
