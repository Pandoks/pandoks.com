FROM clickhouse/clickhouse-server:26.4-alpine@sha256:b802bd0194e477ce96e0474d7ca7050cb393dac9502d504a59ed47c8614c750e

USER root
RUN apk upgrade --no-cache && apk add --no-cache rclone=1.72.1-r3

COPY ./packages/clickhouse/backup/backup.sh /usr/local/bin/backup
RUN chmod +x /usr/local/bin/backup

USER clickhouse

ENTRYPOINT ["/usr/local/bin/backup"]
