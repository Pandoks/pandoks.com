FROM golang:1.27.3-trixie@sha256:fbb7ae40b62ff8afe31662df570d39b4f5052ac32b90dae8e60d7657a20a74f4 AS builder

WORKDIR /src
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
