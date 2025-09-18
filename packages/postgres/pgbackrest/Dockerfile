FROM postgres:17-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
  gettext-base \
  pgbackrest \
  && rm -rf /var/lib/apt/lists/*

COPY ./packages/postgres/pgbackrest/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER postgres

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]
