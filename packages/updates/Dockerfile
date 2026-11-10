FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS export

COPY --from=ghcr.io/pnpm/pnpm:12.16.1@sha256:33081d3d2c96ba582d316cfd630f0f43961d9c60ff919b50edd1835a1462976b /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm

ENV EXPO_NO_TELEMETRY=1
WORKDIR /src
COPY . .

# The app directory under apps/, like mobile-template
ARG APP
RUN test -n "${APP}" && pnpm install --frozen-lockfile --filter "./apps/${APP}..."

WORKDIR /src/apps/${APP}
RUN pnpm exec expo export --output-dir /export --platform ios --platform android \
    && pnpm exec expo config --type public --json > /export/expo-config.json \
    && for platform in ios android; do \
    pnpm exec expo-updates runtimeversion:resolve --platform "${platform}" > "/export/runtime-version-${platform}.json"; \
    done \
    && date -u +%Y-%m-%dT%H:%M:%SZ > /export/created-at

FROM golang:1.27.3-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS builder

WORKDIR /src
COPY packages/updates/go.mod ./
COPY packages/updates/main.go ./

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ENV GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0

RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/updates .

FROM scratch

COPY --from=builder /out/updates /usr/local/bin/updates
COPY --from=export /export /updates

USER 65532:65532

ENTRYPOINT ["/usr/local/bin/updates"]
