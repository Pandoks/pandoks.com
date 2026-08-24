# The CMP only renders manifests, so it runs kustomize — not kubectl. Build kustomize from source
# on a current Go toolchain instead of shipping the official release binary (built on an old Go
# toolchain) or kubectl (which vendors x/net): either ships Go advisory waves this image never
# exercises.
FROM golang:1.26.6-trixie@sha256:ab563819a16cfe5faff0f96a8bb598fbb0e400ab2ac751996e60abcb23b106a3 AS kustomize-builder

# renovate: datasource=go packageName=sigs.k8s.io/kustomize/kustomize/v5
ARG KUSTOMIZE_VERSION=v5.8.1

# kustomize's go.mod pins an x/text release with known advisories; force the current one.
# renovate: datasource=go packageName=golang.org/x/text
ARG X_TEXT_VERSION=v0.41.0

WORKDIR /src
# CGO_ENABLED=0 keeps the binary static so the bookworm runtime base never has to match this
# builder's newer glibc.
RUN go mod init kustomize \
    && go get "sigs.k8s.io/kustomize/kustomize/v5@${KUSTOMIZE_VERSION}" \
    && go get "golang.org/x/text@${X_TEXT_VERSION}" \
    && CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X sigs.k8s.io/kustomize/api/provenance.version=${KUSTOMIZE_VERSION}" \
    -o /out/kustomize sigs.k8s.io/kustomize/kustomize/v5

FROM node:24.16.0-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

# The argocd plugin invokes pnpm via corepack — never npm. Remove the bundled npm to drop its
# vendored picomatch (CVE-2026-33671 ReDoS).
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
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Preload the repository's exact package-manager version. The CMP container has
# a read-only root filesystem, so Corepack cannot populate a per-user cache at
# manifest-generation time.
ENV COREPACK_HOME=/opt/corepack
COPY package.json /tmp/pandoks-package.json
RUN corepack install --global "$(node -p "require('/tmp/pandoks-package.json').packageManager")" \
    && rm /tmp/pandoks-package.json \
    && chmod -R a+rX "${COREPACK_HOME}"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# renovate: datasource=github-tags packageName=aws/aws-cli
ARG AWS_CLI_VERSION=2.36.17
ARG AWS_CLI_SHA256=7e3b004e49c4550729fddbdc7f199b07b2288fe73a41ac0fcc8f5b873c938f7b
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" -o "awscliv2.zip" \
    && echo "${AWS_CLI_SHA256}  awscliv2.zip" | sha256sum -c - \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws

COPY --from=kustomize-builder /out/kustomize /usr/local/bin/kustomize

RUN groupadd -g 999 argocd && useradd -u 999 -g 999 -m argocd

COPY --chown=999:999 packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml

USER argocd
WORKDIR /home/argocd
