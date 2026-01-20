#!/bin/sh

set -eu

for v in \
  CLUSTER_NAME \
  NAMESPACE \
  POD_NAME \
  KEEPER_REPLICAS; do
  eval ": \${$v:?Missing $v}"
done

envsubst < /tmp/conf_templates/keeper.yaml > /etc/clickhouse-keeper/keeper.yaml

server_id=$((${POD_NAME##*-} + 1))
cat >> /etc/clickhouse-keeper/keeper.yaml << EOF

  server_id: $server_id
  raft_configuration:
    servers:
EOF
for i in $(seq 0 $((KEEPER_REPLICAS - 1))); do
  cat >> /etc/clickhouse-keeper/keeper.yaml << EOF
      - id: $((i + 1))
        hostname: clickhouse-keeper-${CLUSTER_NAME}-$i.clickhouse-keeper-${CLUSTER_NAME}-headless.${NAMESPACE}.svc.cluster.local
        port: 9234
EOF
done

exec "$@"
