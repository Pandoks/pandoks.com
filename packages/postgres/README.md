# PostgreSQL High-Availability Cluster

Production-ready PostgreSQL cluster with automatic failover, connection pooling, sharding, and continuous backups.

## Architecture

```mermaid
graph TB
    subgraph "Client Applications"
        App[Application]
    end

    subgraph "Connection Layer - Port 6432"
        PgDog[PgDog Connection Pooler<br/>2+ replicas]
    end

    subgraph "Shard 0"
        S0P[Patroni Pod 0-0<br/>Primary]
        S0R1[Patroni Pod 0-1<br/>Replica]
        S0R2[Patroni Pod 0-2<br/>Replica]
    end

    subgraph "Shard 1"
        S1P[Patroni Pod 1-0<br/>Primary]
        S1R1[Patroni Pod 1-1<br/>Replica]
        S1R2[Patroni Pod 1-2<br/>Replica]
    end

    subgraph "Shard N..."
        SNP[Patroni Pod N-0<br/>Primary]
    end

    subgraph "Backup System"
        BackupJobs[Backup CronJobs<br/>Per Shard]
        S3[S3 Storage<br/>Encrypted]
    end

    App -->|client user| PgDog
    PgDog -->|Writes| S0P
    PgDog -->|Writes| S1P
    PgDog -->|Reads| S0R1
    PgDog -->|Reads| S1R1

    S0P -.->|Streaming Replication| S0R1
    S0P -.->|Streaming Replication| S0R2
    S1P -.->|Streaming Replication| S1R1
    S1P -.->|Streaming Replication| S1R2

    BackupJobs -->|TLS| S0P
    BackupJobs -->|TLS| S1P
    BackupJobs --> S3

    style S0P fill:#90EE90
    style S1P fill:#90EE90
    style SNP fill:#90EE90
    style S0R1 fill:#87CEEB
    style S0R2 fill:#87CEEB
    style S1R1 fill:#87CEEB
    style S1R2 fill:#87CEEB
    style PgDog fill:#FFD700
```

## Components

### Patroni (High Availability)

- **PostgreSQL 18** with automatic failover
- **Sharding support** - multiple independent shards
- **3 replicas per shard** (configurable) with streaming replication
- **Leader election** via Kubernetes endpoints
- **Automatic recovery** from node failures

### PgDog (Connection Pooling & Sharding)

- **Connection pooling** - transaction-level pooling
- **Automatic sharding** - routes queries to correct shard based on sharding key
- **Read/write splitting** - writes to primary, reads to replicas
- **Auto role detection** - detects primary/replica via `pg_is_in_recovery()`
- **Load balancing** - least active connections strategy

### pgBackRest (Backup & Recovery)

- **Per-shard backups** - each shard has its own stanza
- **Automated schedules** - full, differential, and incremental backups
- **Point-in-time recovery** - restore to any moment
- **Encryption** - AES-256-CBC for all backups
- **S3-compatible storage** - works with AWS S3, MinIO, LocalStack

## Users & Permissions

| User         | Purpose                | Access                              |
| ------------ | ---------------------- | ----------------------------------- |
| `postgres`   | Superuser (local only) | Full access, local connections only |
| `admin`      | Schema management      | CREATE/ALTER/DROP, remote access    |
| `client`     | Application queries    | SELECT/INSERT/UPDATE/DELETE         |
| `replicator` | Streaming replication  | Replication only                    |
| `patroni`    | Patroni REST API       | Health checks, failover             |

**Security Note:** The `postgres` superuser can only connect locally (from within the pod). Use `admin` for remote privileged access and `client` for applications.

## Quick Start

### 1. Create Secrets

```yaml
# k3s/apps/secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: myapp-db-creds
  namespace: myapp
type: Opaque
stringData:
  SUPERUSER_PASSWORD: 'your-superuser-password'
  ADMIN_PASSWORD: 'your-admin-password'
  CLIENT_PASSWORD: 'your-client-password'
  REPLICATION_PASSWORD: 'your-replication-password'
  PATRONI_PASSWORD: 'your-patroni-password'
  BACKUP_S3_KEY: 'your-s3-access-key'
  BACKUP_S3_KEY_SECRET: 'your-s3-secret-key'
```

