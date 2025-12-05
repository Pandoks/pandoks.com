FROM clickhouse/clickhouse-server:25.11-alpine

RUN apk add --no-cache gettext

COPY ./packages/clickhouse/clickhouse/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN mkdir -p /etc/clickhouse-server \
    && chown -R clickhouse:clickhouse /var/lib/clickhouse \
    && chown -R clickhouse:clickhouse /var/log/clickhouse-server \
    && chown -R clickhouse:clickhouse /etc/clickhouse-server

USER clickhouse

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["clickhouse-server", "--config", "/etc/clickhouse-server/config.yaml"]
