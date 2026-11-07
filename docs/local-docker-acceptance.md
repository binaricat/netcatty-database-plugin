# Local Docker + SSH + database acceptance: audited prerequisites

Audit date: 2026-11-07 UTC. Host source inspected: `database-host-main`, Netcatty main commit `4a55492`. This is an environment/API audit, **not a completed Docker or full-application smoke test**.

## Current cloud execution environment

Read-only observations:

- User is `agent`, uid/gid 1000. No Docker executable in the default PATH.
- Official Docker 28.5.2 static client/server and rootless extras are present at `../database-parity-evidence/docker-tools/`.
- `docker --version`: `Docker version 28.5.2, build ecc6942`.
- `docker context ls`: only the default context, `unix:///var/run/docker.sock`.
- `docker info` did **not** reach a daemon. It reported `dial unix /var/run/docker.sock: socket: operation not permitted`. No socket was visible at the standard system/user paths. This is not evidence that a daemon exists or merely needs to be started; socket access is also restricted.
- `newuidmap`, `newgidmap`, and `iptables` were not found in PATH or checked standard locations.
- Existing official rootless prerequisite report, `../database-parity-evidence/docker-rootless-check.log`, asks for `uidmap`, `iptables`, and loading `nf_tables`.
- `/etc/subuid` and `/etc/subgid` each contain `agent:100000:65536`. `/proc/sys/user/max_user_namespaces` is nonzero. These do not supply the missing privileged mapping helpers.
- `/sys` and a cgroup hierarchy are not visible in this execution environment. Cgroup absence alone is not proof that every rootless Docker configuration is impossible, but resource-control support has not been established.

No daemon was started in this audit. No packages, system security settings, kernel modules, privileged/setuid helpers, network listeners, or cgroup mounts were changed. No `--skip-iptables`, local-address exemption, socket-policy bypass, or unauthenticated service exposure was attempted.

**Conclusion:** there is currently no verified usable local Docker service, and the ordinary supported rootless prerequisite path is incomplete. Supplying supported Docker execution with permitted daemon access and required networking/user-namespace prerequisites is an environment provision, not a plugin implementation fix. Downloaded binaries alone do not satisfy it.

## Local container address versus plugin policy

The relevant production checks are:

- `electron/plugins/byteStreamEndpoint.cjs`: `isLocalControlAddress` rejects IPv4 loopback/link-local, unspecified/multicast and corresponding IPv6 control/tunnel ranges.
- `electron/plugins/byteStreamService.cjs:31`: `isControlEndpoint` rejects addresses equal to **any network interface of the application host**, not only 127.0.0.1.
- `electron/plugins/byteStreamBroker.cjs:139`: validates every DNS answer before connecting. Test-only local endpoint overrides are not forwarded by the production host service.
- `electron/plugins/permissionResources.cjs`: `network.stream` requires exact declared endpoints, including optional declarations; no wildcard.

Consequences:

1. A Docker DB published to `127.0.0.1:5432` is rejected by the plugin byte-stream broker. Publishing it on the host's own LAN IP does not fix that: the own-interface check still applies.
2. A distinct container bridge IP is **not categorically blocked just because it is RFC1918/private**. It must actually be routable from the full application, not equal to a host interface, and explicitly allowed by the manifest/permission policy. Rootless container-private addresses are not automatically reachable from the host. This audit does not establish a usable container route.
3. Do not rename localhost through DNS, use a proxy, add a broker test override, or patch out the checks to manufacture acceptance.
4. Normal Netcatty SSH connection uses the application's SSH path, not the plugin byte-stream broker. A saved SSH host may connect to a local published SSH endpoint if the actual environment permits it. That still does **not** grant the plugin an SSH execution stream, SSH tunnel, or successful database authentication.

## Required real acceptance sequence

Once a supported local Docker environment is supplied:

1. Start actual database services in Docker and a test SSH host. Use official images or reviewed test configurations; do not lower database/TLS authentication to fit a missing driver. Keep test credentials out of screenshots/logs and do not reuse personal credentials.
2. Establish whether a production-permitted direct DB endpoint exists. If only local published ports are available, record the production broker denial and stop the DB path there; do not substitute a harness success.
3. Launch the **complete, unmodified latest Netcatty main application** on the existing controlled desktop. Configure the real test SSH host through the actual host editor and retain normal host-key/authentication checks.
4. Install the actual plugin package through Settings. Confirm required/optional permissions through the app. Show the host entry in the full application's Vault.
5. Click the plugin's host picker. `context.vault.selectHosts({title})` must display the real host-owned selection UI and return actual saved-host metadata. Do not inject metadata or replace the service with a fixture.
6. If testing SSH connection requests, click the separately labelled SSH button. `vault.requestConnect` returns only `requested`; record the resulting actual SSH authentication/terminal outcome in Netcatty separately.
7. On the selected host, probe only explicitly authorized database endpoints using production `network.connect` and the real plugin driver. Identify the engine through an actual protocol response, not an open TCP port alone.
8. Authenticate to the real database and run read-only schema/query checks; capture engine/version, a known seeded row, bound parameters, NULL/empty values, schema/index/FK information, and refusal/error recovery. Do not label a TCP handshake or SSH shell as a DB connection.
9. Repeat on PostgreSQL, MySQL/MariaDB, Redis and other implemented engines. Include Docker container identities/health as corroborating evidence, not as a substitute for the plugin UI path.
10. Record the continuous full-app sequence (Vault host → plugin host picker → probe → database connection → actual query) and attach distinct screenshots for milestones. Clearly label any unavailable stage and retain honest remaining-functionality status. Do not merge or publish.

Current plugin work implements the real Vault selection/SSH-request portion. Database probe/driver integration and this full-application Docker acceptance are **not complete**. Existing component-harness recordings and in-memory SQLite fixtures cannot satisfy this acceptance condition.
