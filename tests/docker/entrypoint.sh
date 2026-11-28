#!/bin/bash
set -euo pipefail
# All credentials/certificates are supplied at runtime. Never print them.
fail() { printf 'Fixture startup refused: %s\n' "$1" >&2; exit 1; }
for name in ssh_public_key redis_password postgres_password mariadb_password tls_ca tls_certificate tls_private_key; do
  test -s "/run/secrets/$name" || fail "missing runtime secret $name"
done
: "${FIXTURE_TLS_NAME:?Missing expected TLS hostname}"
[[ "$FIXTURE_TLS_NAME" =~ ^[a-zA-Z0-9.-]+$ ]] || fail 'invalid TLS hostname'
# Private key match, certificate trust and DNS name must all validate before any service starts.
openssl verify -CAfile /run/secrets/tls_ca -verify_hostname "$FIXTURE_TLS_NAME" /run/secrets/tls_certificate >/dev/null 2>&1 || fail 'TLS trust/name validation failed'
cert_pub=$(openssl x509 -in /run/secrets/tls_certificate -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
key_pub=$(openssl pkey -in /run/secrets/tls_private_key -pubout -outform DER | sha256sum)
[[ "$cert_pub" == "$key_pub" ]] || fail 'TLS key does not match certificate'
ssh-keygen -l -f /run/secrets/ssh_public_key >/dev/null 2>&1 || fail 'invalid SSH public key'
[[ $(grep -c . /run/secrets/ssh_public_key) == 1 ]] || fail 'supply exactly one SSH public key'
# Strict password character/size policy avoids injection in generated config/SQL.
for name in redis postgres mariadb; do
  value=$(cat "/run/secrets/${name}_password")
  [[ "$value" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || fail 'password must be 24–128 base64url characters'
done
install -m 600 -o fixture -g fixture /run/secrets/ssh_public_key /home/fixture/.ssh/authorized_keys
# Unlock account without assigning a usable password; sshd forbids password authentication.
usermod -p '*' fixture
ssh-keygen -A >/dev/null 2>&1
cat >/run/fixture/sshd.conf <<'CONF'
Port 22
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ed25519_key
PermitRootLogin no
PasswordAuthentication no
PermitEmptyPasswords no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
UsePAM no
AllowUsers fixture
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp internal-sftp
CONF
# Certificates copied inside this disposable container to service-owned files;
# the mounted source remains read-only. No host trust store changes.
for user in redis postgres mysql; do
  install -d -m 700 -o "$user" -g "$user" "/run/fixture/$user"
  for pair in 'tls_ca ca.pem' 'tls_certificate server.pem' 'tls_private_key server.key'; do
    read -r source target <<<"$pair"
    install -m 600 -o "$user" -g "$user" "/run/secrets/$source" "/run/fixture/$user/$target"
  done
done
redis_password=$(cat /run/secrets/redis_password)
cat >/run/fixture/redis.conf <<CONF
bind 0.0.0.0
port 0
tls-port 6380
tls-cert-file /run/fixture/redis/server.pem
tls-key-file /run/fixture/redis/server.key
tls-ca-cert-file /run/fixture/redis/ca.pem
tls-auth-clients no
protected-mode yes
requirepass $redis_password
save ""
appendonly no
dir /run/fixture/redis
CONF
chmod 600 /run/fixture/redis.conf; chown redis:redis /run/fixture/redis.conf
pg_createcluster 15 main --start-conf=manual >/dev/null
cat >>/etc/postgresql/15/main/postgresql.conf <<'CONF'
listen_addresses = '*'
ssl = on
ssl_cert_file = '/run/fixture/postgres/server.pem'
ssl_key_file = '/run/fixture/postgres/server.key'
ssl_ca_file = '/run/fixture/postgres/ca.pem'
password_encryption = 'scram-sha-256'
CONF
cat >/etc/postgresql/15/main/pg_hba.conf <<'CONF'
local all postgres peer
hostssl fixture fixture 0.0.0.0/0 scram-sha-256
hostssl fixture fixture ::/0 scram-sha-256
CONF
install -d -o mysql -g mysql /run/mysqld
cat >/run/fixture/mariadb.cnf <<'CONF'
[mariadbd]
user=mysql
bind-address=0.0.0.0
socket=/run/mysqld/mysqld.sock
pid-file=/run/mysqld/mysqld.pid
ssl-ca=/run/fixture/mysql/ca.pem
ssl-cert=/run/fixture/mysql/server.pem
ssl-key=/run/fixture/mysql/server.key
require-secure-transport=ON
CONF
children=()
cleanup() { trap - EXIT TERM INT; for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done; pg_ctlcluster 15 main stop --mode fast >/dev/null 2>&1 || true; wait || true; }
trap cleanup EXIT TERM INT
pg_ctlcluster 15 main start
runuser -u redis -- redis-server /run/fixture/redis.conf >/run/fixture/redis.log 2>&1 & children+=("$!")
mariadbd --defaults-file=/run/fixture/mariadb.cnf >/run/fixture/mariadb.log 2>&1 & children+=("$!")
for i in {1..60}; do mariadb-admin --socket=/run/mysqld/mysqld.sock ping --silent >/dev/null 2>&1 && break; sleep 1; done
mariadb-admin --socket=/run/mysqld/mysqld.sock ping --silent >/dev/null 2>&1 || fail 'MariaDB did not become ready'
postgres_password=$(cat /run/secrets/postgres_password)
# SQL goes over stdin, never command arguments; values passed only after strict validation.
printf "CREATE USER fixture WITH PASSWORD '%s';\nCREATE DATABASE fixture OWNER fixture;\n" "$postgres_password" | runuser -u postgres -- psql -v ON_ERROR_STOP=1 >/dev/null
mariadb_password=$(cat /run/secrets/mariadb_password)
printf "CREATE DATABASE fixture; CREATE USER 'fixture'@'%%' IDENTIFIED BY '%s' REQUIRE SSL; GRANT ALL ON fixture.* TO 'fixture'@'%%';\n" "$mariadb_password" | mariadb --socket=/run/mysqld/mysqld.sock >/dev/null
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d fixture <<'SQL' >/dev/null
CREATE TABLE sample (id integer PRIMARY KEY, label text NOT NULL);
INSERT INTO sample VALUES (1, 'fixture one'), (2, 'fixture two');
GRANT SELECT ON sample TO fixture;
SQL
mariadb --socket=/run/mysqld/mysqld.sock fixture <<'SQL' >/dev/null
CREATE TABLE sample (id INT PRIMARY KEY, label VARCHAR(80) NOT NULL);
INSERT INTO sample VALUES (1, 'fixture one'), (2, 'fixture two');
SQL
unset redis_password postgres_password mariadb_password value
(while runuser -u postgres -- pg_isready -q; do sleep 2; done; exit 1) & children+=("$!")
/usr/sbin/sshd -t -f /run/fixture/sshd.conf
/usr/sbin/sshd -D -e -f /run/fixture/sshd.conf & children+=("$!")
# Fail the container if an observed foreground service exits; no restart/retry loop.
wait -n "${children[@]}"
