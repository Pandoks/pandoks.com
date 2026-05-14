FROM node:24-slim

# The argocd plugin invokes pnpm via corepack — never npm. Remove the bundled npm to drop its
# vendored picomatch (CVE-2026-33671 ReDoS).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && apt-get update && apt-get install -y --no-install-recommends \
    bash=5.2.15-2+b10 \
    curl=7.88.1-10+deb12u14 \
    jq=1.6-2.1+deb12u1 \
    git=1:2.39.5-0+deb12u3 \
    unzip=6.0-28 \
    ca-certificates=20230311+deb12u1 \
    apache2-utils=2.4.67-1~deb12u2 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws

RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

RUN groupadd -g 999 argocd && useradd -u 999 -g 999 -m argocd

COPY --chown=999:999 packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml

USER argocd
WORKDIR /home/argocd
