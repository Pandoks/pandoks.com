FROM --platform=$BUILDPLATFORM golang:1.26.5-trixie AS builder

WORKDIR /src

COPY packages/queueworker/go.mod packages/queueworker/go.sum packages/queueworker/
COPY apps/workers/go.mod apps/workers/go.sum apps/workers/
WORKDIR /src/apps/workers
RUN go mod download

WORKDIR /src
COPY packages/queueworker packages/queueworker
COPY apps/workers/queue-runtime apps/workers/queue-runtime
WORKDIR /src/apps/workers
RUN go test ./...

ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
  go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/queue-runtime ./queue-runtime

FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder --chown=65532:65532 /out/queue-runtime /queue-runtime

USER 65532:65532
ENTRYPOINT ["/queue-runtime"]
