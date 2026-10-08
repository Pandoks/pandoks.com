# PostgreSQL High-Availability Cluster

Production-ready PostgreSQL cluster with automatic failover, connection pooling, sharding, and
continuous backups.

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
- **3 pods per shard** (1 primary + 2 replicas, configurable) with streaming replication
- **Leader election** via Kubernetes endpoints
- **Automatic recovery** from node failures
- **Extensions** - pg_cron, pgvector, PostGIS, and pg_stat_statements are available in the image.
  Fresh bootstrap attempts to create `pg_stat_statements` in the application database; create the
  other extensions in the target database as needed.

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
- **Restore on bootstrap** - a new shard whose stanza already has a full backup restores it instead
  of starting empty

### Monitoring

- **postgres-exporter** sidecar on every Patroni pod
- **ServiceMonitors** for Patroni and PostgreSQL metrics
- **Grafana dashboard** shipped as a ConfigMap

## Users & Permissions

| User         | Purpose               | Intended access                                  |
| ------------ | --------------------- | ------------------------------------------------ |
| `postgres`   | Superuser             | Full access, remote logins only to `postgres` db |
| `admin`      | Schema management     | CREATE/ALTER/DROP in `public`, remote access     |
| `client`     | Application queries   | SELECT/INSERT/UPDATE/DELETE                      |
| `replicator` | Streaming replication | Replication only                                 |
| `patroni`    | Patroni REST API      | Health checks, failover                          |

The initializer applies schema, table, sequence, and default privileges in `postgres`, not the
application database. Configure grants and ownership in the application database, including default
privileges for the role that creates tables, before using `admin` or `client` there.

**Security Note:** Remote logins (pod network only) to the application database are limited to
`admin` and `client` (see `pg_hba` in [patroni.yaml](./chart/files/patroni.yaml)). Use `admin` for
schema changes and `client` for applications.

## Requirements

The chart expects these to already be in the cluster (all provided by [k3s](/k3s/README.md)):

- `patroni` ClusterRole from [k3s/base/core/postgres.yaml](/k3s/base/core/postgres.yaml)
- `internal-ca-issuer` ClusterIssuer from
  [k3s/base/core/cert-manager.yaml](/k3s/base/core/cert-manager.yaml)
- Prometheus Operator CRDs for the `ServiceMonitor`s

## Quick Start

### 1. Create Secrets

The database secret is also mounted by PgDog, so it needs a `users.toml` key. Add both secrets to
[k3s/base/core/credentials.yaml](/k3s/base/core/credentials.yaml). The `${...}` values are SST
secrets defined in [infra/secrets.ts](/infra/secrets.ts).

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: postgres-myapp-creds
  namespace: myapp
type: Opaque
stringData:
  SUPERUSER_PASSWORD: ${MyappMyappPostgresSuperuserPassword | quote}
  ADMIN_PASSWORD: ${MyappMyappPostgresAdminPassword | quote}
  CLIENT_PASSWORD: ${MyappMyappPostgresClientPassword | quote}
  REPLICATION_PASSWORD: ${MyappMyappPostgresReplicationPassword | quote}
  PATRONI_PASSWORD: ${MyappMyappPostgresPatroniPassword | quote}
  users.toml: |
    [[users]]
    name = "admin"
    database = "myapp"
    password = "${MyappMyappPostgresAdminPassword}"

    [[users]]
    name = "client"
    database = "myapp"
    password = "${MyappMyappPostgresClientPassword}"

---
apiVersion: v1
kind: Secret
metadata:
  name: backup-bucket-creds
  namespace: myapp
type: Opaque
stringData:
  S3_ACCESS_KEY: ${CloudflareBackupAccessKey | quote}
  S3_SECRET_KEY: ${CloudflareBackupSecretKey | quote}
```

### 2. Deploy with HelmChart

```yaml
# apps/myapp/kube/postgres.yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: myapp-postgres-myapp-cluster
  namespace: kube-system
spec:
  chart: oci://${ImageRegistry}/charts/postgres
  version: 0.1.0
  targetNamespace: &namespace myapp
  createNamespace: true
  failurePolicy: abort
  plainHTTP: ${IsLocal}
  set:
    db: myapp
    namespace: *namespace
    credentials.secret: postgres-myapp-creds
    backup.path: kubernetes/myapp/postgres
    backup.image: ${ImageRegistry}/pgbackrest:${ImageTag}
    patroni.image: ${ImageRegistry}/patroni:${ImageTag}
    patroni.shards: 1
    patroni.replicasPerShard: 3
