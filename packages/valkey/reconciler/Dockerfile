FROM golang:1.26.5-trixie AS builder

WORKDIR /src
COPY packages/valkey/reconciler/go.mod packages/valkey/reconciler/go.sum ./
RUN go mod download

COPY packages/valkey/reconciler .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/valkey-reconciler ./main.go

FROM valkey/valkey:9-alpine@sha256:a35428eba9043cc0b79dbe54100f0c92784f2de00ad09b01182bfb1c5c83d1bd

USER root
RUN apk upgrade --no-cache
USER valkey

COPY --from=builder /out/valkey-reconciler /usr/local/bin/valkey-reconciler

ENTRYPOINT ["/usr/local/bin/valkey-reconciler"]
