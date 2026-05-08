FROM clickhouse/clickhouse-keeper:25.11-alpine

RUN apk add --no-cache gettext=0.24.1-r1

COPY ./packages/clickhouse/keeper/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN mkdir -p /etc/clickhouse-keeper \
    && chown -R clickhouse:clickhouse /var/lib/clickhouse \
    && chown -R clickhouse:clickhouse /var/log/clickhouse-keeper \
    && chown -R clickhouse:clickhouse /etc/clickhouse-keeper

USER clickhouse

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["clickhouse-keeper", "--config", "/etc/clickhouse-keeper/keeper.yaml"]
