FROM valkey/valkey:9-alpine@sha256:d1cc70645bbcef743615463a2fa4616e841407545e18f560aed0c49671a90147

USER root
RUN apk upgrade --no-cache \
    && apk add --no-cache gettext=0.24.1-r1

COPY ./packages/valkey/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER valkey

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "valkey-server", "/etc/valkey/valkey.conf" ]
