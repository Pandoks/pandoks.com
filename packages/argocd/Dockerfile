FROM golang:1.26.6-trixie@sha256:ab563819a16cfe5faff0f96a8bb598fbb0e400ab2ac751996e60abcb23b106a3 AS kustomize-builder

# renovate: datasource=go packageName=sigs.k8s.io/kustomize/kustomize/v5
ARG KUSTOMIZE_VERSION=v5.8.1
# NOTE: kustomize's go.mod pins an x/text release with known advisories; force the current one.
# remove once kustomize has updated to a version that doesn't pin this anymore.
# renovate: datasource=go packageName=golang.org/x/text
ARG X_TEXT_VERSION=v0.41.0

WORKDIR /src
RUN go mod init kustomize \
    && go get "sigs.k8s.io/kustomize/kustomize/v5@${KUSTOMIZE_VERSION}" \
    && go get "golang.org/x/text@${X_TEXT_VERSION}" \
    && CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X sigs.k8s.io/kustomize/api/provenance.version=${KUSTOMIZE_VERSION}" \
    -o /out/kustomize sigs.k8s.io/kustomize/kustomize/v5

FROM node:24.16.0-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

# The plugin runs pnpm during every manifest render. Remove the bundled npm/npx — unused, and it
# drops the vendored picomatch (CVE-2026-33671 ReDoS) from the image.
# hadolint ignore=DL3008
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    bash \
    curl \
    jq \
    git \
    ca-certificates \
    libgnutls30 \
    apache2-utils \
    libexpat1 \
    && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Official images carry the CLIs, so Renovate bumps tags and digests without hand-kept checksums.
COPY --from=amazon/aws-cli:2.36.17@sha256:a6deeaf5ec96a8f2c0d1f84e6086018ac396c95473dcec34afc275a380fa4f29 /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws

COPY --from=registry.k8s.io/kubectl:v1.37.0@sha256:5ed410ebac5dc976cc717098994dcdb29bbbd38f6bd65f582311f5be4ba719cf /bin/kubectl /usr/local/bin/kubectl

# renovate: datasource=docker packageName=ghcr.io/pnpm/pnpm
COPY --from=ghcr.io/pnpm/pnpm:12.5.1@sha256:0a4219f2ae582bce0e52073876c20e6387147f0809d8546744d87243797633ed /opt/pnpm/pnpm /usr/local/bin/pnpm

COPY --from=kustomize-builder /out/kustomize /usr/local/bin/kustomize

RUN groupadd -g 999 argocd && useradd -u 999 -g 999 -m argocd

COPY --chown=999:999 packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml

USER argocd
WORKDIR /home/argocd
