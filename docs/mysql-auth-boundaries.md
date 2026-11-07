# MySQL TLS fast-auth protocol slice

`mysqlAuth.ts` implements a **pure, offline-qualified** `caching_sha2_password`
fast-auth state machine. It does not establish a connection or qualify MySQL or
MariaDB as usable plugin drivers.

## Contract and supported exchange

The caller must first receive HandshakeV10 at sequence 0, send SSLRequest at
sequence 1, and complete certificate-chain and exact-hostname-verified TLS.
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

Only sequence-3 AuthMoreData `01 03` followed by sequence-4 idle OK is accepted.
The bounded packet decoder handles fragmentation/coalescing; malformed sequence,
extra data, server errors and budgets fail closed. OK is deliberately restricted
to zero affected rows/insert ID, AUTOCOMMIT-only status and no warnings or trailing
information. Broader valid variants are not silently accepted.

## Explicitly missing

- FullAuthenticationRequired (`01 04`) is rejected. A server with an uncached
  authentication entry may therefore reject this flow. No NUL-terminated password
  is transmitted even inside TLS, and no RSA key retrieval/trust occurs.
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

Five offline tests compare challenge bytes against independent Node SHA256,
exercise fragmented/coalesced success, reject missing TLS assertion/full-auth/
auth-switch/sequence errors, redact server text, and test cancellation/concurrent
starts. No real MySQL or MariaDB server acceptance has been run for this module.

DBX uses `mysql_async` rather than this handwritten protocol slice; see
`dbx-driver-mysql/src/mysql.rs` around connection/TLS setup at lines 2342–2480.
Protocol reference: MySQL server developer documentation, **Caching SHA-2
Pluggable Authentication** and **Protocol::HandshakeResponse41**. Implementing
these structures does not establish complete compatibility with their full flows.
