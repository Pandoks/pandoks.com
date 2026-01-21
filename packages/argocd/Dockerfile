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

RUN addgroup -g 1001 argocd \
    && adduser -D -u 1001 -G argocd argocd

RUN mkdir -p /home/argocd/cmp-server/config
COPY packages/argocd/argocd-plugin.yaml /home/argocd/cmp-server/config/plugin.yaml
RUN chown -R argocd:argocd /home/argocd

USER argocd
WORKDIR /home/argocd
