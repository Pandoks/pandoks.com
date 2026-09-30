FROM valkey/valkey:9-alpine@sha256:48332870af354a799964c0012ae1194a0bf2bf894eb508f945810596dc2d8d11

USER root
RUN apk upgrade --no-cache \
    && apk add --no-cache gettext=1.0-r0 libxml2=2.13.9-r2 util-linux=2.42.3-r1 setpriv=2.42.3-r1

COPY ./packages/valkey/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER valkey

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "valkey-server", "/etc/valkey/valkey.conf" ]