### 2. Deploy with HelmChart

```yaml
# kube/main/main.yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: myapp-postgres
  namespace: kube-system
spec:
  chart: oci://ghcr.io/pandoks/charts/postgres
  version: 0.1.0
  targetNamespace: myapp
  createNamespace: true
  failurePolicy: abort
  set:
    db: myapp
    namespace: myapp
    credentials.secret: myapp-db-creds
    patroni.shards: 1
    patroni.replicasPerShard: 3
```

### 3. Configure Sharding (Optional)

To enable sharding, add sharded tables configuration:

```yaml
spec:
  valuesContent: |-
    db: myapp
    namespace: myapp
    credentials:
      secret: myapp-db-creds
    patroni:
      shards: 3
      replicasPerShard: 3
    pgdog:
      shardedTables:
        - database: myapp
          name: users
          column: id
          dataType: bigint
```

**Supported data types for sharding:** `bigint`, `uuid`, `varchar`, `vector`

## Connecting to PostgreSQL

### Application Connection (via PgDog)

```bash
# Connection string
postgresql://client:CLIENT_PASSWORD@myapp-pgdog:6432/myapp

# Using psql from a pod
kubectl exec -it deployment/myapp -- \
  psql -h myapp-pgdog -p 6432 -U client -d myapp
```

### Admin Connection (Direct)

```bash
# Connect to primary for schema changes
kubectl exec -it patroni-myapp-shard-0-0 -c patroni -- \
  psql -U admin -d myapp
```

## Common Operations

### Check Cluster Status

```bash
# Check all shards
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml list

# Check PgDog role detection
kubectl exec -n myapp deploy/myapp-pgdog -- \
  curl -s http://127.0.0.1:9090/metrics | grep "role="
```

### Manual Failover

```bash
# Switchover to specific replica
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml switchover \
  --leader patroni-myapp-shard-0-0 \
  --candidate patroni-myapp-shard-0-1 \
  --force
```

### Backup Operations

```bash
# Trigger manual backup
kubectl create job --from=cronjob/myapp-shard-0-pgbackrest-backup-full manual-backup -n myapp

# Check backup status
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  pgbackrest --stanza=myapp-shard-0 info

# List all backups
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  pgbackrest --stanza=myapp-shard-0 info --output=json
```

### Point-in-Time Recovery (PITR)

PITR allows you to restore a shard to any specific moment in time. This is useful for recovering from accidental data deletion or corruption.

#### Step 1: Identify Target Time

First, determine the exact timestamp you want to recover to:

```bash
# List available backups and their time ranges
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  pgbackrest --stanza=myapp-shard-0 info

# Output shows backup timestamps and WAL archive range
# Example: archive start/stop: 000000010000000000000001/00000001000000000000000A
```

The recovery point must be:

- After the oldest backup's start time
- Before the latest WAL archive timestamp
- In ISO 8601 format: `YYYY-MM-DD HH:MM:SS+TZ`

#### Step 2: Stop the Shard

Before restoring, you must stop all pods in the target shard to prevent data conflicts:

```bash
# Scale down the shard's StatefulSet to 0
kubectl scale statefulset patroni-myapp-shard-0 -n myapp --replicas=0

# Wait for all pods to terminate
kubectl wait --for=delete pod -l cluster-name=myapp-shard-0 -n myapp --timeout=120s
```

#### Step 3: Prepare a Recovery Pod

Create a temporary pod to perform the restore:

```bash
kubectl run pitr-restore -n myapp --rm -it \
  --image=ghcr.io/pandoks/patroni:latest \
  --env="PGDATA=/var/lib/postgresql/pgdata" \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "pitr-restore",
        "image": "ghcr.io/pandoks/patroni:latest",
        "command": ["sleep", "infinity"],
        "envFrom": [{"secretRef": {"name": "myapp-db-creds"}}],
        "volumeMounts": [
          {"name": "data", "mountPath": "/var/lib/postgresql"},
          {"name": "pgbackrest-certs", "mountPath": "/etc/pgbackrest"}
        ]
      }],
      "volumes": [
        {"name": "data", "persistentVolumeClaim": {"claimName": "data-patroni-myapp-shard-0-0"}},
        {"name": "pgbackrest-certs", "secret": {"secretName": "myapp-pgbackrest-certs"}}
      ]
    }
  }' \
  -- bash
```

