#!/bin/sh
set -eu

for v in \
  POD_NAME \
  KEEPER_REPLICAS; do
  eval ": \${$v:?Missing $v}"
done

envsubst </tmp/conf_templates/keeper.yaml >/etc/clickhouse-keeper/keeper.yaml

SERVER_ID=$(( ${POD_NAME##*-} + 1 ))
cat >> /etc/clickhouse-keeper/keeper.yaml <<EOF

  server_id: $SERVER_ID
  raft_configuration:
EOF
for i in $(seq 0 $((KEEPER_REPLICAS - 1))); do
  cat >> /etc/clickhouse-keeper/keeper.yaml <<EOF
    - server:
        id: $((i + 1))
        hostname: clickhouse-keeper-$CLUSTER_NAME-$i.clickhouse-keeper-$CLUSTER_NAME-headless.$NAMESPACE.svc.cluster.local
        port: 9234
EOF
done

exec "$@"
