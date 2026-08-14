# ClickHouse Helm chart

## R2 or S3-compatible MergeTree storage

Object storage is opt-in. When enabled, the chart configures an `r2` storage
policy backed by the provider's S3-compatible endpoint. Each replica writes to
its own prefix:

```text
<endpoint>/<bucket>/<path>/<cluster>/<shard>/<replica>/
```

Create a bucket-scoped Kubernetes Secret before installing the chart:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: clickhouse-object-storage-creds
type: Opaque
stringData:
  S3_ACCESS_KEY: replace-me
  S3_SECRET_KEY: replace-me
```

Configure the chart:

```yaml
objectStorage:
  enabled: true
  endpoint: https://<account-id>.r2.cloudflarestorage.com
  region: auto
  bucket: clickhouse
  path: data
  makeDefault: false
  credentials:
    secret: clickhouse-object-storage-creds
    dataKeys:
      accessKey: S3_ACCESS_KEY
      secretKey: S3_SECRET_KEY
  cache:
    enabled: true
    path: /var/lib/clickhouse/disks/r2_cache/
    maxSize: 10Gi
```

With `makeDefault: false`, opt individual tables into object storage:

```sql
CREATE TABLE events
(
    timestamp DateTime,
    message String
)
ENGINE = MergeTree
ORDER BY timestamp
SETTINGS storage_policy = 'r2';
```

`makeDefault: true` applies the policy to newly-created MergeTree tables. It
does not migrate existing tables.

The `/var/lib/clickhouse` volume remains required. Self-hosted ClickHouse keeps
object mappings and table metadata there, while the optional cache uses the same
volume. `ReplicatedMergeTree` replicas also retain separate copies in object
storage; this is not ClickHouse Cloud's SharedMergeTree architecture.