#### Step 4: Perform PITR Restore

Inside the recovery pod, run pgbackrest restore with the target time:

```bash
# Clear existing data
rm -rf /var/lib/postgresql/pgdata/*

# Restore to specific point in time
pgbackrest --stanza=myapp-shard-0 \
  --type=time \
  --target="2024-01-15 14:30:00+00" \
  --target-action=promote \
  restore

# Alternative: Restore to latest available (most recent consistent state)
pgbackrest --stanza=myapp-shard-0 \
  --type=immediate \
  --target-action=promote \
  restore
```

**Recovery type options:**

- `--type=time --target="TIMESTAMP"` - Restore to specific time
- `--type=xid --target="TRANSACTION_ID"` - Restore to specific transaction
- `--type=lsn --target="WAL_LSN"` - Restore to specific WAL position
- `--type=immediate` - Restore to end of backup (before WAL replay)
- `--type=default` - Restore and replay all available WAL

#### Step 5: Restart the Shard

After restore completes, delete the recovery pod and scale back up:

```bash
# Exit and delete the recovery pod
exit

# Delete stale Patroni endpoints (required after restore)
kubectl delete endpoints myapp-shard-0 myapp-shard-0-config -n myapp

# Scale the shard back up
kubectl scale statefulset patroni-myapp-shard-0 -n myapp --replicas=3

# Watch pods come up
kubectl get pods -n myapp -l cluster-name=myapp-shard-0 -w
```

#### Step 6: Verify Recovery

```bash
# Check cluster health
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml list

# Verify data is at expected state
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  psql -U postgres -d myapp -c "SELECT MAX(created_at) FROM your_table;"
```

#### PITR Notes

- **Per-shard recovery**: Each shard has independent backups. You can recover one shard without affecting others.
- **Replica rebuilding**: After PITR, replicas will automatically rebuild from the restored primary via pgbackrest or basebackup.
- **Timeline changes**: PITR creates a new timeline. The `recovery_target_timeline: latest` setting in Patroni ensures replicas follow the new timeline.
- **Data consistency**: For sharded tables, recovering one shard to a different point in time may cause cross-shard inconsistencies. Plan accordingly.

### Scaling Shards

Shards can be added or removed to scale the cluster horizontally. This requires careful data migration to maintain consistency.

#### Adding Shards (Scale Up)

**Step 1: Update Helm Values**

Increase the shard count in your HelmChart:

```yaml
spec:
  valuesContent: |-
    patroni:
      shards: 4  # Was 3, now 4
      replicasPerShard: 3
```

Apply the change:

```bash
kubectl apply -f kube/main/main.yaml
```

This creates the new shard (`myapp-shard-3`) with its own StatefulSet, services, and backup cronjobs.

**Step 2: Verify New Shard**

```bash
# Wait for new shard pods
kubectl get pods -n myapp -l cluster-name=myapp-shard-3 -w

# Check cluster health
kubectl exec -n myapp patroni-myapp-shard-3-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml list
```

**Step 3: Update PgDog Sharded Tables**

Add the new shard to your pgdog configuration:

```yaml
pgdog:
  shardedTables:
    - database: myapp
      name: users
      column: id
      dataType: bigint
      # PgDog automatically detects new shards from the generated config
```

PgDog will automatically pick up the new shard based on the generated `pgdog.toml`.

**Step 4: Rebalance Data (Optional)**

New shards start empty. To distribute existing data evenly:

