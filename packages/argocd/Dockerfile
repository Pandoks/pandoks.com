FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    jq \
    git \
    unzip \
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

RUN mkdir -p /home/argocd/cmp-server/config
COPY packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml
RUN chown -R 999:999 /home/argocd

USER argocd
WORKDIR /home/argocd
