FROM postgres:18-trixie@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db

# gosu is bundled in the base image but never invoked by our entrypoint;
# remove it to drop the (unreachable) Go stdlib CVEs in its static binary
RUN rm -f /usr/local/bin/gosu \
  && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
  postgresql-18-cron=1.6.7-2.pgdg13+1 \
  postgresql-18-postgis-3=3.6.3+dfsg-1.pgdg13+1 \
  postgresql-18-pgvector=0.8.2-1.pgdg13+1 \
  patroni=4.1.2-1.pgdg13+1 \
  pgbackrest=2.58.0-1.pgdg13+1 \
  gettext-base=0.23.1-2 \
  && rm -rf /var/lib/apt/lists/*

COPY ./packages/postgres/patroni/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY ./packages/postgres/patroni/cluster-init.sh /usr/local/bin/cluster-init.sh
RUN chmod +x /usr/local/bin/cluster-init.sh

USER postgres

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "patroni", "/etc/patroni/patroni.yaml" ]
