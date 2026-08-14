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
without a local filesystem cache. Changing storage mode does not migrate
existing tables.

The `/var/lib/clickhouse` volume remains required. Self-hosted ClickHouse keeps
object mappings and table metadata there, while the optional cache uses the same
volume. `ReplicatedMergeTree` replicas also retain separate copies in object
storage; this is not ClickHouse Cloud's SharedMergeTree architecture.
