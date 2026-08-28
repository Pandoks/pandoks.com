# ClickHouse Helm chart

## R2 or S3-compatible MergeTree storage

MergeTree tables use a `tiered` storage policy. With no object endpoint, the
policy contains only the local SSD. Adding an endpoint makes object storage
available as a second volume; it does not move any data automatically.

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
  object:
    endpoint: https://<account-id>.r2.cloudflarestorage.com
    region: auto
    bucket: clickhouse
    credentialsSecret: clickhouse-object-storage-creds
    cacheSize: 10Gi
```

Cloudflare R2 uses `region: auto`. For AWS S3, set the bucket's actual region.
The credentials stay in the Kubernetes Secret; Helm values contain only its
name.

After adding object storage, move a partition to it explicitly:

```sql
ALTER TABLE events
MOVE PARTITION 202608 TO VOLUME 'object';
```

Move it back to local SSD with:

```sql
ALTER TABLE events
MOVE PARTITION 202608 TO VOLUME 'default';
```

Use a table TTL when older data should move automatically:

```sql
ALTER TABLE events
MODIFY TTL timestamp + INTERVAL 30 DAY TO VOLUME 'object';
```

The optional strict `object` policy writes a new table directly to object
storage:

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

Do not remove the endpoint while any active part uses the `object` disk or any
table uses the strict `object` policy. Move those parts back to the `default`
volume first; otherwise ClickHouse will refuse to attach the affected tables.

The `/var/lib/clickhouse` volume remains required. Self-hosted ClickHouse keeps
object mappings and table metadata there, while the optional cache uses the same
volume. `ReplicatedMergeTree` replicas also retain separate copies in object
storage; this is not ClickHouse Cloud's SharedMergeTree architecture.
