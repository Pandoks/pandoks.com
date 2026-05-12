FROM clickhouse/clickhouse-server:25.11-alpine@sha256:efe3c0491c666d3f850d255c6e08ee7cf55506258d65ab972477da9923d946ab

USER root
RUN apk upgrade --no-cache && apk add --no-cache rclone=1.72.1-r3

COPY ./packages/clickhouse/backup/backup.sh /usr/local/bin/backup
RUN chmod +x /usr/local/bin/backup

USER clickhouse

ENTRYPOINT ["/usr/local/bin/backup"]
