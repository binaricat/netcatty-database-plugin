# Real MySQL 8.4.7: independent authentication acceptance

2026-11-07. Executed by the coordinating worker inside the actual Netcatty native
SSH terminal against the owned official MySQL **8.4.7** fixture at
`127.0.0.1:15479`. Account: `netcatty_test@127.0.0.1`, caching_sha2_password with
REQUIRE SSL. Runtime password and private certificate key are not artifacts.

## Actual plugin-module protocol lane

The manual Node harness uses production `mysqlProtocol`,
`planMysqlSslRequest` and `MysqlTlsFastAuth`. Node supplies the network and
SSLRequest-to-TLS upgrade; certificate chain and exact IP identity are verified.

| Observed run | Verified result |
| --- | --- |
| Cold fixture restart, no CLI prewarm; first `--full-auth-required` | PASS, `authFlow:full`, verified TLS 1.3, sequence-4 password sent only within that TLS connection |
| Later default run after CLI verification | PASS, `authFlow:fast` |
| `--bad-password` | PASS, actual ERR 1045 / SQLSTATE 28000 |
| `--reject-cert` | PASS, untrusted certificate rejected |

Only this owned fixture was restarted with `--cold-auth-test`; no global cache
flush or account change was used to force a successful result. `01 04` alone is
not password rejection. Older tests without full-auth support correctly reported
that path UNSUPPORTED. The full-required mode cannot pass on cached fast auth.

## Separate official CLI lane

The official CLI independently passed VERIFY_IDENTITY/TLS 1.3, DDL/UPSERT,
`netcatty_smoke` label `real-tls-mysql`, NULL and prepared-parameter reads.
Non-TLS access was refused. Those operations are **CLI evidence**, not query
support in the plugin's handwritten driver or the authentication harness.

## Evidence and remaining limits

Under `database-parity-evidence/full-main-round1/`:

- `netcatty-mysql-full-auth.jpg`
- `netcatty-mysql-auth-all-lanes.jpg`
- `full-app-mysql-protocol.mp4`: continuous 120-second recording requested;
  recording/validation was still finishing when this record was written. Do not
  describe it as validated or ready to share until the coordinator checks it.

This is a real independent protocol-integration lane, **not installed-plugin
MySQL connectivity**, main broker/permission acceptance or Docker. The Node
harness is not shipped as a helper or imported into the plugin. Main's missing
STARTTLS upgrade remains unresolved. Query/result handling, MariaDB auth,
auth-switch/RSA paths and broader MySQL compatibility remain unqualified or
unimplemented; immediate OK is intentionally not supported. No endpoint/TLS
policy was weakened and no plaintext fallback was introduced.
