FROM valkey/valkey:9-alpine

RUN apk add --no-cache gettext

RUN mkdir -p /etc/valkey

COPY ./packages/valkey/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "valkey-server", "/etc/valkey.conf" ]