```bash
# Connect to pgdog
kubectl exec -n myapp deploy/myapp-pgdog -- \
  psql -h 127.0.0.1 -p 6432 -U admin -d myapp

# Option 1: Redistribute specific rows (application-level)
# Delete from old shard, insert via pgdog (routes to correct new shard)
BEGIN;
-- Copy rows that should move to new shard
INSERT INTO users_migration SELECT * FROM users WHERE id % 4 = 3;
DELETE FROM users WHERE id % 4 = 3;
-- Re-insert via pgdog to route to new shard
INSERT INTO users SELECT * FROM users_migration;
DROP TABLE users_migration;
COMMIT;

# Option 2: Full table rebuild (downtime required)
# Export all data, truncate all shards, re-insert via pgdog
```

**Note:** PgDog uses consistent hashing. Adding shards changes which shard owns each key. Without rebalancing, queries for existing data may route to the wrong (empty) shard.

#### Removing Shards (Scale Down)

Removing shards requires migrating data off the shard before deletion.

**Step 1: Migrate Data Off Target Shard**

First, move all data from the shard being removed to remaining shards:

```bash
# Identify rows on shard-3 that need migration
kubectl exec -n myapp patroni-myapp-shard-3-0 -c patroni -- \
  psql -U postgres -d myapp -c "SELECT id FROM users;"

# For each row, delete from shard-3 and re-insert via pgdog
# pgdog will route to the correct remaining shard
kubectl exec -n myapp deploy/myapp-pgdog -- \
  psql -h 127.0.0.1 -p 6432 -U admin -d myapp <<'EOF'
BEGIN;
-- Create temp table on shard 0 to hold migrating data
CREATE TEMP TABLE migrating_users AS
  SELECT * FROM users WHERE false;  -- Empty table with same schema

-- Copy data from shard-3 (direct connection)
\c myapp admin patroni-myapp-shard-3-0
INSERT INTO migrating_users SELECT * FROM users;

-- Delete from shard-3
TRUNCATE users;

-- Reconnect via pgdog and re-insert (routes to remaining shards)
\c myapp admin myapp-pgdog 6432
INSERT INTO users SELECT * FROM migrating_users;
COMMIT;
EOF
```

**Step 2: Verify Data Migration**

```bash
# Confirm shard-3 is empty
kubectl exec -n myapp patroni-myapp-shard-3-0 -c patroni -- \
  psql -U postgres -d myapp -c "SELECT COUNT(*) FROM users;"

# Verify data exists on remaining shards
for shard in 0 1 2; do
  echo "Shard $shard:"
  kubectl exec -n myapp patroni-myapp-shard-${shard}-0 -c patroni -- \
    psql -U postgres -d myapp -c "SELECT COUNT(*) FROM users;"
done
```

**Step 3: Update Helm Values**

Decrease the shard count:

```yaml
spec:
  valuesContent: |-
    patroni:
      shards: 3  # Was 4, now 3
      replicasPerShard: 3
```

Apply the change:

```bash
kubectl apply -f kube/main/main.yaml
```

**Step 4: Clean Up Removed Shard Resources**

The Helm chart won't automatically delete the old shard's resources. Clean up manually:

```bash
# Delete StatefulSet and pods
kubectl delete statefulset patroni-myapp-shard-3 -n myapp

# Delete services
kubectl delete service patroni-myapp-shard-3 \
  patroni-myapp-primary-shard-3 \
  patroni-myapp-replicas-shard-3 -n myapp

# Delete endpoints
kubectl delete endpoints myapp-shard-3 myapp-shard-3-config -n myapp

# Delete backup cronjobs
kubectl delete cronjob -n myapp -l shard=myapp-shard-3

# Delete PVCs (WARNING: This deletes all data!)
kubectl delete pvc -n myapp -l cluster-name=myapp-shard-3
```

#### Scaling Replicas Per Shard

Scaling replicas within a shard is simpler and doesn't require data migration:

```yaml
spec:
  valuesContent: |-
    patroni:
      shards: 3
      replicasPerShard: 5  # Was 3, now 5 replicas per shard
```

```bash
kubectl apply -f kube/main/main.yaml

# New replicas automatically clone from primary via pgbackrest
kubectl get pods -n myapp -w
```

To scale down replicas:

```yaml
patroni:
  replicasPerShard: 2 # Reduce from 3 to 2
```

Kubernetes will terminate the excess pods. No data migration needed since replicas are read-only copies.

