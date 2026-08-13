FROM node:24.18.0-slim

WORKDIR /app

COPY apps/workers/example-worker/typescript/package.json \
  apps/workers/example-worker/typescript/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts

COPY packages/queueworker/runtime/v1/handler.proto /packages/queueworker/runtime/v1/handler.proto
COPY apps/workers/example-worker/typescript/server.ts ./

USER node
ENTRYPOINT ["node", "server.ts"]
