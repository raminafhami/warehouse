#!/bin/sh
set -eu

for password in "$MONGO_INITDB_ROOT_PASSWORD" "$REVAL_DB_PASSWORD"; do
  case "$password" in
    *[!0-9a-fA-F]*) echo 'MongoDB password must be hexadecimal.' >&2; exit 1 ;;
  esac
  if [ "${#password}" -ne 64 ]; then
    echo 'MongoDB password must be 64 hexadecimal characters.' >&2
    exit 1
  fi
done

if [ "$MONGO_INITDB_ROOT_PASSWORD" = "$REVAL_DB_PASSWORD" ]; then
  echo 'MongoDB administration and application require different passwords.' >&2
  exit 1
fi

key=/data/db/reval-keyfile
if [ ! -s "$key" ]; then
  umask 077
  head -c 756 /dev/urandom | base64 > "$key.tmp"
  mv "$key.tmp" "$key"
fi
chown mongodb:mongodb "$key"
chmod 400 "$key"
exec docker-entrypoint.sh mongod --bind_ip_all --replSet rs0 --keyFile "$key"
