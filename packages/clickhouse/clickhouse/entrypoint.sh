#!/bin/sh

set -eu

for v in \
  NAMESPACE \
  CLUSTER_NAME \
  SHARD_ID \
  REPLICA_ID \
  KEEPER_REPLICAS \
  SHARDS \
  REPLICAS_PER_SHARD; do
  eval ": \${$v:?Missing $v}"
done

envsubst < /tmp/conf_templates/config.yaml > /etc/clickhouse-server/config.yaml
envsubst < /tmp/conf_templates/users.yaml > /etc/clickhouse-server/users.yaml

cat >> /etc/clickhouse-server/config.yaml << EOF

zookeeper:
  nodes:
EOF
for i in $(seq 0 $((KEEPER_REPLICAS - 1))); do
  cat >> /etc/clickhouse-server/config.yaml << EOF
    - host: clickhouse-keeper-${CLUSTER_NAME}-$i.clickhouse-keeper-${CLUSTER_NAME}-headless.${NAMESPACE}.svc.cluster.local
      port: 9181
EOF
done

cat >> /etc/clickhouse-server/config.yaml << EOF

remote_servers:
  $CLUSTER_NAME:
    shards:
EOF
for i in $(seq 0 $((SHARDS - 1))); do
  cat >> /etc/clickhouse-server/config.yaml << EOF
      - internal_replication: true
        replicas:
EOF
  for j in $(seq 0 $((REPLICAS_PER_SHARD - 1))); do
    cat >> /etc/clickhouse-server/config.yaml << EOF
          - host: clickhouse-${CLUSTER_NAME}-shard-$i-$j.clickhouse-${CLUSTER_NAME}-headless.${NAMESPACE}.svc.cluster.local
            port: 9000
            user: admin
            password: ${CLICKHOUSE_ADMIN_PASSWORD}
EOF
  done
done

exec "$@"
