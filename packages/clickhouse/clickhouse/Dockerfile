FROM clickhouse/clickhouse-server:25.11-alpine@sha256:efe3c0491c666d3f850d255c6e08ee7cf55506258d65ab972477da9923d946ab

USER root
RUN apk upgrade --no-cache && apk add --no-cache gettext=0.24.1-r1

COPY ./packages/clickhouse/clickhouse/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER clickhouse

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["clickhouse-server", "--config", "/etc/clickhouse-server/config.yaml"]
