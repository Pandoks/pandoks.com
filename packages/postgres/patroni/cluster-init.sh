#!/bin/sh

set -eu

# NOTE: the chart sets BACKUP_BUCKET only when backup.enabled is true
if [ -n "${BACKUP_BUCKET+set}" ]; then
  # NOTE: info prints its errors to stdout, and exits 0 with "status: error (other)" when it can't read the repo
  if ! stanza_info=$(pgbackrest --stanza="${STANZA}" info); then
    echo "${stanza_info}"
    echo "Failed to read stanza '${STANZA}'."
    exit 1
  fi
  case "${stanza_info}" in
    *"status: error (missing stanza path)"*)
      echo "Stanza '${STANZA}' does not exist. Creating..."
      if pgbackrest --stanza="${STANZA}" stanza-create; then
        echo "✓ Stanza '${STANZA}' created successfully."
      else
        echo "Failed to create stanza '${STANZA}'."
        exit 1
      fi
      ;;
    *"status: ok"* | *"status: error (no valid backups)"*)
      echo "Stanza '${STANZA}' already exists. Skipping stanza creation."
      ;;
    *)
      echo "${stanza_info}"
      echo "Failed to read stanza '${STANZA}'."
      exit 1
      ;;
  esac

  echo "Checking for existing backup..."
  set +e # TODO: test if this is needed
  if pgbackrest --stanza="${STANZA}" info | grep -q "full backup"; then
    echo "Full backup already exists. Restoring..."
    pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast
    if pgbackrest --stanza="${STANZA}" restore; then
      echo "✓ Full backup restored successfully."
    else
      echo "Failed to restore full backup."
      exit 1
    fi
    echo "Patching stanza..."
    if pgbackrest --stanza="${STANZA}" --no-online stanza-upgrade; then
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
fi

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

echo "Creating pg_stat_statements extension..."
if psql -d "${POSTGRES_DB}" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"; then
  echo "✓ pg_stat_statements extension created successfully."
else
  echo "Warning: Failed to create pg_stat_statements extension."
fi

if psql -Atq -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='admin'" | grep -q 1; then
  echo "Role 'admin' already exists. Skipping creation."
else
  echo "Role 'admin' does not exist. Creating..."
  if psql -d "${POSTGRES_DB}" -c "
    CREATE ROLE admin WITH LOGIN PASSWORD '${ADMIN_PASSWORD}';
    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO admin;
    GRANT CREATE ON SCHEMA public TO admin;
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
  if psql -d "${POSTGRES_DB}" -c "
    CREATE ROLE client WITH LOGIN PASSWORD '${CLIENT_PASSWORD}';
    GRANT CONNECT, TEMPORARY ON DATABASE ${POSTGRES_DB} TO client;
    GRANT USAGE ON SCHEMA public TO client;
    ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO client;
    ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO client;
    ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO client;
  "; then
    echo "✓ Role 'client' created successfully."
  else
    echo "Failed to create role 'client'."
    exit 1
  fi
fi

if [ -z "${BACKUP_BUCKET+set}" ]; then
  echo "Backups are disabled. Skipping the initial full backup."
elif pgbackrest --stanza="${STANZA}" backup --type=full; then
  echo "✓ Initial full backup created successfully. Replicas can now bootstrap."
else
  echo "Warning: Failed to create initial backup. Replicas may fail to bootstrap."
fi
