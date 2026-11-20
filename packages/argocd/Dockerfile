FROM golang:1.27.4-trixie@sha256:b54b2639de8c1bfe538ec5ffc45f29b1932235ac5f6d63c059853646677112d9 AS kustomize-builder

# renovate: datasource=go depName=kustomize packageName=sigs.k8s.io/kustomize/kustomize/v5
ARG KUSTOMIZE_VERSION=v5.8.3

WORKDIR /src
RUN go mod init kustomize \
    && go get "sigs.k8s.io/kustomize/kustomize/v5@${KUSTOMIZE_VERSION}" \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o /out/kustomize sigs.k8s.io/kustomize/kustomize/v5

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    jq \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=kustomize-builder /out/kustomize /usr/local/bin/kustomize

RUN groupadd -g 999 argocd && useradd -u 999 -g 999 -m argocd

COPY --chown=999:999 packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml

USER argocd
WORKDIR /home/argocd
