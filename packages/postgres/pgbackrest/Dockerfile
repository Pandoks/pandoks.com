FROM postgres:18-trixie@sha256:979bccfde35445db618c65107d27d08c6c21339d8dc3ad4c830c6633947be0e4

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
