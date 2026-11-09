#!/bin/sh

set -eu

if pgbackrest --stanza="${STANZA}" info | grep "missing stanza path"; then
  echo "Stanza '${STANZA}' does not exist. Creating..."
  if pgbackrest --stanza="${STANZA}" stanza-create; then
    echo "✓ Stanza '${STANZA}' created successfully."
  else
    echo "Failed to create stanza '${STANZA}'."
    exit 1
  fi
else
  echo "Stanza '${STANZA}' already exists. Skipping stanza creation."
fi

echo "Checking for existing backup..."
set +e # TODO: test if this is needed
if pgbackrest --stanza="${STANZA}" info | grep -q "full backup"; then
  echo "Full backup already exists. Restoring..."
  # NOTE: a clean shutdown would archive this fresh initdb's last WAL, which the stanza rejects forever
  pg_ctl stop -w -D /var/lib/postgresql/pgdata -m immediate
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
  # NOTE: recovery promotes on its own once it replays the archived WAL; promoting here would cut it short
  until [ "$(psql -XAt -d postgres -c 'SELECT pg_is_in_recovery()')" = f ]; do
    pg_ctl status -D /var/lib/postgresql/pgdata > /dev/null || exit 1
    sleep 1
  done
  # NOTE: after this script patroni adds the superuser's citus credentials, failing on the restored ones
  if psql -d "${POSTGRES_DB}" -c "DELETE FROM pg_dist_authinfo WHERE nodeid = 0 AND rolename = current_user;"; then
    echo "✓ Restored citus credentials prepared for patroni."
  else
    echo "Failed to prepare restored citus credentials for patroni."
    exit 1
  fi
  # NOTE: patroni then moves the coordinator to this pod, which fails to sync to the restored workers'
  # old addresses unless they have no metadata; the README resyncs it once every group is up
  if [ "${CITUS_GROUP}" -eq 0 ]; then
    if psql -d "${POSTGRES_DB}" -c "UPDATE pg_dist_node SET hasmetadata = false, metadatasynced = false WHERE groupid <> 0;"; then
      echo "✓ Restored worker metadata prepared for patroni."
    else
      echo "Failed to prepare restored worker metadata for patroni."
      exit 1
    fi
  fi
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

# NOTE: patroni only creates citus on workers after this script, which leaves its ssl out of the backup
# replicas restore; before anything else so citus propagates the extensions and roles below to workers
echo "Creating citus extension..."
if psql -d "${POSTGRES_DB}" -c "CREATE EXTENSION IF NOT EXISTS citus;"; then
  echo "✓ citus extension created successfully."
else
  echo "Failed to create citus extension."
  exit 1
fi

# NOTE: workers get everything else from the coordinator through citus
if [ "${CITUS_GROUP}" -eq 0 ]; then
  # NOTE: patroni registers the coordinator without shards, which leaves no node for them until workers join
  echo "Registering the coordinator to hold shards..."
  if psql -d "${POSTGRES_DB}" -c "
    SELECT citus_set_coordinator_host('${POD_IP}');
    SELECT citus_set_node_property('${POD_IP}', 5432, 'shouldhaveshards', true);
  "; then
    echo "✓ Coordinator registered successfully."
  else
    echo "Failed to register the coordinator."
    exit 1
  fi

  echo "Creating pg_stat_statements extension..."
  if psql -d "${POSTGRES_DB}" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"; then
    echo "✓ pg_stat_statements extension created successfully."
  else
    echo "Warning: Failed to create pg_stat_statements extension."
  fi

  if psql -Atq -d "${POSTGRES_DB}" -c "SELECT 1 FROM pg_roles WHERE rolname='admin'" | grep -q 1; then
    echo "Role 'admin' already exists. Skipping creation."
  else
    echo "Role 'admin' does not exist. Creating..."
    if psql -d "${POSTGRES_DB}" -c "
      CREATE ROLE admin WITH LOGIN PASSWORD '${ADMIN_PASSWORD}';
      GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO admin;
      GRANT CREATE ON SCHEMA public TO admin;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admin;
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO admin;
      GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON FUNCTIONS TO admin;
      INSERT INTO pg_dist_authinfo VALUES (0, 'admin', 'password=${ADMIN_PASSWORD}');
    "; then
      echo "✓ Role 'admin' created successfully."
    else
      echo "Failed to create role 'admin'."
      exit 1
    fi
  fi

  if psql -Atq -d "${POSTGRES_DB}" -c "SELECT 1 FROM pg_roles WHERE rolname='client'" | grep -q 1; then
    echo "Role 'client' already exists. Skipping creation."
  else
    echo "Role 'client' does not exist. Creating..."
    if psql -d "${POSTGRES_DB}" -c "
      CREATE ROLE client WITH LOGIN PASSWORD '${CLIENT_PASSWORD}';
      GRANT CONNECT, TEMPORARY ON DATABASE ${POSTGRES_DB} TO client;
      GRANT USAGE ON SCHEMA public TO client;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO client;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO client;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO client;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO client;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO client;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO client;
      INSERT INTO pg_dist_authinfo VALUES (0, 'client', 'password=${CLIENT_PASSWORD}');
    "; then
      echo "✓ Role 'client' created successfully."
    else
      echo "Failed to create role 'client'."
      exit 1
    fi
  fi
fi

if pgbackrest --stanza="${STANZA}" backup --type=full; then
  echo "✓ Initial full backup created successfully. Replicas can now bootstrap."
else
  echo "Warning: Failed to create initial backup. Replicas may fail to bootstrap."
fi
