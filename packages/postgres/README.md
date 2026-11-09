# PostgreSQL High-Availability Cluster

Production-ready PostgreSQL cluster with automatic failover, connection pooling, Citus sharding, and
continuous backups.

## Architecture

```mermaid
graph TB
    subgraph "Client Applications"
        App[Application]
    end

    subgraph "Connection Layer - Port 6432"
        PgBouncer[PgBouncer<br/>2+ replicas]
    end

    subgraph "Group 0 - Coordinator"
        G0P[Patroni Pod 0-0<br/>Primary]
        G0R1[Patroni Pod 0-1<br/>Replica]
        G0R2[Patroni Pod 0-2<br/>Replica]
    end

    subgraph "Group 1 - Worker"
        G1P[Patroni Pod 1-0<br/>Primary]
        G1R1[Patroni Pod 1-1<br/>Replica]
    end

    subgraph "Group N - Worker..."
        GNP[Patroni Pod N-0<br/>Primary]
    end

    subgraph "Backup System"
        BackupJobs[Backup CronJobs<br/>Per Group]
        RestorePoint[Restore Point CronJob]
        S3[S3 Storage<br/>Encrypted]
    end

    App -->|client user| PgBouncer
    PgBouncer -->|myapp| G0P
    PgBouncer -->|myapp_replicas| G0R1
    G0P -->|Citus distributed queries| G1P
    G0P -->|Citus distributed queries| GNP

    G0P -.->|Streaming Replication| G0R1
    G0P -.->|Streaming Replication| G0R2
    G1P -.->|Streaming Replication| G1R1

    BackupJobs -->|TLS| G0P
    BackupJobs -->|TLS| G1P
    BackupJobs --> S3
    RestorePoint --> G0P

    style G0P fill:#90EE90
    style G1P fill:#90EE90
    style GNP fill:#90EE90
    style G0R1 fill:#87CEEB
    style G0R2 fill:#87CEEB
    style G1R1 fill:#87CEEB
    style PgBouncer fill:#FFD700
```

## Components

### Patroni (High Availability)

- **PostgreSQL 18** with automatic failover
- **One Patroni cluster per Citus group** - group 0 is the coordinator, groups 1..n are workers, all
  sharing one Patroni `scope` (the database name)
- **3 pods per group** (1 primary + 2 replicas, configurable) with quorum synchronous replication,
  which Patroni enables for Citus
- **Leader election** via Kubernetes endpoints
- **Automatic recovery** from node failures
- **Extensions** - Citus, pg_cron, pgvector, PostGIS, and pg_stat_statements are available in the
  image. Fresh bootstrap creates `citus` and `pg_stat_statements` in the application database;
  create the other extensions on the coordinator as needed.

### Citus (Sharding)

