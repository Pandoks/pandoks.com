FROM postgres:18-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
  postgresql-18-cron=1.6.7-2.pgdg13+1 \
  postgresql-18-postgis-3=3.6.3+dfsg-1.pgdg13+1 \
  postgresql-18-pgvector=0.8.2-1.pgdg13+1 \
  patroni=4.1.2-1.pgdg13+1 \
  pgbackrest=2.58.0-1.pgdg13+1 \
  gettext-base=0.23.1-2 \
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
