FROM postgres:18-trixie@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636

# gosu is bundled in the base image but never invoked by our entrypoint;
# remove it to drop the (unreachable) Go stdlib CVEs in its static binary
RUN rm -f /usr/local/bin/gosu \
  && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
  gettext-base \
  pgbackrest \
  && rm -rf /var/lib/apt/lists/*

COPY ./packages/postgres/pgbackrest/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER postgres

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]