- **Native Patroni support** ([docs](https://patroni.readthedocs.io/en/latest/citus.html)) - Patroni
  creates the extension, registers workers in `pg_dist_node`, and updates it on every failover and
  switchover
- **Starts single-node** - with `patroni.workers: 0` the coordinator holds every shard, so
  distributed and reference tables work from day one
- **Scales out** by adding worker groups and rebalancing shards onto them (see [Scaling](#scaling))

### PgBouncer (Connection Pooling)

- **Transaction pooling** in front of the coordinator primary
- **Read-only pool** - the `<db>_replicas` database points at the coordinator's replicas, with
  `default_transaction_read_only` on so a pooled connection to a promoted replica still can't write.
  Once workers exist, only tables on the coordinator are read from those replicas: Citus reads the
  workers' shards from their primaries, since `citus.use_secondary_nodes` defaults to `never`
- **Authenticates** with `admin` and `client` from the database secret's `userlist.txt`

### pgBackRest (Backup & Recovery)

- **Per-group backups** - each group has its own stanza (`myapp-group-N`)
- **Automated schedules** - full, differential, and incremental backups
- **Cluster-wide restore points** - a CronJob runs `citus_create_restore_point()`, the only targets
  every group can be restored to consistently
- **Encryption** - AES-256-CBC for all backups
- **S3-compatible storage** - works with AWS S3, MinIO, LocalStack
- **Restore on bootstrap** - a new group whose stanza already has a full backup restores it instead
  of starting empty, up to the end of its own archived WAL. That's only consistent when a single
  worker group is lost; after losing the coordinator or several groups, follow
  [PITR](#point-in-time-recovery-pitr) instead

### Monitoring

- **postgres-exporter** sidecar on every Patroni pod
- **ServiceMonitors** for Patroni and PostgreSQL metrics
- **Grafana dashboard** shipped as a ConfigMap

## Users & Permissions

| User         | Purpose               | Intended access                                     |
| ------------ | --------------------- | --------------------------------------------------- |
| `postgres`   | Superuser             | Full access; Citus uses it between nodes            |
| `admin`      | Schema management     | CREATE/ALTER/DROP in `public`, remote access        |
| `client`     | Application queries   | SELECT/INSERT/UPDATE/DELETE                         |
| `replicator` | Streaming replication | Replication only                                    |
| `patroni`    | Patroni REST API      | Health checks, failover, worker to coordinator APIs |

The initializer creates `admin` and `client` on the coordinator, in the application database, and
Citus copies them to every worker. Citus connects to workers as the querying user, so their
passwords are also stored in `pg_dist_authinfo`. `client` automatically gets its access to tables,
sequences, and functions that `admin` creates in `public`.

**Security Note:** Remote logins (pod network only) to the application database are limited to
`postgres`, `admin` and `client` (see `pg_hba` in [patroni.yaml](./chart/files/patroni.yaml)). Use
`admin` for schema changes and `client` for applications.

## Requirements

The chart expects these to already be in the cluster (all provided by [k3s](/k3s/README.md)):

- `patroni` ClusterRole from [k3s/base/core/postgres.yaml](/k3s/base/core/postgres.yaml)
- `internal-ca-issuer` ClusterIssuer from
  [k3s/base/core/cert-manager.yaml](/k3s/base/core/cert-manager.yaml)
- Prometheus Operator CRDs for the `ServiceMonitor`s

## Quick Start

### 1. Create Secrets

PgBouncer mounts the database secret's `userlist.txt` key as its `auth_file`. Add both secrets to
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
  userlist.txt: |
    "admin" "${MyappMyappPostgresAdminPassword}"
    "client" "${MyappMyappPostgresClientPassword}"

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
  version: 0.2.0
  targetNamespace: &namespace myapp
  createNamespace: true
  failurePolicy: abort
  timeout: 30m
  plainHTTP: ${IsLocal}
  set:
    db: myapp
    namespace: *namespace
    credentials.secret: postgres-myapp-creds
    backup.path: kubernetes/myapp/postgres
    backup.image: ${ImageRegistry}/pgbackrest:${ImageTag}
    patroni.image: ${ImageRegistry}/patroni:${ImageTag}
    patroni.reconcilerImage: ${ImageRegistry}/postgres-reconciler:${ImageTag}
    patroni.workers: 0
    patroni.replicasPerGroup: 3
```

Add the file to `apps/myapp/kube/kustomization.yaml` and `apps/myapp/kube` to
[k3s/base/apps/kustomization.yaml](/k3s/base/apps/kustomization.yaml). See
[apps/example/kube/postgres.yaml](/apps/example/kube/postgres.yaml) for a full example.

To pin Patroni to the dedicated database nodes (label and taint `role=db`), patch the HelmChart in
the cloud overlay, since local k3d has no such nodes. Put the patch in the app's
`cluster-patch.yaml` and add it to the `patches` in
[k3s/overlays/cluster/kustomization.yaml](/k3s/overlays/cluster/kustomization.yaml), which `dev` and
`prod` share:

```yaml
# apps/myapp/kube/cluster-patch.yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: myapp-postgres-myapp-cluster
  namespace: kube-system
spec:
  set:
    nodeSelector.role: db
    tolerations[0].key: role
    tolerations[0].operator: Equal
    tolerations[0].value: db
    tolerations[0].effect: NoSchedule
```

## Connecting to PostgreSQL

### Application Connection (via PgBouncer)

```bash
# Reads and writes, on the coordinator primary
postgresql://client:CLIENT_PASSWORD@myapp-pgbouncer:6432/myapp

# Reads only, on the coordinator replicas
postgresql://client:CLIENT_PASSWORD@myapp-pgbouncer:6432/myapp_replicas

# Using psql from a pod
kubectl exec -it -n myapp deployment/myapp -- \
  psql -h myapp-pgbouncer -p 6432 -U client -d myapp
```

PgBouncer runs in transaction mode, so session state (`SET`, advisory locks, `LISTEN`) doesn't
survive between transactions. Set `pgbouncer.settings` for any
[PgBouncer setting](https://www.pgbouncer.org/config.html).

### Admin Connection (Direct)

Schema changes go to the coordinator primary, and Citus applies them to every worker. The commands
below find that pod with:

```bash
coordinator="$(kubectl get pod -n myapp -l app=patroni-myapp,citus-group=0,role=primary -o name)"

kubectl exec -it -n myapp "${coordinator}" -c patroni -- psql -U admin -d myapp
```

## Schema Design

Citus spreads a **distributed table** across shards by its distribution column, and copies a
**reference table** to every node. Plain tables stay on the coordinator.

```sql
CREATE TABLE events (
  tenant_id bigint,
  id bigint,
  payload jsonb,
  PRIMARY KEY (tenant_id, id)
);
SELECT create_distributed_table('events', 'tenant_id');

CREATE TABLE countries (code text PRIMARY KEY, name text);
SELECT create_reference_table('countries');
```

- Every primary key and unique constraint on a distributed table must include its distribution
  column, since Citus can only enforce uniqueness within a shard.
- Pick a distribution column most queries filter on (like a tenant id) and use the same one for
  tables you join, so joins stay on one node. Distribute related tables with
  `colocate_with => '<table>'`.
- Use reference tables for small lookup tables that distributed tables join or reference with
  foreign keys.

See [Citus table types](https://docs.citusdata.com/en/stable/develop/migration.html).

## Common Operations

### Check Cluster Status

```bash
# Every group, coordinator and workers
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml list

# Nodes Citus routes to
kubectl exec -n myapp "${coordinator}" -c patroni -- psql -d myapp -c "SELECT * FROM pg_dist_node;"
```

### Manual Failover

```bash
# Switchover within a group
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml switchover --group 0 \
  --leader patroni-myapp-group-0-0 \
  --candidate patroni-myapp-group-0-1 \
  --force
```

Patroni updates `pg_dist_node` on the coordinator, so queries resume through PgBouncer. During a
worker switchover Citus pauses queries to that worker instead of failing them. When a pod dies
instead, queries to its group can fail for up to `citus.node_connection_timeout` (30 s).

### Change Postgres Settings

Set `patroni.parameters` in the HelmChart. New clusters start with them, and after every install,
upgrade and rollback a [reconciler](./reconciler) Job (`apply-parameters`) applies them to each
group. Helm waits for the Job, which waits for a new cluster to restore its backup, so a restore
longer than the HelmChart's `timeout` fails the release, and `failurePolicy: abort` then holds every
later upgrade until you fix it. Size `timeout` to your largest restore. Settings Postgres can
reload, like `work_mem`, take effect within seconds. Ones that need a restart, like
`shared_buffers`, show under `Pending restart` until you restart each group in place:

```bash
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml restart myapp --group 0 --pending --force
```

The Job also succeeds on a misspelled name or invalid value: Patroni skips it and only logs that in
the `patroni` container, so check the result with `SHOW <setting>`. Helm deletes a failed Job along
with its logs, so follow them during the release:

```bash
kubectl logs -n myapp job/patroni-myapp-parameters -f
```

### Upgrading Citus

A Citus patch release only needs the new image. After a minor or major release rolls out, Citus
refuses distributed queries until its extension is updated on each group's primary, workers first,
and then finished on the coordinator
([docs](https://docs.citusdata.com/en/stable/admin_guide/upgrading_citus.html)):

```bash
for group in 1 2 0; do # every worker group, then the coordinator (group 0)
  primary="$(kubectl get pod -n myapp -l "app=patroni-myapp,citus-group=${group},role=primary" -o name)"
  kubectl exec -n myapp "${primary}" -c patroni -- psql -d myapp -c "ALTER EXTENSION citus UPDATE;"
done

kubectl exec -n myapp "${coordinator}" -c patroni -- \
  psql -d myapp -c "CALL citus_finish_citus_upgrade();"
```

### Backup Operations

```bash
# Trigger manual backup (repeat for each group)
kubectl create job --from=cronjob/myapp-group-0-pgbackrest-backup-full manual-backup -n myapp

# Check backup status
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  pgbackrest --stanza=myapp-group-0 info

# Create a restore point now
kubectl create job --from=cronjob/myapp-citus-restore-point manual-restore-point -n myapp
```

### Point-in-Time Recovery (PITR)

Each group has its own WAL, so restoring groups to the same timestamp can split a distributed
transaction. Restore every group to the same **restore point** instead: a named WAL record
`citus_create_restore_point()` writes on every node while it blocks distributed commits.

#### Step 1: Pick a Restore Point and Backups

The `myapp-citus-restore-point` CronJob creates one every `backup.restorePointSchedule`, named after
the UTC minute it ran (`YYYYMMDDTHHMMZ`, like `20260115T1430Z`). The last three runs log it:

```bash
kubectl get jobs -n myapp -o name | grep citus-restore-point | xargs -n 1 kubectl logs -n myapp
```

After losing groups, use the newest restore point every group has archived. A group archives its WAL
at least every `archive_timeout` (5 minutes), so pick one created at least that long before the
loss; Step 4 fails for a group that doesn't have it.

For each group, pick a backup that finished before the restore point, since pgBackRest restores the
latest backup by default:

```bash
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  pgbackrest --stanza=myapp-group-0 info
```

#### Step 2: Stop Every Group

Stop the workers first, since a worker primary notifies the coordinator before it stops:

```bash
kubectl scale statefulset -n myapp -l 'app=patroni-myapp,citus-group!=0' --replicas=0
kubectl wait --for=delete pod -n myapp -l 'app=patroni-myapp,citus-group!=0' --timeout=300s
kubectl scale statefulset -n myapp patroni-myapp-group-0 --replicas=0
kubectl wait --for=delete pod -n myapp -l app=patroni-myapp --timeout=300s
```

#### Step 3: Prepare a Recovery Pod per Group

Create a temporary pod from each group's StatefulSet `patroni` container so it has the same env,
config, and volumes, with pod 0's PVCs mounted:

```bash
groups="0 1 2" # every group: 0 through patroni.workers

for group in ${groups}; do
  kubectl get statefulset "patroni-myapp-group-${group}" -n myapp -o json | jq --arg group "${group}" '. as $sts | {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "pitr-restore-\($group)", namespace: .metadata.namespace },
    spec: (.spec.template.spec
      | .containers |= map(select(.name == "patroni") | .args = ["sleep", "infinity"] | del(.readinessProbe))
      | .volumes += [$sts.spec.volumeClaimTemplates[].metadata.name
          | { name: ., persistentVolumeClaim: { claimName: "\(.)-\($sts.metadata.name)-0" } }])
  }' | kubectl apply -f -
done

for group in ${groups}; do
  kubectl wait --for=condition=Ready "pod/pitr-restore-${group}" -n myapp --timeout=120s
done
```

#### Step 4: Restore Every Group

`delta=y` is set in `pgbackrest.conf`, so the restore overwrites the existing data directory in
place. Add `--set=<backup label>` when a group's latest backup is newer than the restore point.
Postgres then replays WAL up to the restore point and promotes inside the recovery pod, because
Patroni drops recovery targets and would promote too early. The loop fails if Postgres exits
instead, and `/tmp/pitr.log` in that recovery pod says why. If pgBackRest refuses because
`postmaster.pid` exists, that pod was killed before Postgres stopped; delete the file in its
recovery pod and rerun:

```bash
target=20260115T1430Z

for group in ${groups}; do
  kubectl exec -n myapp "pitr-restore-${group}" -- sh -ec '
    pgbackrest --stanza="${STANZA}" --type=name --target="$1" --target-action=promote restore
    pg_ctl start -W -D /var/lib/postgresql/pgdata -l /tmp/pitr.log
    until [ "$(psql -XAtc "SELECT pg_is_in_recovery()")" = f ]; do
      sleep 5
      pg_ctl status -D /var/lib/postgresql/pgdata > /dev/null
    done
    pg_ctl stop -w -D /var/lib/postgresql/pgdata' sh "${target}"
done
```

#### Step 5: Restart Every Group

Delete the recovery pods and Patroni's state, then scale back up (to `patroni.replicasPerGroup`):

```bash
for group in ${groups}; do kubectl delete pod -n myapp "pitr-restore-${group}"; done
kubectl delete endpoints -n myapp -l cluster-name=myapp
kubectl scale statefulset -n myapp -l app=patroni-myapp --replicas=3

kubectl get pods -n myapp -l app=patroni-myapp -w
```

Each group's pod 0 takes the leader lock with its restored data, and Patroni points `pg_dist_node`
at the new primaries. A replica whose old data is past the restore point shows `start failed`
(`requested timeline N is not a child of this server's history` in its log); rebuild it from its
group's new primary:

```bash
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml reinit myapp patroni-myapp-group-0-1 --group 0 --force
```

#### Step 6: Verify Recovery

```bash
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml list

kubectl exec -n myapp "${coordinator}" -c patroni -- psql -d myapp -c "SELECT MAX(created_at) FROM your_table;"
```

If a group never reaches the restore point (a wrong name, or a backup newer than it), Step 4 fails
for it with `recovery ended before configured recovery target was reached` in `/tmp/pitr.log`; redo
Step 4 for that group with the right name or `--set` before Step 5.

## Scaling

### Adding Workers

Raise `patroni.workers` in the HelmChart:

```yaml
spec:
  set:
    patroni.workers: 2 # Was 0
```

For `local` or `dev`, redeploy with `pnpm cluster deploy <env> --stage your-stage`. Replace `<env>`
with `local` or `dev` and `your-stage` with your personal SST stage (for example, `pandoks`). Prod
syncs from `main` through ArgoCD. This creates each new group (`myapp-group-1`, ...) with its own
StatefulSet, services, certificates, and backup CronJobs, and Patroni adds its primary to
`pg_dist_node`. Wait for it there, then move shards onto the new workers from the coordinator
primary:

```bash
kubectl exec -n myapp "${coordinator}" -c patroni -- psql -d myapp -c "SELECT citus_rebalance_start();"

# Watch until state is finished
kubectl exec -n myapp "${coordinator}" -c patroni -- psql -d myapp -c "SELECT * FROM citus_rebalance_status();"
```

The rebalance moves shards online with logical replication. The coordinator keeps its share of
shards; to move them all to the workers, first run
`SELECT citus_set_node_property(nodename, nodeport, 'shouldhaveshards', false) FROM pg_dist_node WHERE groupid = 0 AND noderole = 'primary';`.

### Removing Workers

Lowering `patroni.workers` deletes the highest groups' StatefulSets, so drain them first. For each
group being removed, from the coordinator primary:

```sql
SELECT citus_drain_node(nodename, nodeport) FROM pg_dist_node WHERE groupid = 2 AND noderole = 'primary';
SELECT citus_remove_node(nodename, nodeport) FROM pg_dist_node WHERE groupid = 2;
```

Raising `patroni.workers` again later restores the group's stanza (`myapp-group-2`) on bootstrap,
with its old data and Citus catalog. Unless you want that, delete the stanza while the group still
runs:

```bash
kubectl exec -n myapp patroni-myapp-group-2-0 -c patroni -- pgbackrest --stanza=myapp-group-2 stop
kubectl exec -n myapp patroni-myapp-group-2-0 -c patroni -- \
  pgbackrest --stanza=myapp-group-2 stanza-delete --force
```

Then lower `patroni.workers` and redeploy. Helm deletes the group's StatefulSet, services,
certificates, and backup CronJobs. Patroni's endpoints and `-config` Service, cert-manager's TLS
secrets, and the PVCs are left behind:

```bash
kubectl delete endpoints,service -n myapp -l cluster-name=myapp,citus-group=2
kubectl delete secret patroni-myapp-group-2-tls myapp-group-2-pgbackrest-backup-tls -n myapp

# WARNING: This deletes all data in the group!
kubectl delete pvc -n myapp -l app=patroni-myapp,citus-group=2
```

### Scaling Replicas Per Group

```yaml
spec:
  set:
    patroni.replicasPerGroup: 5 # Was 3, now 5 pods per group
```

Redeploy, then watch the new replicas clone from pgBackRest (falling back to `pg_basebackup`):

```bash
kubectl get pods -n myapp -w
```

To scale down replicas, lower `patroni.replicasPerGroup`. Kubernetes terminates the highest-ordinal
pods, so switch over first if one of them is a leader. Their PVCs are kept, so delete them if you
don't plan to scale back up.

## Troubleshooting

### Cluster Won't Start After Deletion

When you delete and recreate the cluster, stale DCS endpoints may prevent Patroni from
bootstrapping:

```
waiting for leader to bootstrap
```

**Fix:** Delete Patroni's endpoints for every group and restart the pods:

```bash
kubectl delete endpoints -n myapp -l cluster-name=myapp
kubectl delete pods -n myapp -l app=patroni-myapp
```

If a group's stanza still has a full backup, its new primary restores it during bootstrap (see
[pgBackRest](#pgbackrest-backup--recovery)), to the end of that group's own archived WAL. That's
only consistent when a single worker group was lost. After losing the coordinator or several groups,
the groups can come back at different points, so restore every group with
[PITR](#point-in-time-recovery-pitr) to the newest restore point archived on every group.

A restored coordinator stops syncing Citus metadata to the workers' old addresses so it can start;
once every group is up, sync it again, which pushes the coordinator's restored metadata to every
worker:

```bash
kubectl exec -n myapp "${coordinator}" -c patroni -- \
  psql -d myapp -c "SELECT start_metadata_sync_to_all_nodes();"
```

### Distributed Queries Fail to Authenticate

Citus connects to workers with the superuser, `admin` and `client` passwords in `pg_dist_authinfo`.
After changing one of them, update it on the coordinator primary too, escaping `\` and `'` in the
password with `\`, then doubling every `'` for SQL:

```sql
UPDATE pg_dist_authinfo SET authinfo = 'password=''<new password>''' WHERE rolename = 'client';
```

PgBouncer mounts `userlist.txt` with `subPath`, which never sees secret changes, so restart it after
changing `admin` or `client`:

```bash
kubectl rollout restart deployment/myapp-pgbouncer -n myapp
```

### Backup Job Fails with TLS Error

The chart issues per-group certificates (`patroni-myapp-group-N` and
`myapp-group-N-pgbackrest-backup`) from `internal-ca-issuer`, with the group's primary and replicas
service hostnames as `dnsNames`. If backup jobs fail with certificate errors, check that they're
ready:

```bash
kubectl get certificate -n myapp
```

### Replication Lag

```bash
# Check replication status
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# Check Patroni cluster view
kubectl exec -n myapp patroni-myapp-group-0-0 -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml list
```

## Local Development

Local k3d clusters pull the images and chart from the local registry (`localhost:12345` on your
machine, `local-registry:5000` inside the cluster). Build and push them at least once, and again
after changing them:

| Command                       | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `pnpm local:build:patroni`    | Builds the patroni docker image locally                         |
| `pnpm local:build:pgbackrest` | Builds the pgbackrest docker image locally                      |
| `pnpm local:build:reconciler` | Builds the postgres-reconciler docker image locally             |
| `pnpm local:build:helm`       | Packages the helm chart into a `.tgz` locally                   |
| `pnpm local:build`            | All of the build commands above                                 |
| `pnpm local:push:patroni`     | Pushes the patroni image to the local k3d registry              |
| `pnpm local:push:pgbackrest`  | Pushes the pgbackrest image to the local k3d registry           |
| `pnpm local:push:reconciler`  | Pushes the postgres-reconciler image to the local k3d registry  |
| `pnpm local:push:helm`        | Pushes the helm chart package to the local k3d registry via oci |
| `pnpm local:push`             | All of the push commands above                                  |
| `pnpm test`                   | Runs the reconciler Go tests                                    |

`pnpm local:build && pnpm local:push` from the repo root does this for every package.

## Configuration Reference

### Values

| Key                                      | Description                                        | Default                                                     |
| ---------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `db`                                     | Database name, also the Citus database             | `example`                                                   |
| `namespace`                              | Kubernetes namespace                               | `example`                                                   |
| `credentials.secret`                     | Database credentials secret                        | `postgres-example-creds`                                    |
| `credentials.dataKeys.*`                 | Password keys in that secret                       | `SUPERUSER_PASSWORD`, `ADMIN_PASSWORD`, etc.                |
| `credentials.dataKeys.pgbouncerUserlist` | PgBouncer `auth_file` key in that secret           | `userlist.txt`                                              |
| `backup.enabled`                         | Backups and WAL archiving; set before first create | `true`                                                      |
| `backup.credentials.secret`              | S3 credentials secret                              | `backup-bucket-creds`                                       |
| `backup.credentials.dataKeys.*`          | Access/secret keys in that secret                  | `S3_ACCESS_KEY`, `S3_SECRET_KEY`                            |
| `backup.bucket`                          | S3 bucket                                          | `backups`                                                   |
| `backup.path`                            | Path in the bucket                                 | `kubernetes/examples/postgres`                              |
| `backup.encryptionKey`                   | pgBackRest cipher passphrase                       | `openssl-rand-hex-32` (placeholder, override it)            |
| `backup.image`                           | pgBackRest image                                   | `ghcr.io/pandoks/pgbackrest:latest`                         |
| `backup.schedules.full`                  | Full backup cron                                   | `0 2 * * 0` (Sunday 2 AM)                                   |
| `backup.schedules.diff`                  | Diff backup cron                                   | `0 2 * * 3,6` (Wed/Sat)                                     |
| `backup.schedules.incr`                  | Incr backup cron                                   | `0 2 * * 1,2,4,5`                                           |
| `backup.retention.full`                  | Full backups to keep                               | `4`                                                         |
| `backup.retention.diff`                  | Diff backups to keep                               | `2`                                                         |
| `backup.restorePointSchedule`            | Citus restore point cron                           | `*/15 * * * *`                                              |
| `s3.region`                              | S3 region                                          | `us-west-1`                                                 |
| `s3.host`                                | S3 endpoint                                        | `host.k3d.internal:4566` (LocalStack from `docker-compose`) |
| `s3.tls`                                 | Verify S3 TLS (`y`/`n`)                            | `n`                                                         |
| `s3.uriStyle`                            | S3 URI style                                       | `path`                                                      |
| `patroni.workers`                        | Citus worker groups (0 = coordinator only)         | `0`                                                         |
| `patroni.replicasPerGroup`               | Pods per group (1 primary + n - 1 replicas)        | `3`                                                         |
| `patroni.image`                          | Patroni image                                      | `ghcr.io/pandoks/patroni:latest`                            |
| `patroni.reconcilerImage`                | Image of the Job that applies `patroni.parameters` | `ghcr.io/pandoks/postgres-reconciler:latest`                |
| `patroni.parameters.*`                   | Postgres settings, applied to running clusters     | `max_connections: 100`, `shared_buffers: 128MB`, etc.       |
| `patroni.resources.*`                    | `patroni`, `pgbackrest`, `postgresExporter`        | `{}`                                                        |
| `pgbouncer.image`                        | PgBouncer image                                    | `ghcr.io/cloudnative-pg/pgbouncer`                          |
| `pgbouncer.replicas`                     | PgBouncer replicas                                 | `2`                                                         |
| `pgbouncer.settings.*`                   | `[pgbouncer]` settings in `pgbouncer.ini`          | `pool_mode: transaction`, `default_pool_size: 15`, etc.     |
| `pgbouncer.resources`                    | PgBouncer resources                                | `{}`                                                        |

### Ports

| Port   | Service           | Purpose                 |
| ------ | ----------------- | ----------------------- |
| `5432` | PostgreSQL        | Database connections    |
| `6432` | PgBouncer         | Connection pooler       |
| `8008` | Patroni REST API  | Health checks, failover |
| `8432` | pgBackRest        | Backup TLS server       |
| `9187` | postgres-exporter | PostgreSQL metrics      |

## Security

1. **Superuser stays off the app database for clients** - `postgres` logs in remotely only to
   `postgres` and, for Citus between nodes, the application database
2. **TLS between nodes** - Citus connects with `sslmode=require`, using the self-signed certificate
   it generates
3. **TLS for backups** - All backup traffic is encrypted
4. **Encrypted backups** - AES-256-CBC encryption at rest
5. **Least privilege** - Applications use `client` user with limited permissions
6. **Network isolation** - pg_hba.conf restricts access by user and database

## References

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Patroni Documentation](https://patroni.readthedocs.io/)
- [Patroni Citus support](https://patroni.readthedocs.io/en/latest/citus.html)
- [Citus Documentation](https://docs.citusdata.com/)
- [PgBouncer Documentation](https://www.pgbouncer.org/config.html)
- [pgBackRest Documentation](https://pgbackrest.org/user-guide.html)
