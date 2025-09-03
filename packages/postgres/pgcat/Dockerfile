FROM ghcr.io/postgresml/pgcat:latest

ENV POSTGRES_USER=
ENV POSTGRES_PASSWORD=
ENV POSTGRES_DB=
ENV PGPOOLPASS=
ENV MASTER_HOST_1=
ENV SLAVE_HOST1_1=

RUN apt update
RUN apt install -y --no-install-recommends gettext-base

COPY ./packages/postgres/pgcat/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

CMD [ "pgcat", "/etc/pgcat/pgcat.toml" ]
