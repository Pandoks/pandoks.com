FROM golang:1.27.3-trixie@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385 AS builder

WORKDIR /src
COPY packages/postgres/reconciler .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/postgres-reconciler ./main.go

FROM scratch

USER 65532:65532

COPY --from=builder /out/postgres-reconciler /usr/local/bin/postgres-reconciler

ENTRYPOINT ["/usr/local/bin/postgres-reconciler"]
