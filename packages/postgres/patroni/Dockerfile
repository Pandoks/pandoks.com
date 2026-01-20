FROM postgres:18-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
  postgresql-18-cron \
  postgresql-18-postgis-3 \
  postgresql-18-pgvector \
  patroni \
  pgbackrest \
  gettext-base \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/patroni \
  && chown -R postgres:postgres /var/lib/postgresql \
  && chown -R postgres:postgres /etc/patroni

COPY ./packages/postgres/patroni/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY ./packages/postgres/patroni/cluster-init.sh /usr/local/bin/cluster-init.sh
RUN chmod +x /usr/local/bin/cluster-init.sh

USER postgres

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "patroni", "/etc/patroni/patroni.yaml" ]
