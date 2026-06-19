FROM golang:1.26.4-trixie AS builder

WORKDIR /src
COPY packages/auth/go.mod packages/auth/go.sum ./
RUN go mod download

COPY packages/auth .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/auth ./main.go

FROM alpine:3.18.4@sha256:c4d6e7f38f5f9a5d5a0a8f6f8c0d0e8d4b6c7b7e6d1f2c3d4e5f6a7b8c9d

COPY --from=builder /out/auth /usr/local/bin/auth

ENTRYPOINT ["/usr/local/bin/auth"]
