FROM golang:1.26.10-trixie@sha256:909771fef53e3dcb0950255f0c9a8b4728c3b841e61509c7b29b098de7ee02d4 AS kustomize-builder

# renovate: datasource=go depName=kustomize packageName=sigs.k8s.io/kustomize/kustomize/v5
ARG KUSTOMIZE_VERSION=v5.8.1
# TODO: drop X_TEXT_VERSION and its go get at kustomize v5.8.2, which requires x/text v0.42.0:
# https://github.com/kubernetes-sigs/kustomize/releases/tag/kustomize%2Fv5.8.2
# renovate: datasource=go depName=golang.org/x/text
ARG X_TEXT_VERSION=v0.41.0

WORKDIR /src
RUN go mod init kustomize \
    && go get "sigs.k8s.io/kustomize/kustomize/v5@${KUSTOMIZE_VERSION}" \
    "golang.org/x/text@${X_TEXT_VERSION}" \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o /out/kustomize sigs.k8s.io/kustomize/kustomize/v5

FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    bash \
    jq \
    git \
    ca-certificates \
    apache2-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/pnpm/pnpm:12.15.0@sha256:d6148daf3ad2af8fa4ecd1aa06db73da32b2e37f63088987eea2fb375ee7f320 /opt/pnpm/pnpm /usr/local/bin/pnpm

COPY --from=kustomize-builder /out/kustomize /usr/local/bin/kustomize

RUN groupadd -g 999 argocd && useradd -u 999 -g 999 -m argocd

COPY --chown=999:999 packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml

USER argocd
WORKDIR /home/argocd
