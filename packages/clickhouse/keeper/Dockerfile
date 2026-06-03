FROM clickhouse/clickhouse-keeper:25.12-alpine@sha256:30d9d1ad1423d39c34a452dbe46813c09f102ee597bf978ecd60aa4804f05b29

USER root
RUN apk upgrade --no-cache && apk add --no-cache gettext=0.24.1-r1

COPY ./packages/clickhouse/keeper/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER clickhouse

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["clickhouse-keeper", "--config", "/etc/clickhouse-keeper/keeper.yaml"]
