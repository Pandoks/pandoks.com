FROM golang:1.27.3-trixie@sha256:ce01baa8d47f3917e015fd28dad23b42b7e2332070bf85d8ae3e9c2f035ef2da AS builder

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
