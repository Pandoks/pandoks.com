FROM postgres:18-trixie

# gosu is bundled in the base image but never invoked by our entrypoint;
# remove it to drop the (unreachable) Go stdlib CVEs in its static binary
RUN rm -f /usr/local/bin/gosu \
  && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
  postgresql-18-cron=1.6.7-3.pgdg13+1 \
  postgresql-18-postgis-3=3.6.4+dfsg-2.pgdg13+1 \
  postgresql-18-pgvector=0.8.6-1.pgdg13+1 \
  patroni=4.1.3-2.pgdg13+1 \
  pgbackrest=2.59.0-1.pgdg13+1 \
  gettext-base=0.23.1-2 \
  && rm -rf /var/lib/apt/lists/*

COPY ./packages/postgres/patroni/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY ./packages/postgres/patroni/cluster-init.sh /usr/local/bin/cluster-init.sh
RUN chmod +x /usr/local/bin/cluster-init.sh

USER postgres

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "patroni", "/etc/patroni/patroni.yaml" ]
