FROM postgres:18-trixie

# gosu is bundled in the base image but never invoked by our entrypoint;
# remove it to drop the (unreachable) Go stdlib CVEs in its static binary
RUN rm -f /usr/local/bin/gosu \
  && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
  gettext-base=0.23.1-2 \
  pgbackrest=2.58.0-1.pgdg13+1 \
  && rm -rf /var/lib/apt/lists/*

COPY ./packages/postgres/pgbackrest/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER postgres

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]
