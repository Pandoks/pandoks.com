FROM clickhouse/clickhouse-server:25.11-alpine

USER root
RUN apk upgrade --no-cache && apk add --no-cache gettext=0.24.1-r1

COPY ./packages/clickhouse/clickhouse/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER clickhouse

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["clickhouse-server", "--config", "/etc/clickhouse-server/config.yaml"]
