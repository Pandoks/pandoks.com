FROM golang:1.27.3-trixie@sha256:fbb7ae40b62ff8afe31662df570d39b4f5052ac32b90dae8e60d7657a20a74f4 AS builder

WORKDIR /src
COPY packages/valkey/reconciler/go.mod packages/valkey/reconciler/go.sum ./
RUN go mod download

COPY packages/valkey/reconciler .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/valkey-reconciler ./main.go

FROM valkey/valkey:9-alpine@sha256:48332870af354a799964c0012ae1194a0bf2bf894eb508f945810596dc2d8d11

USER root
RUN apk upgrade --no-cache
USER valkey

COPY --from=builder /out/valkey-reconciler /usr/local/bin/valkey-reconciler

ENTRYPOINT ["/usr/local/bin/valkey-reconciler"]
