FROM clickhouse/clickhouse-server:25.11-alpine

RUN apk add --no-cache rclone=1.72.1-r3

COPY ./packages/clickhouse/backup/backup.sh /usr/local/bin/backup
RUN chmod +x /usr/local/bin/backup

USER clickhouse

ENTRYPOINT ["/usr/local/bin/backup"]
