FROM golang:1-trixie@sha256:d08bf3ed2bd263088ca8e23fefaf10f1b71769f6932f0a4017ba28d2a5baf001 AS builder

WORKDIR /src
COPY packages/valkey/reconciler/go.mod packages/valkey/reconciler/go.sum ./
RUN go mod download

COPY packages/valkey/reconciler .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/valkey-reconciler ./main.go

FROM valkey/valkey:8-alpine@sha256:b027235326507cfdade9b6684056ec1d0b0c0757412e628245129b5d7b788618

USER root
RUN apk upgrade --no-cache
USER valkey

COPY --from=builder /out/valkey-reconciler /usr/local/bin/valkey-reconciler

ENTRYPOINT ["/usr/local/bin/valkey-reconciler"]
