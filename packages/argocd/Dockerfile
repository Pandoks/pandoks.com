FROM golang:1.27.4-trixie@sha256:b54b2639de8c1bfe538ec5ffc45f29b1932235ac5f6d63c059853646677112d9 AS kustomize-builder

# renovate: datasource=go depName=kustomize packageName=sigs.k8s.io/kustomize/kustomize/v5
ARG KUSTOMIZE_VERSION=v5.8.3

WORKDIR /src
RUN go mod init kustomize \
    && go get "sigs.k8s.io/kustomize/kustomize/v5@${KUSTOMIZE_VERSION}" \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o /out/kustomize sigs.k8s.io/kustomize/kustomize/v5

FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    bash \
    jq \
    git \
    ca-certificates \
    apache2-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/pnpm/pnpm:12.16.1@sha256:33081d3d2c96ba582d316cfd630f0f43961d9c60ff919b50edd1835a1462976b /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/${bin}" "/usr/local/bin/${bin}"; done

COPY --from=kustomize-builder /out/kustomize /usr/local/bin/kustomize
COPY --from=pulumi/pulumi-base:3.274.1@sha256:9b6fcd6b4f021c7cc2f9e63c3bae80d54d53a7b3390b9769cd37489afbe727af /pulumi/bin/pulumi /usr/local/bin/pulumi
COPY --from=amazon/aws-cli:2.39.3@sha256:d557b3524475d70dd3104cf44d96568ee3188897b73a6ece2b37aa50e1af362f /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws

# NOTE: the sidecar's root filesystem is read-only; /tmp is its writable mount.
ENV PULUMI_HOME=/tmp/.pulumi PULUMI_SKIP_UPDATE_CHECK=true

RUN groupadd -g 999 argocd && useradd -u 999 -g 999 -m argocd

COPY --chown=999:999 packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml

USER argocd
WORKDIR /home/argocd
