# Real Netcatty SSH and Redis acceptance

2026-11-07. Host: unmodified Netcatty main `4a55492c17c3c792fbda4afc08d993f4165ca930`; plugin alpha.20. Official tracked `ssh2+1.17.0.patch` applied to installed dependency using patch-package, as required by the host's existing algorithm configuration. No tracked host changes or algorithm downgrade.

## Verified in the real application

1. Database plugin opened Netcatty's native saved-host selector.
2. Selected `Local SSH Redis fixture` (`agent@127.0.0.1:22222`), sharing only selected host metadata.
3. Plugin's **Open host SSH connection** called the public host connection API and opened a real native terminal.
4. Independently matched the server's Ed25519 fingerprint, then used one-time Continue, not blanket host verification bypass.
5. The actual SSH terminal returned `agent`, a real `/dev/pts/*`, and Redis `PING`, `SET`, `GET`, and `INFO server`: `PONG`, `OK`, `real-ssh-real-redis`, version `7.4.2`.

The local host runs official unmodified Dropbear 2025.88 and Redis 7.4.2, loopback-only, non-root, key-only SSH with root/password login and forwarding disabled. Credentials never appear in screenshots or video. This is not Docker and is not a component fixture.

## Resolved setup problems

- The host's local key path field requires Enter to commit a file reference before Save. A typed but uncommitted path leaves password authentication selected.
- Missing official ssh2 dependency patch caused `Unsupported algorithm: chacha20-poly1305@openssh.com`; applying the repository's own patch fixed initialization.
- Rootless OpenSSH authenticated but aborted allocating PTY/login records. The official Dropbear server supports the same restricted non-root test setup and worked without privilege escalation, source patching, or disabling verification.

## Important remaining boundary

This verifies the **real native SSH terminal** and a **real database accessed from that terminal**. It does not establish plugin-owned direct Redis/PostgreSQL connectivity, automatic database detection, or a working database tunnel. The plugin UI explicitly states no database probing/connection has occurred. The main host's plugin byte-stream policy and lack of supported SSH exec/tunnel APIs remain separate issues. Do not describe this acceptance as full DBX parity or multi-database completion.

Evidence outside the repository: `database-parity-evidence/full-main-round1/native-host-picker-real-host.jpg`, `plugin-real-host-selected.jpg`, `netcatty-real-ssh-redis-success.jpg`, and `full-app-real-ssh-redis.mp4` (verify recording completion before sharing).
