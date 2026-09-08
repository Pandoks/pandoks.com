FROM valkey/valkey:9-alpine@sha256:de31910896150d5e754a07d57d227cfdde4e258ddd0d1aa4607f2d2f95843715

USER root
RUN apk upgrade --no-cache \
    && apk add --no-cache gettext=1.0-r0 libxml2=2.13.9-r2

COPY ./packages/valkey/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER valkey

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "valkey-server", "/etc/valkey/valkey.conf" ]
