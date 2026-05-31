FROM clickhouse/clickhouse-server:25.12-alpine@sha256:7d93fb39bb2bfc8509bd621241db974e41041ac0ae626a5b06e172431fc709f7

USER root
RUN apk upgrade --no-cache && apk add --no-cache gettext=0.24.1-r1

COPY ./packages/clickhouse/clickhouse/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER clickhouse

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["clickhouse-server", "--config", "/etc/clickhouse-server/config.yaml"]
