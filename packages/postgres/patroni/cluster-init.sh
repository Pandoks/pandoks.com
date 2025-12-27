#!/bin/sh

set -eu

if pgbackrest --stanza="${POSTGRES_DB}" info | grep "missing stanza path"; then
  echo "Stanza '${POSTGRES_DB}' does not exist. Creating..."
  if pgbackrest --stanza="${POSTGRES_DB}" stanza-create; then
    echo "✓ Stanza '${POSTGRES_DB}' created successfully."
  else
    echo "Failed to create stanza '${POSTGRES_DB}'."
    exit 1
  fi
else
  echo "Stanza '${POSTGRES_DB}' already exists. Skipping stanza creation."
fi

echo "Checking for existing backup..."
set +e # TODO: test if this is needed
if pgbackrest --stanza="${POSTGRES_DB}" info | grep -q "full backup"; then
  echo "Full backup already exists. Restoring..."
  pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast
  if pgbackrest --stanza="${POSTGRES_DB}" restore; then
    echo "✓ Full backup restored successfully."
  else
    echo "Failed to restore full backup."
    exit 1
  fi
  echo "Patching stanza..."
  if pgbackrest --stanza="${POSTGRES_DB}" --no-online stanza-upgrade; then
    echo "✓ Stanza upgraded successfully."
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

if psql -Atq -d postgres -c "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" | grep -q 1; then
  echo "Database '${POSTGRES_DB}' already exists. Skipping creation."
else
  echo "Database '${POSTGRES_DB}' does not exist. Creating..."
  if psql -d postgres -c "CREATE DATABASE ${POSTGRES_DB};"; then
    echo "✓ Database '${POSTGRES_DB}' created successfully."
  else
    echo "Failed to create database '${POSTGRES_DB}'."
    exit 1
  fi
fi

if psql -Atq -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='admin'" | grep -q 1; then
  echo "Role 'admin' already exists. Skipping creation."
else
  echo "Role 'admin' does not exist. Creating..."
  if psql -d postgres -c "
    CREATE ROLE admin WITH LOGIN PASSWORD '${ADMIN_PASSWORD}';
    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO admin;
    GRANT CREATE ON SCHEMA public TO admin;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admin;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO admin;
    GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON FUNCTIONS TO admin;
  "; then
    echo "✓ Role 'admin' created successfully."
  else
    echo "Failed to create role 'admin'."
    exit 1
  fi
fi

if psql -Atq -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='client'" | grep -q 1; then
  echo "Role 'client' already exists. Skipping creation."
else
  echo "Role 'client' does not exist. Creating..."
  if psql -d postgres -c "
    CREATE ROLE client WITH LOGIN PASSWORD '${CLIENT_PASSWORD}';
    GRANT CONNECT, TEMPORARY ON DATABASE ${POSTGRES_DB} TO client;
    GRANT USAGE ON SCHEMA public TO client;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO client;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO client;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO client;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO client;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO client;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO client;
  "; then
    echo "✓ Role 'client' created successfully."
  else
    echo "Failed to create role 'client'."
    exit 1
  fi
fi

if pgbackrest --stanza="${POSTGRES_DB}" backup --type=full; then
  echo "✓ Initial full backup created successfully. Replicas can now bootstrap."
else
  echo "Warning: Failed to create initial backup. Replicas may fail to bootstrap."
fi