```

Add the file to `apps/myapp/kube/kustomization.yaml` and `apps/myapp/kube` to
[k3s/base/apps/kustomization.yaml](/k3s/base/apps/kustomization.yaml). See
[apps/example/kube/postgres.yaml](/apps/example/kube/postgres.yaml) for a full example.

### 3. Configure Sharding (Optional)

To enable sharding, add sharded tables configuration:

```yaml
spec:
  set:
    patroni.shards: 3
  valuesContent: |-
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
kubectl exec -it -n myapp deployment/myapp -- \
  psql -h myapp-pgdog -p 6432 -U client -d myapp
```

### Admin Connection (Direct)

```bash
# Connect to the shard's primary for schema changes (check `patronictl list` for the current leader)
kubectl exec -it -n myapp patroni-myapp-shard-0-0 -c patroni -- \
  psql -U admin -d myapp
```

## Common Operations

### Check Cluster Status

```bash
# Check shard 0 (repeat for each shard)
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

PITR allows you to restore a shard to any specific moment in time. This is useful for recovering
from accidental data deletion or corruption.

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

- After the oldest backup's completion time
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

Create a temporary pod from the StatefulSet's `patroni` container so it has the same env, config,
and volumes, with pod 0's PVCs mounted:

```bash
kubectl get statefulset patroni-myapp-shard-0 -n myapp -o json | jq '. as $sts | {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "pitr-restore", namespace: .metadata.namespace },
  spec: (.spec.template.spec
    | .containers |= map(select(.name == "patroni") | .args = ["sleep", "infinity"] | del(.readinessProbe))
    | .volumes += [$sts.spec.volumeClaimTemplates[].metadata.name
        | { name: ., persistentVolumeClaim: { claimName: "\(.)-\($sts.metadata.name)-0" } }])
}' | kubectl apply -f -

kubectl wait --for=condition=Ready pod/pitr-restore -n myapp --timeout=120s
kubectl exec -it pitr-restore -n myapp -- bash
```

#### Step 4: Perform PITR Restore

Inside the recovery pod, run pgbackrest restore with the target time. `delta=y` is set in
`pgbackrest.conf`, so the restore overwrites the existing data directory in place:

```bash
# Restore to specific point in time
pgbackrest --stanza=myapp-shard-0 \
  --type=time \
  --target="2024-01-15 14:30:00+00" \
  --target-action=promote \
  restore

# Alternative: Restore to the end of the archived WAL (latest state)
pgbackrest --stanza=myapp-shard-0 \
  --type=default \
  restore
```

**Recovery type options:**

- `--type=time --target="TIMESTAMP"` - Restore to specific time
- `--type=xid --target="TRANSACTION_ID"` - Restore to specific transaction
- `--type=lsn --target="WAL_LSN"` - Restore to specific WAL position
- `--type=immediate` - Stop as soon as the backup is consistent (no further WAL replay)
- `--type=default` - Restore and replay all available WAL

#### Step 5: Restart the Shard

After restore completes, delete the recovery pod and scale back up:

```bash
# Exit and delete the recovery pod
exit
kubectl delete pod pitr-restore -n myapp

# Delete stale Patroni endpoints (required after restore)
kubectl delete endpoints myapp-shard-0 myapp-shard-0-config -n myapp

# Scale the shard back up (to patroni.replicasPerShard)
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

- **Per-shard recovery**: Each shard has independent backups. You can recover one shard without
  affecting others.
- **Replica rebuilding**: After PITR, replicas will automatically rebuild from the restored primary
  via pgbackrest or basebackup.
- **Timeline changes**: PITR creates a new timeline. The `recovery_target_timeline: latest` setting
  in Patroni ensures replicas follow the new timeline.
- **Data consistency**: For sharded tables, recovering one shard to a different point in time may
  cause cross-shard inconsistencies. Plan accordingly.

### Scaling Shards

PgDog uses PostgreSQL's hash partition functions, so changing `patroni.shards` changes routing for
existing keys. Adding empty shards or moving only a removed shard's rows is not enough.

**Before either procedure**, stop application reads and writes, including background jobs, and
export the schema, data, and sequence state from every existing shard to storage outside the
cluster. Verify the export is complete and restorable before changing `patroni.shards`; keep traffic
stopped through reloading and validation below.

PgDog's [online resharding](https://docs.pgdog.dev/features/sharding/resharding/) is a separate
process requiring a new destination cluster and `schema_admin` users with replication permissions.
This chart does not provision those, and its default two PgDog replicas do not support the
documented single-instance automatic cutover. The procedures below use downtime.

#### Adding Shards (Scale Up)

**Step 1: Update Helm Values**

Increase the shard count in your HelmChart:

```yaml
spec:
  set:
    patroni.shards: 4 # Was 3, now 4
