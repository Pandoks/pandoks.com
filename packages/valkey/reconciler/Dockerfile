FROM golang:1.27.3-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS builder

WORKDIR /src
COPY packages/valkey/reconciler/go.mod packages/valkey/reconciler/go.sum ./
RUN go mod download

COPY packages/valkey/reconciler .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/valkey-reconciler ./main.go

FROM valkey/valkey:9-alpine@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b

USER root
RUN apk upgrade --no-cache
USER valkey

COPY --from=builder /out/valkey-reconciler /usr/local/bin/valkey-reconciler

ENTRYPOINT ["/usr/local/bin/valkey-reconciler"]
