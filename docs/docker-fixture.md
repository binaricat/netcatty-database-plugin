# Disposable three-database SSH fixture (configuration only)

`tests/docker/` describes one container with **real Debian-packaged Redis, PostgreSQL 15 and MariaDB**, plus OpenSSH. It is not a fake protocol responder. This change only writes configuration: no Docker daemon was started, image built, service launched, port opened or real database test performed. Passing static checks is not acceptance.

## Security and startup contract

- Base is official `debian:bookworm-slim`, with distribution apt packages. Package services are disabled during build. No third-party install scripts.
- No privileged mode, host network, host Docker socket, host filesystem access or security-setting changes. Only SSH is published, bound to `127.0.0.1` (default port 2222); PostgreSQL, MariaDB and Redis have **no published host ports**.
- SSH accepts one runtime-provided public key for `fixture`. No password/root login, agent forwarding, TCP forwarding, tunnel or X11 forwarding. Private SSH keys stay outside the container. The test host account has no sudo privileges.
- All passwords and TLS inputs come from Compose read-only secret mounts. The entrypoint requires all files, checks certificate trust/name and private-key match **before starting any service**, and fails closed if any prerequisite is absent.
- Redis disables plaintext port and uses TLS port 6380 plus a runtime password. `tls-auth-clients no` means password authentication is used instead of mandatory client certificates; it does not disable server TLS or certificate validation by clients. PostgreSQL accepts network access only through `hostssl` SCRAM. MariaDB requires secure transport and its fixture user requires SSL. TLS private-key copies stay inside the disposable container with service-only permissions.
- Password input is 24–128 base64url characters; no embedded SQL/config injection is allowed. Credentials are not placed in process arguments or printed. Logs/config inside this container can contain sensitive data and must not be uploaded wholesale.
- Container state is disposable, not a backup. It has no data volumes. Initialization is intended for a newly created container, not an existing dirty database; recreate explicitly for a fresh run. The scripts do not destroy/recreate containers automatically.

## Runtime inputs (not committed)

Create an absolute secret directory **outside the repository**, owned by the user with restrictive permissions. Supply:

- `ssh.pub`: one public key whose private key the user generated and holds at runtime.
- `redis.password`, `postgres.password`, `mariadb.password`: separate random 24–128-character base64url passwords.
- `ca.pem`, `server.pem`, `server.key`: CA chain, matching server certificate and private key. Certificate SAN must match the explicitly selected `FIXTURE_TLS_NAME` and its trust chain must be usable by the intended client.

Export `FIXTURE_SECRETS_DIR`, `FIXTURE_TLS_NAME`, optionally `FIXTURE_SSH_PORT`. `.env`, key/certificate/password files and runtime directories are ignored under `tests/docker/`; never paste secrets into committed examples. Do not auto-generate or install a new trusted CA on the host as a workaround. The configuration contains no default password or private key.

## Explicit execution, only after approval

Read-only dependency check: `bash tests/docker/preflight.sh` checks Docker client/server availability, Compose and file presence; it does not start a daemon or a service. Do not run it as a request to install missing packages or change system settings. Static checks can run without Docker:

```
python tests/docker/static_check.py
bash -n tests/docker/entrypoint.sh tests/docker/preflight.sh
```

Once the intended runtime/environment and exact services are authorized, the explicit start command is `docker compose -f tests/docker/compose.yaml up --build`. It is intentionally not wrapped in an auto-start script. Stopping/removing a disposable test container is a separate explicit action; preserve needed evidence first. Host SSH fingerprint must be inspected and verified by the client, not accepted by disabling host-key checks.

## Routing and full Netcatty prerequisites

Container-internal database addresses are not automatically authorized plugin targets. Before any production-plugin connection, inspect the actual endpoint, DNS answers and route using the main production broker rules. Do not use an alias, proxy, port mapping, SSH forwarding or HTTP transport to bypass a rejected loopback/application-control destination. The SSH port is for the requested test host, not proof of database discovery.

The current package does **not** yet have a verified routable fixture endpoint, matching host-trusted certificate/hostname, exact `network.stream` resource declaration and user grant for this fixture. Redis via the production broker requires all of them. `tls://127.0.0.1:6380` is neither published here nor a permitted production shortcut. A Docker-private address may or may not be reachable/allowed from the actual Netcatty environment; check rather than assume. A test harness exception is component evidence only, not full-App acceptance. Do not modify host trust/network/security to force success.

PostgreSQL/MariaDB standard TLS handshakes also need the appropriate driver/host transport support, not merely a running server. Their existence in this container does not prove current plugin protocol support. Container-local native clients can separately qualify the fixture with full verification (PostgreSQL `verify-full`, MariaDB server-certificate verification, Redis CA plus matching name); never `--insecure` or disable certificate checking. Current default key/certificate/endpoint prerequisites are intentionally absent, so starting without them fails.

## Acceptance stages and evidence

1. Static policy/syntax checks (available now; not live tests).
2. Authorized image build and startup; verify actual package/server versions and three running services. PostgreSQL/MariaDB contain two synthetic `sample` rows. Load synthetic Redis data through an authenticated verified-TLS client after endpoint verification.
3. Native client tests inside the permitted environment: authenticated reads, wrong-password rejection, certificate mismatch rejection, SQL constraints, service stop/recovery. No real user data.
4. Separately, installed Netcatty plugin + permitted exact endpoints: discovery/explicit target selection, authentication, schema/read behavior, cancellation and reconnect. Capture screenshots/video and label scope per database. Do not present SSH success, container health or injected transport tests as this stage.
5. Docker multi-database acceptance remains outstanding until actual executions and artifacts exist. Missing Docker access/routable endpoint/trusted certificate is an environment prerequisite, not proof of a plugin-system impossibility.
