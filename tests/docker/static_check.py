"""Static assertions only. Does not execute Docker, shell scripts or network calls."""
from pathlib import Path
root = Path(__file__).parent
compose = (root / 'compose.yaml').read_text()
dockerfile = (root / 'Dockerfile').read_text()
entry = (root / 'entrypoint.sh').read_text()
assert 'FROM debian:bookworm-slim' in dockerfile
assert all(name in dockerfile for name in ['openssh-server', 'redis-server', 'postgresql', 'mariadb-server'])
assert '127.0.0.1:${FIXTURE_SSH_PORT:-2222}:22' in compose
assert sum(line.strip().startswith('- "127.') for line in compose.splitlines()) == 1
assert all(x not in compose for x in ['privileged:', 'network_mode:', '/var/run/docker.sock', ':5432', ':3306', ':6380'])
assert 'PasswordAuthentication no' in entry and 'PermitRootLogin no' in entry
assert 'AllowTcpForwarding no' in entry and 'tls-auth-clients no' in entry
assert 'openssl verify -CAfile' in entry and '-verify_hostname' in entry
assert 'port 0' in entry and 'tls-port 6380' in entry
assert all(x not in entry for x in ['--insecure', 'rejectUnauthorized', 'FLUSHALL'])
assert all(name in compose for name in ['ssh_public_key','redis_password','postgres_password','mariadb_password','tls_ca','tls_certificate','tls_private_key'])
print('Static fixture policy checks passed. No image built; no service or acceptance test executed.')
