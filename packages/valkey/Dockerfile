FROM valkey/valkey:9-alpine@sha256:a0dbf4c1d5708782907c10e2c72deff317518518b5288a58416981d9db95d30b

USER root
RUN apk upgrade --no-cache \
    && apk add --no-cache gettext=1.0-r0 libxml2=2.13.9-r2 util-linux=2.42.3-r1 setpriv=2.42.3-r1

COPY ./packages/valkey/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER valkey

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "valkey-server", "/etc/valkey/valkey.conf" ]
