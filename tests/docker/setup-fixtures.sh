#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$SCRIPT_DIR/certs" "$SCRIPT_DIR/keys"

if [ ! -f "$SCRIPT_DIR/certs/server.key" ] || [ ! -f "$SCRIPT_DIR/certs/server.crt" ]; then
  openssl req -new -x509 -days 365 -nodes -text \
    -out "$SCRIPT_DIR/certs/server.crt" \
    -keyout "$SCRIPT_DIR/certs/server.key" \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:postgres,IP:127.0.0.1"
  chmod 600 "$SCRIPT_DIR/certs/server.key"
fi

if [ ! -f "$SCRIPT_DIR/keys/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -f "$SCRIPT_DIR/keys/id_ed25519" -C "netcatty-db-test-bastion"
  chmod 600 "$SCRIPT_DIR/keys/id_ed25519"
fi

echo "Local Docker test TLS certs and SSH bastion keys are ready."
