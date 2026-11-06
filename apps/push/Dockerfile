FROM golang:1.27.3-trixie@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385 AS builder

WORKDIR /src/apps/push
COPY packages/queue /src/packages/queue
COPY apps/push/go.mod apps/push/go.sum ./
RUN go mod download

COPY apps/push .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/push .

FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/push /usr/local/bin/push

USER 65532:65532

ENTRYPOINT ["/usr/local/bin/push"]
