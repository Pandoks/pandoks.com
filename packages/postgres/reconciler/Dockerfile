FROM golang:1.27.4-trixie@sha256:b54b2639de8c1bfe538ec5ffc45f29b1932235ac5f6d63c059853646677112d9 AS builder

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