```

For `local` or `dev`, redeploy with `pnpm cluster deploy <env> --stage your-stage`. Replace `<env>`
with `local` or `dev` and `your-stage` with your personal SST stage (for example, `pandoks`). Prod
syncs from `main` through ArgoCD. This creates the new shard (`myapp-shard-3`) with its own
StatefulSet, services, certificates, and backup cronjobs.

**Step 2: Verify New Shard**

```bash
# Wait for new shard pods
kubectl get pods -n myapp -l cluster-name=myapp-shard-3 -w

# Check cluster health
kubectl exec -n myapp patroni-myapp-shard-3-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml list
```

**Step 3: Restart PgDog**

The chart regenerates PgDog's `databases` from `patroni.shards`, but PgDog pods don't restart on
config changes. Wait for the PgDog HelmChart update to finish and confirm the generated
configuration lists the new shard set before restarting:

```bash
kubectl rollout restart deploy/myapp-pgdog -n myapp
kubectl rollout status deploy/myapp-pgdog -n myapp
```

Confirm every serving PgDog instance uses the new shard set before reloading data.

**Step 4: Reload and Validate Data**

Ensure the schema matches the export on every destination shard. Added shards may restore old
backups, so clear old application table data on all destination shards before reloading to avoid
duplicate or stale rows. Re-insert the complete exported data through PgDog with the new shard count
and the configured sharding keys. Preserve unsharded and replicated tables and restore sequence
state as appropriate for the schema.

Before resuming application traffic, verify row counts against the export, key-based reads and
writes through PgDog, and that replicas have caught up. Keep the export until validation succeeds.

#### Removing Shards (Scale Down)

Export every shard with application traffic stopped as described above before lowering the shard
count. Removing shards changes routing for keys on the retained shards too.

**Step 1: Update Helm Values**

```yaml
spec:
  set:
    patroni.shards: 3 # Was 4, now 3
```

Redeploy, verify the remaining shards are healthy, and follow Step 3 above to restart PgDog and
verify its new routing before reloading. Keep application traffic stopped.

**Step 2: Reload and Validate Data**

Clear old table data on the remaining shards, re-insert the complete export through PgDog, and
restore sequence state and validate as in [Adding Shards](#adding-shards-scale-up), Step 4. Resume
application traffic only after validation succeeds.

**Step 3: Clean Up Leftover Resources**

Helm deletes the removed shard's StatefulSet, services, certificates, and backup cronjobs on
upgrade. Patroni's endpoints, cert-manager's TLS secrets, and the PVCs are left behind:

```bash
# Delete Patroni endpoints
kubectl delete endpoints myapp-shard-3 myapp-shard-3-config -n myapp

# Delete TLS secrets
kubectl delete secret patroni-myapp-shard-3-tls myapp-shard-3-pgbackrest-backup-tls -n myapp

# Delete PVCs (WARNING: This deletes all data!)
kubectl delete pvc -n myapp -l cluster-name=myapp-shard-3
```

The shard's backups stay in the bucket under its stanza (`myapp-shard-3`).

#### Scaling Replicas Per Shard

Scaling replicas within a shard is simpler and doesn't require data migration:

```yaml
spec:
  set:
    patroni.replicasPerShard: 5 # Was 3, now 5 pods per shard
```

Redeploy, then watch the new replicas clone from pgBackRest (falling back to `pg_basebackup`):

```bash
kubectl get pods -n myapp -w
```

To scale down replicas, lower `patroni.replicasPerShard`. Kubernetes terminates the highest-ordinal
pods, so switch over first if one of them is the leader. Their PVCs are kept, so delete them if you
don't plan to scale back up.

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

When you delete and recreate the cluster, stale DCS endpoints may prevent Patroni from
bootstrapping:

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
kubectl delete pods -n myapp -l 'cluster-name in (myapp-shard-0,myapp-shard-1,myapp-shard-2)'
```

