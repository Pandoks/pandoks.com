FROM node:24-alpine

RUN apk add --no-cache \
    bash \
    curl \
    jq \
    git \
    aws-cli \
    && corepack enable
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

RUN adduser -D -u 999 argocd

RUN mkdir -p /home/argocd/cmp-server/config
COPY packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml
RUN chown -R argocd:argocd /home/argocd

USER 999
WORKDIR /home/argocd
