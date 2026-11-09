FROM postgres:18-trixie@sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81

# renovate: datasource=github-releases depName=citusdata/citus extractVersion=^v(?<version>.+)$
ARG CITUS_VERSION=14.3.0

ADD https://packagecloud.io/citusdata/community/gpgkey /usr/share/keyrings/citusdata.asc

# gosu is bundled in the base image but never invoked by our entrypoint;
# remove it to drop the (unreachable) Go stdlib CVEs in its static binary
RUN rm -f /usr/local/bin/gosu \
  && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && chmod 644 /usr/share/keyrings/citusdata.asc \
  && echo 'deb [signed-by=/usr/share/keyrings/citusdata.asc] https://packagecloud.io/citusdata/community/debian/ trixie main' \
    > /etc/apt/sources.list.d/citusdata.list \
  && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
  "postgresql-18-citus-${CITUS_VERSION%.*}=${CITUS_VERSION}.citus-1" \
  postgresql-18-cron \
  postgresql-18-postgis-3 \
  postgresql-18-pgvector \
  patroni \
  pgbackrest \
  gettext-base \
  && rm -rf /var/lib/apt/lists/*

COPY ./packages/postgres/patroni/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY ./packages/postgres/patroni/cluster-init.sh /usr/local/bin/cluster-init.sh
RUN chmod +x /usr/local/bin/cluster-init.sh

USER postgres

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "patroni", "/etc/patroni/patroni.yaml" ]
