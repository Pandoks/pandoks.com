FROM postgres:17-trixie

ENV POSTGRES_DB=
ENV NAMESPACE=
ENV POD_NAME=
ENV POD_IP=
ENV PGUSER=
ENV PGPASSWORD=
ENV PGREPPASS=
ENV PATRONI_PASSWORD=

RUN apt-get update && apt-get install -y --no-install-recommends \
  postgresql-17-cron \
  postgresql-17-postgis-3 \
  postgresql-17-pgvector \
  patroni \
  pgbackrest \
  gettext-base \
  && rm -rf /var/lib/apt/lists/*

COPY ./packages/postgres/patroni/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER postgres

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "patroni", "/etc/patroni/patroni.yaml" ]
