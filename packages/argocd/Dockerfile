FROM node:24.16.0-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

# The argocd plugin invokes pnpm via corepack — never npm. Remove the bundled npm to drop its
# vendored picomatch (CVE-2026-33671 ReDoS).
# hadolint ignore=DL3008
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

# renovate: datasource=github-releases packageName=kubernetes/kubernetes
ARG KUBECTL_VERSION=v1.36.3
ARG KUBECTL_SHA256=ebbd080e7c2e275093b55915722043257eb24004363e20acb3c4d71919f88336
RUN curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && echo "${KUBECTL_SHA256}  kubectl" | sha256sum -c - \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

RUN groupadd -g 999 argocd && useradd -u 999 -g 999 -m argocd

COPY --chown=999:999 packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml

USER argocd
WORKDIR /home/argocd
