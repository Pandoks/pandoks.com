FROM clickhouse/clickhouse-keeper:25.11-alpine@sha256:d41bf4c6070522c21244f607ba595fde592cf63e83761daf826b9121acb2d365

USER root
RUN apk upgrade --no-cache && apk add --no-cache gettext=0.24.1-r1

COPY ./packages/clickhouse/keeper/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER clickhouse

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["clickhouse-keeper", "--config", "/etc/clickhouse-keeper/keeper.yaml"]
