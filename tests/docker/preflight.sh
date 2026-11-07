#!/bin/bash
set -euo pipefail
# Read-only dependency/connection checks. Never starts a daemon or builds/runs services.
command -v docker >/dev/null || { echo 'Docker CLI missing'; exit 1; }
docker version --format '{{.Client.Version}} / {{.Server.Version}}'
docker compose version
: "${FIXTURE_SECRETS_DIR:?Supply absolute runtime secrets directory}"
[[ "$FIXTURE_SECRETS_DIR" = /* ]] || { echo 'Secrets path must be absolute'; exit 1; }
: "${FIXTURE_TLS_NAME:?Supply expected certificate hostname}"
for name in ssh.pub redis.password postgres.password mariadb.password ca.pem server.pem server.key; do
  test -s "$FIXTURE_SECRETS_DIR/$name" || { echo "Missing runtime file: $name"; exit 1; }
done
echo 'Dependencies/secrets present; no service was started and no acceptance test was performed.'
