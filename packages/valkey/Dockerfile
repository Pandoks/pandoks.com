FROM golang:1-trixie AS builder

# NOTE: only copy the go.mod and go.sum files here for better layer caching in docker
WORKDIR /src
COPY packages/valkey/go.mod packages/valkey/go.sum ./packages/valkey/
WORKDIR /src/packages/valkey
RUN go mod download

WORKDIR /src
COPY . .
WORKDIR /src/packages/valkey

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/valkey-operator ./cmd/operator

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /out/valkey-operator /manager

USER nonroot:nonroot

ENTRYPOINT ["/manager"]
