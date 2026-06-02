FROM clickhouse/clickhouse-server:25.12-alpine@sha256:7d93fb39bb2bfc8509bd621241db974e41041ac0ae626a5b06e172431fc709f7

USER root
RUN apk upgrade --no-cache && apk add --no-cache rclone=1.72.1-r3

COPY ./packages/clickhouse/backup/backup.sh /usr/local/bin/backup
RUN chmod +x /usr/local/bin/backup

USER clickhouse

ENTRYPOINT ["/usr/local/bin/backup"]
