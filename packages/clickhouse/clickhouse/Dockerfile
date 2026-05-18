FROM clickhouse/clickhouse-server:26.4-alpine@sha256:b802bd0194e477ce96e0474d7ca7050cb393dac9502d504a59ed47c8614c750e

USER root
RUN apk upgrade --no-cache && apk add --no-cache gettext=0.24.1-r1

COPY ./packages/clickhouse/clickhouse/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER clickhouse

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["clickhouse-server", "--config", "/etc/clickhouse-server/config.yaml"]
