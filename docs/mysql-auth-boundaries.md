# MySQL verified-TLS authentication protocol slice

`mysqlAuth.ts` implements a **pure, offline-qualified** `caching_sha2_password`
authentication state machine. It does not establish a connection or qualify MySQL or
MariaDB as usable plugin drivers.

## Contract and supported exchange

The caller must first receive HandshakeV10 at sequence 0, send SSLRequest at
sequence 1, and complete certificate-chain and exact-hostname-verified TLS.
Use `planMysqlSslRequest(greeting)` to obtain the sequence-1 packet and immutable
parameter descriptor. Pass the same descriptor as `sslRequest` when constructing
`MysqlTlsFastAuth`. Both packets use identical 32-byte fixed headers: capabilities
`0x88a00`, maximum packet size 96 KiB, and collation ID **45**
(`utf8mb4_general_ci`). The server's default charset byte is not blindly echoed.
Only this descriptor configuration is supported; changed/missing/extra fields
are rejected. The external transport must send the generated SSLRequest unchanged;
a pure protocol module cannot attest what a caller actually transmitted.

`verifiedTls: true` is only the caller's assertion of that prerequisite, not a
certificate check performed by this module. Current main plugin transport cannot
perform the MySQL greeting → SSLRequest → TLS upgrade; this work does not change
that restriction or implement a proxy/helper.

`start()` produces a sequence-2 HandshakeResponse41 with a bounded username,
32-byte challenge response and `caching_sha2_password` plugin name. Capabilities
are limited to Protocol41, SSL, SecureConnection and PluginAuth. No LOCAL FILE,
compression, database selection, multiple statements or session tracking is
requested. The challenge response is:

`SHA256(password) XOR SHA256(SHA256(SHA256(password)) || server_challenge)`.

The cached path accepts sequence-3 AuthMoreData `01 03` followed by sequence-4 idle OK. With explicit `allowFullAuth:true`, sequence-3 `01 04` instead requests full authentication: `fullAuthResponse()` returns a sequence-4 NUL-terminated password packet **only for transmission inside the same verified TLS connection**, then sequence-5 idle OK is required. Auth switches and repeated full-auth requests remain rejected.
The bounded packet decoder handles fragmentation/coalescing; malformed sequence,
extra data, server errors and budgets fail closed. OK is deliberately restricted
to zero affected rows/insert ID, AUTOCOMMIT-only status and no warnings or trailing
information. Broader valid variants are not silently accepted.

## Boundaries and explicitly missing

- Full authentication is opt-in and remains forbidden on unverified/plaintext
  transports. The password is plaintext **inside TLS application data**, not a
  challenge response; it must never be sent on raw TCP or a replacement socket.
  No RSA key retrieval, automatic trust or insecure fallback is implemented.
  Without opt-in, `01 04` is still unsupported, not proof of password rejection.
- Auth switches, `mysql_native_password`, clear-password plugins and downgrade
  paths are rejected. This is not MariaDB authentication support.
- No socket, SQL execution, timeout scheduling, TLS verification implementation,
  credential storage or connection UI is provided. Future transport must enforce
  time/read limits and close on failure; callers can cancel this state machine.
- Credentials are ASCII-only in this slice; Unicode policy requires further work.
  TLS authenticates the server: fast auth has no SCRAM-style server signature.

Owned password/challenge/hash/intermediate buffers are cleared best effort;
returned wire buffers belong to the caller and must be cleared after use. JS
strings, browser crypto internals and transport copies cannot be guaranteed
zeroized. Errors never include server error text or credentials.

## Evidence and references

Eleven offline authentication tests compare challenge bytes against independent Node SHA256,
exercise fragmented/coalesced success, reject missing TLS assertion/unrequested full-auth/
auth-switch/sequence errors, redact server text, and test cancellation/concurrent
starts, stable closed state and SSLRequest/response header equality, opt-in full-auth sequencing, secret wiping and denial. Real MySQL 8.4.7 authentication acceptance is now recorded below; MariaDB authentication remains unqualified.

DBX uses `mysql_async` rather than this handwritten protocol slice; see
`dbx-driver-mysql/src/mysql.rs` around connection/TLS setup at lines 2342–2480.
Protocol reference: MySQL server developer documentation, **Caching SHA-2
Pluggable Authentication** and **Protocol::HandshakeResponse41**. Implementing
these structures does not establish complete compatibility with their full flows.

## Intentional DBX compatibility gap

DBX `crates/dbx-driver-mysql/src/mysql.rs:10864–10877` includes
`mysql_caching_sha2_immediate_ok_returns_a_working_pool`: a Router may send OK
immediately after HandshakeResponse. This slice still rejects immediate OK and
requires AuthMoreData fast-auth-success or the explicitly enabled full-auth request first. That is a conservative documented
compatibility limit, not proof that all caching_sha2 servers follow this path.
The referenced DBX test also uses plaintext mode; this implementation does **not**
adopt that policy or relax its verified-TLS prerequisite.

`close()` is stable: later `start()`/`receive()` calls reject without changing the
closed state. Repeated starts during asynchronous hashing still fail closed; no
late wire result may be returned after cancellation.

## Real MySQL 8.4.7 authentication acceptance

On 2026-11-07 the coordinating worker verified both branches in the actual
Netcatty native SSH terminal against official MySQL **8.4.7**:

1. Only the owned fixture was restarted with `--cold-auth-test`, without CLI
   prewarming. The first `--full-auth-required` invocation passed with
   `verified-tls-full-auth`, `authFlow:full`, TLS **1.3**.
2. A subsequent default invocation passed with `authFlow:fast` after the fixture
   CLI verification. Fast and full evidence are separate observed paths.
3. `--bad-password` received actual ERR **1045 / SQLSTATE 28000** and passed the
   explicit-denial check. Earlier pre-full-auth tests that stopped at `01 04`
   remain unsupported-flow evidence, not password rejection.
4. `--reject-cert` passed actual untrusted-certificate rejection.

`scripts/mysql-local-protocol.ts` checks CA and exact IP identity before enabling
full auth, rechecks the same TLS socket before its password packet, and wipes
owned in-flight buffers on completion/failure/timeout. The full-auth password is
inside verified TLS; no plaintext network, RSA trust or auth downgrade is used.
The harness itself does not flush global caches or change users. Only the
separately authorized fixture lifecycle prepared the cold-cache test.

`--fast-only` preserves explicit refusal of `01 04`. `--full-auth-required`
reports NOT_COVERED/exit 2 if it sees only cached fast success, never falsely
qualifying full authentication.

**No plugin query module or production connection has been qualified.** Real
DDL/UPSERT/NULL/prepared reads were performed by the separate official CLI, not
this authentication harness. Node provides the SSLRequest-to-TLS upgrade missing
from main's public plugin API. See [the acceptance record](mysql-live-protocol-acceptance.md)
for the exact lanes and evidence artifacts.
