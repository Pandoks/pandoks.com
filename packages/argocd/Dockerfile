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
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    jq \
    git \
    unzip \
    ca-certificates \
    libgnutls30 \
    apache2-utils \
    && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# renovate: datasource=github-tags packageName=aws/aws-cli
ARG AWS_CLI_VERSION=2.36.17
ARG AWS_CLI_SHA256=7e3b004e49c4550729fddbdc7f199b07b2288fe73a41ac0fcc8f5b873c938f7b
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" -o "awscliv2.zip" \
    && echo "${AWS_CLI_SHA256}  awscliv2.zip" | sha256sum -c - \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws

# renovate: datasource=docker packageName=ghcr.io/pnpm/pnpm
COPY --from=ghcr.io/pnpm/pnpm:11.21.0@sha256:ff1b4619e8299734f35afb21bd2be18f51b7b6e49cd30fb14300fadeafe871da /opt/pnpm/pnpm /usr/local/bin/pnpm

COPY --from=kustomize-builder /out/kustomize /usr/local/bin/kustomize

RUN groupadd -g 999 argocd && useradd -u 999 -g 999 -m argocd

COPY --chown=999:999 packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml

USER argocd
WORKDIR /home/argocd
