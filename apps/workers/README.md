# Workers

```text
apps/workers/
  queue-runtime/                 Go queue/adaptor sidecar for non-Go handlers
  example-worker/
    go/                          Embedded Go queue worker
    go-handler/                  Go gRPC handler example
    python/                      Python gRPC handler example
    typescript/                  TypeScript gRPC handler example

packages/queueworker/
  adapter/                       Environment-selected adapter factory
  sqs/                           SQS consumer and publisher
  valkey/                        Valkey Streams consumer and publisher
  cloudflare/                    Cloudflare Queues pull consumer and publisher
  runtime/v1/                    Versioned protobuf handler contract
  runner.go                      Concurrency, timeout, cancellation, settlement
  pipeline.go                    Publish-before-ack pipeline composition
```

Use the embedded layout for Go workers. Use a two-container pod for Python or
TypeScript: one `queue-runtime` container and one application handler container
listening on port 9000. The queue runtime is the only container that receives
queue credentials.

The same worker image can be deployed repeatedly against different queues by
changing only `QUEUE_INPUT_*` and `QUEUE_OUTPUT_*`. SST-created values already
flow into Kubernetes through the repository's existing SST resource rendering;
infrastructure only needs to provide the corresponding queue URL/ID, credentials,
and transport name.

The examples echo their input to the output queue with a deterministic output
ID. Replace that logic with the worker-specific API, browser, database, or model
operation while keeping the protocol and settlement behavior unchanged.
