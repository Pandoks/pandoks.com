#!/bin/sh
set -eu

for v in \
  POD_NAME \
  NAMESPACE \
  HEADLESS_SERVICE \
  ANNOUNCE_PORT \
  ANNOUNCE_BUS_PORT; do
  eval ": \${$v:?Missing $v}"
done

envsubst </tmp/conf_templates/valkey.conf >/etc/valkey.conf

if [ -n $PERSISTENCE ]; then
  echo "dir /data" >> /etc/valkey.conf

  IFS=','
  for mode in $PERSISTENCE; do
    case $mode in
      aof)
        cat >> /etc/valkey.conf <<EOF
        appendonly yes
        appendfilename "appendonly.aof"
        appendfsync everysec
        EOF
        ;;
      rdb)
        cat >> /etc/valkey.conf <<EOF
        dbfilename "dump.rdb"
        save 900 1
        save 300 10
        save 60 10000
        EOF
        ;;
    esac
  done
  unset IFS
else
  echo 'save "" # disabled default rdb settings' >> /etc/valkey.conf
fi

exec $
