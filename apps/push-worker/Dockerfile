FROM --platform=$BUILDPLATFORM golang:1.26.5-trixie AS builder

WORKDIR /src

COPY apps/push-worker/go.mod apps/push-worker/go.sum ./
RUN go mod download

COPY apps/push-worker ./
RUN go test ./...

ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
  go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/push-worker .

FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder --chown=65532:65532 /out/push-worker /push-worker

USER 65532:65532
ENTRYPOINT ["/push-worker"]
