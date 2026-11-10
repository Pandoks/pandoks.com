FROM golang:1.27.3-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS builder

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