### Test Sharding

```bash
# Insert data (will be distributed across shards)
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- bash -c '
  export PGPASSWORD=$CLIENT_PASSWORD
  for i in $(seq 1 100); do
    psql -h myapp-pgdog -p 6432 -U client -d myapp \
      -c "INSERT INTO users (id, name) VALUES ($i, '"'"'user-$i'"'"');"
  done
'

# Check distribution
for shard in 0 1 2; do
  kubectl exec -n myapp patroni-myapp-shard-${shard}-0 -c patroni -- \
    psql -U postgres -d myapp -c "SELECT COUNT(*) FROM users;"
done
```

## Troubleshooting

### Cluster Won't Start After Deletion

When you delete and recreate the cluster, stale DCS endpoints may prevent Patroni from bootstrapping:

```
waiting for leader to bootstrap
```

**Fix:** Delete the stale endpoints:

```bash
kubectl delete endpoints myapp-shard-0 myapp-shard-0-config \
  myapp-shard-1 myapp-shard-1-config \
  myapp-shard-2 myapp-shard-2-config \
  -n myapp
```

Then restart the pods:

```bash
kubectl delete pods -n myapp -l app.kubernetes.io/name=patroni
```

### Backup Job Fails with TLS Error

If backup jobs fail with certificate errors:

```
unable to find hostname 'patroni-myapp-primary-shard-0...' in certificate
```

Ensure the certificate dnsNames include the shard index:

```yaml
dnsNames:
  - patroni-myapp-primary-shard-0.myapp.svc.cluster.local
  - patroni-myapp-replicas-shard-0.myapp.svc.cluster.local
```

### Replication Lag

```bash
# Check replication status
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# Check Patroni cluster view
kubectl exec -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml list
```

### PgDog Not Routing to Replicas

Ensure these settings are configured:

```yaml
pgdog:
  lsnCheckDelay: 0 # Enable role detection immediately
  lsnCheckInterval: 1000 # Check every 1 second
  readWriteSplit: include_primary_if_replica_banned
```

## Configuration Reference

### Values

| Key                           | Description          | Default                             |
| ----------------------------- | -------------------- | ----------------------------------- |
| `db`                          | Database name        | `example`                           |
| `namespace`                   | Kubernetes namespace | `example`                           |
| `patroni.shards`              | Number of shards     | `1`                                 |
| `patroni.replicasPerShard`    | Replicas per shard   | `3`                                 |
| `pgdog.replicas`              | PgDog replicas       | `2`                                 |
| `pgdog.loadBalancingStrategy` | Load balancing       | `least_active_connections`          |
| `pgdog.readWriteSplit`        | Read/write routing   | `include_primary_if_replica_banned` |
| `backup.schedules.full`       | Full backup cron     | `0 2 * * 0` (Sunday 2 AM)           |
| `backup.schedules.diff`       | Diff backup cron     | `0 2 * * 3,6` (Wed/Sat)             |
| `backup.schedules.incr`       | Incr backup cron     | `0 2 * * 1,2,4,5`                   |
| `backup.retention.full`       | Full backups to keep | `4`                                 |
| `backup.retention.diff`       | Diff backups to keep | `2`                                 |

### Ports

| Port   | Service          | Purpose                 |
| ------ | ---------------- | ----------------------- |
| `5432` | PostgreSQL       | Database connections    |
| `6432` | PgDog            | Connection pooler       |
| `8008` | Patroni REST API | Health checks, failover |
| `8432` | pgBackRest       | Backup TLS server       |

## Security

1. **Superuser is local-only** - `postgres` user cannot connect remotely
2. **TLS for backups** - All backup traffic is encrypted
3. **Encrypted backups** - AES-256-CBC encryption at rest
4. **Least privilege** - Applications use `client` user with limited permissions
5. **Network isolation** - pg_hba.conf restricts access by user and database

## References

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Patroni Documentation](https://patroni.readthedocs.io/)
- [PgDog Documentation](https://docs.pgdog.dev/)
- [pgBackRest Documentation](https://pgbackrest.org/user-guide.html)
