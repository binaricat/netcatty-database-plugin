#!/bin/sh
set -eu

mkdir -p /tmp/pgcerts
cp /certs/server.crt /tmp/pgcerts/server.crt
cp /certs/server.key /tmp/pgcerts/server.key
chown postgres:postgres /tmp/pgcerts/server.crt /tmp/pgcerts/server.key
chmod 644 /tmp/pgcerts/server.crt
chmod 600 /tmp/pgcerts/server.key

exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/tmp/pgcerts/server.crt \
  -c ssl_key_file=/tmp/pgcerts/server.key \
  -c password_encryption=scram-sha-256
