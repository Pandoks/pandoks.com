#!/bin/sh
set -eu

PGDATABASE=${PGDATABASE:-postgres}

if pgbackrest --stanza=${POSTGRES_DB} info | grep "missing stanza path"; then
  echo "Stanza '${POSTGRES_DB}' does not exist. Creating..."
  pgbackrest --stanza="${POSTGRES_DB}" stanza-create
  if [ $? -eq 0 ]; then
    echo "Stanza '${POSTGRES_DB}' created successfully."
  else
    echo "Failed to create stanza '${POSTGRES_DB}'."
    exit 1
  fi
else
  echo "Stanza '${POSTGRES_DB}' already exists. Skipping stanza creation."
fi

echo "Checking for existing backup..."
set +e
if pgbackrest --stanza="${POSTGRES_DB}" info | grep -q "full backup"; then
  echo "Full backup already exists. Restoring..."
  pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast
  pgbackrest --stanza="${POSTGRES_DB}" restore
  if [ $? -eq 0 ]; then
    echo "Full backup restored successfully."
  else
    echo "Failed to restore full backup."
    exit 1
  fi
  echo "Patching stanza..."
  pgbackrest --stanza="${POSTGRES_DB}" --no-online stanza-upgrade
  if [ $? -eq 0 ]; then
    echo "Stanza upgraded successfully."
  else
    echo "Failed to upgrade stanza."
    exit 1
  fi
  pg_ctl start -w -D /var/lib/postgresql/pgdata
  pg_ctl promote -w -D /var/lib/postgresql/pgdata
  echo "Database ready..."
  exit 0
fi
set -e

if psql -Atq -d ${PGDATABASE} -c "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" | grep -q 1; then
  echo "Database '${POSTGRES_DB}' already exists. Skipping creation."
else
  echo "Database '${POSTGRES_DB}' does not exist. Creating..."
  psql -d ${PGDATABASE} -c "CREATE DATABASE ${POSTGRES_DB};"
  if [ $? -eq 0 ]; then
    echo "Database '${POSTGRES_DB}' created successfully."
  else
    echo "Failed to create database '${POSTGRES_DB}'."
    exit 1
  fi
fi

if psql -Atq -d ${PGDATABASE} -c "SELECT 1 FROM pg_roles WHERE rolname='pgcat'" | grep -q 1; then
  echo "Role 'pgcat' already exists. Skipping creation."
else
  echo "Role 'pgcat' does not exist. Creating..."
  psql -d ${PGDATABASE} -c "
    CREATE ROLE pgcat WITH LOGIN PASSWORD '${PGCATPASS}';
    GRANT CONNECT, TEMPORARY ON DATABASE ${POSTGRES_DB} TO pgcat;
    GRANT USAGE ON SCHEMA public TO pgcat;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO pgcat;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO pgcat;
    GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO pgcat;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO pgcat;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO pgcat;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON FUNCTIONS TO pgcat;
  "
  if [ $? -eq 0 ]; then
    echo "Role 'pgcat' created successfully."
  else
    echo "Failed to create role 'pgcat'."
    exit 1
  fi
fi

pgbackrest --stanza="${POSTGRES_DB}" backup --type=full
if [ $? -eq 0 ]; then
  echo "Initial full backup created successfully. Replicas can now bootstrap."
else
  echo "Warning: Failed to create initial backup. Replicas may fail to bootstrap."
fi