If the stanza still has a full backup, the new primary restores it during bootstrap (see
[pgBackRest](#pgbackrest-backup--recovery)).

### Backup Job Fails with TLS Error

The chart issues per-shard certificates (`patroni-myapp-shard-N` and
`myapp-shard-N-pgbackrest-backup`) from `internal-ca-issuer`, with the shard's primary and replicas
service hostnames as `dnsNames`. If backup jobs fail with certificate errors, check that they're
ready:

```bash
kubectl get certificate -n myapp
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

These are the chart defaults, so make sure they aren't overridden:

```yaml
pgdog:
  lsnCheckDelay: 0 # Enable role detection immediately
  lsnCheckInterval: 1000 # Check every 1 second
  readWriteSplit: include_primary_if_replica_banned
```

## Local Development

Local k3d clusters pull the images and chart from the local registry (`localhost:12345` on your
machine, `local-registry:5000` inside the cluster). Build and push them at least once, and again
after changing them:

| Command                    | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| `pnpm build:patroni`       | Builds the patroni docker image locally                         |
| `pnpm build:pgbackrest`    | Builds the pgbackrest docker image locally                      |
| `pnpm build:helm`          | Packages the helm chart into a `.tgz` locally                   |
| `pnpm build`               | All of the build commands above                                 |
| `pnpm dev:push:patroni`    | Pushes the patroni image to the local k3d registry              |
| `pnpm dev:push:pgbackrest` | Pushes the pgbackrest image to the local k3d registry           |
| `pnpm dev:push:helm`       | Pushes the helm chart package to the local k3d registry via oci |
| `pnpm dev:push`            | All of the push commands above                                  |

`pnpm docker:build && pnpm dev:push` from the repo root does this for every package.

## Configuration Reference

### Values

| Key                             | Description                                 | Default                                                     |
| ------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `db`                            | Database name                               | `example`                                                   |
| `namespace`                     | Kubernetes namespace                        | `example`                                                   |
| `credentials.secret`            | Database credentials secret                 | `postgres-example-creds`                                    |
| `credentials.dataKeys.*`        | Password keys in that secret                | `SUPERUSER_PASSWORD`, `ADMIN_PASSWORD`, etc.                |
| `backup.credentials.secret`     | S3 credentials secret                       | `backup-bucket-creds`                                       |
| `backup.credentials.dataKeys.*` | Access/secret keys in that secret           | `S3_ACCESS_KEY`, `S3_SECRET_KEY`                            |
| `backup.bucket`                 | S3 bucket                                   | `backups`                                                   |
| `backup.path`                   | Path in the bucket                          | `kubernetes/examples/postgres`                              |
| `backup.encryptionKey`          | pgBackRest cipher passphrase                | `openssl-rand-hex-32` (placeholder, override it)            |
| `backup.image`                  | pgBackRest image                            | `ghcr.io/pandoks/pgbackrest:latest`                         |
| `backup.schedules.full`         | Full backup cron                            | `0 2 * * 0` (Sunday 2 AM)                                   |
| `backup.schedules.diff`         | Diff backup cron                            | `0 2 * * 3,6` (Wed/Sat)                                     |
| `backup.schedules.incr`         | Incr backup cron                            | `0 2 * * 1,2,4,5`                                           |
| `backup.retention.full`         | Full backups to keep                        | `4`                                                         |
| `backup.retention.diff`         | Diff backups to keep                        | `2`                                                         |
| `s3.region`                     | S3 region                                   | `us-west-1`                                                 |
| `s3.host`                       | S3 endpoint                                 | `host.k3d.internal:4566` (LocalStack from `docker-compose`) |
| `s3.tls`                        | Verify S3 TLS (`y`/`n`)                     | `n`                                                         |
| `s3.uriStyle`                   | S3 URI style                                | `path`                                                      |
| `patroni.shards`                | Number of shards                            | `1`                                                         |
| `patroni.replicasPerShard`      | Pods per shard (1 primary + n - 1 replicas) | `3`                                                         |
| `patroni.image`                 | Patroni image                               | `ghcr.io/pandoks/patroni:latest`                            |
| `patroni.resources.*`           | `patroni`, `pgbackrest`, `postgresExporter` | `{}`                                                        |
| `pgdog.*`                       | Passed through to the [PgDog chart][pgdog]  | See below                                                   |
| `pgdog.replicas`                | PgDog replicas                              | `2`                                                         |
| `pgdog.workers`                 | PgDog worker threads                        | `2`                                                         |
| `pgdog.defaultPoolSize`         | Server connections per pool                 | `15`                                                        |
| `pgdog.loadBalancingStrategy`   | Load balancing                              | `least_active_connections`                                  |
| `pgdog.readWriteSplit`          | Read/write routing                          | `include_primary_if_replica_banned`                         |

[pgdog]: https://github.com/pgdogdev/helm/blob/main/values.yaml

### Ports

| Port   | Service           | Purpose                 |
| ------ | ----------------- | ----------------------- |
| `5432` | PostgreSQL        | Database connections    |
| `6432` | PgDog             | Connection pooler       |
| `8008` | Patroni REST API  | Health checks, failover |
| `8432` | pgBackRest        | Backup TLS server       |
| `9187` | postgres-exporter | PostgreSQL metrics      |
| `9090` | PgDog             | OpenMetrics             |

## Security

1. **Superuser stays off app databases** - `postgres` can only log in remotely to the `postgres`
   database
2. **TLS for backups** - All backup traffic is encrypted
3. **Encrypted backups** - AES-256-CBC encryption at rest
4. **Least privilege** - Applications use `client` user with limited permissions
5. **Network isolation** - pg_hba.conf restricts access by user and database

## References

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Patroni Documentation](https://patroni.readthedocs.io/)
- [PgDog Documentation](https://docs.pgdog.dev/)
- [pgBackRest Documentation](https://pgbackrest.org/user-guide.html)
