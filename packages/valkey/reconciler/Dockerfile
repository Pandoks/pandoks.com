FROM golang:1.26.6-trixie AS builder

WORKDIR /src
COPY packages/valkey/reconciler/go.mod packages/valkey/reconciler/go.sum ./
RUN go mod download

COPY packages/valkey/reconciler .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/valkey-reconciler ./main.go

FROM valkey/valkey:9-alpine@sha256:de31910896150d5e754a07d57d227cfdde4e258ddd0d1aa4607f2d2f95843715

USER root
RUN apk upgrade --no-cache
USER valkey

COPY --from=builder /out/valkey-reconciler /usr/local/bin/valkey-reconciler

ENTRYPOINT ["/usr/local/bin/valkey-reconciler"]
