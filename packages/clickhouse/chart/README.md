# ClickHouse Helm chart

## R2 or S3-compatible MergeTree storage

Set `storage.mode` to choose where MergeTree tables store their data:

- `local`: use the local SSD only (default).
- `object`: make S3-compatible object storage the default for new tables.
- `mixed`: keep the local SSD as the default and expose an `object` policy for
  individual tables.

The chart automatically gives each replica its own prefix:

```text
<endpoint>/<bucket>/clickhouse/<namespace>/<cluster>/<shard>/<replica>/
```

Create a bucket-scoped Kubernetes Secret before installing the chart:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: clickhouse-object-storage-creds
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: replace-me
  AWS_SECRET_ACCESS_KEY: replace-me
```

Configure the chart:

```yaml
storage:
  mode: object
  object:
    endpoint: https://<account-id>.r2.cloudflarestorage.com
    region: auto
    bucket: clickhouse
    credentialsSecret: clickhouse-object-storage-creds
    cacheSize: 10Gi
```

With `storage.mode: mixed`, opt individual tables into object storage:

```sql
CREATE TABLE events
(
    timestamp DateTime,
    message String
)
ENGINE = MergeTree
ORDER BY timestamp
SETTINGS storage_policy = 'object';
```

Set `storage.object.cacheSize` to `"0"` to read directly from object storage
without a local filesystem cache.

`object` is safe for a new deployment. Do not switch an existing deployment
from `local` or `mixed` directly to `object`: ClickHouse does not migrate local
parts automatically, and those tables will fail to attach because the new
default policy does not contain the local disk. Use `mixed`, create a replacement
table with `storage_policy = 'object'`, copy and validate the data, then swap the
tables. ClickHouse rejects directly changing a local table to this chart's
`object` policy because that policy intentionally excludes the local volume.

The `/var/lib/clickhouse` volume remains required. Self-hosted ClickHouse keeps
object mappings and table metadata there, while the optional cache uses the same
volume. `ReplicatedMergeTree` replicas also retain separate copies in object
storage; this is not ClickHouse Cloud's SharedMergeTree architecture.
