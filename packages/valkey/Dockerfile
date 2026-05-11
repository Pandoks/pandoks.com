FROM valkey/valkey:9-alpine

USER root
RUN apk upgrade --no-cache \
    && apk add --no-cache gettext=0.24.1-r1

COPY ./packages/valkey/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER valkey

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "valkey-server", "/etc/valkey/valkey.conf" ]
