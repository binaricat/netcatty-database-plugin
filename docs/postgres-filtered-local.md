# Filtered PostgreSQL reads: local protocol harness

Run manually from the repository in the authorized fixture's network namespace:

```sh
node --import tsx scripts/postgres-filtered-local.ts
```

This script reads existing `local-db-host/pg-test/server.crt` and the runtime-only
password file. It makes a standard PostgreSQL SSLRequest, verifies TLS against
that trust anchor and exact `127.0.0.1` identity, then uses the actual plugin SCRAM
and extended-query modules. It never creates a server, changes a seed, or disables
certificate/hostname verification. The existing fixture must expose port 15432
and `postgres.public.netcatty_smoke(id integer, label text, optional_value text)`.

## Assertions

Four consecutive queries on one authenticated connection verify:

- A bound label string selects the existing row.
- A bound NULL uses `IS NOT DISTINCT FROM`, and the NULL result stays NULL.
- SQL-looking text containing quotes, a semicolon and a DROP statement remains a
  Bind parameter and selects no rows.
- A subsequent ID filter still reads the original row.
- Every operation completes its read-only transaction with ROLLBACK and returns
  ReadyForQuery `I`. Integer ID `1` remains exact PostgreSQL text, not a conversion.

The fixture does not contain a large numeric/decimal column. Large-number
precision is covered by injected-protocol unit tests, not claimed as a real-server
assertion here. No arbitrary SQL or read-only constant-expression API was added.

## Evidence boundary and execution location

This is an **independent Node protocol integration lane**, not a native plugin
connection: Node implements SSLRequest-to-TLS upgrade, which current main public
byte-stream APIs cannot supply. It does not bypass the plugin's endpoint policy,
and is not shipped or invoked as a helper by the plugin.

The initial cloud exec run returned `connection-refused` during verified TLS
setup. The coordinator confirmed the existing server runs in the controlled
desktop/SSH network namespace, which differs from exec's loopback namespace.
That failure is not evidence of a broken fixture.

The coordinator subsequently ran this harness through **Netcatty's actual native
SSH terminal** in the fixture environment and reported **PASS**: verified TLS 1.3,
SCRAM authentication, and all four queries. The observed checks cover string Bind,
NULL with `IS NOT DISTINCT FROM`, injection-looking text returning zero rows,
int4 returned as exact text, ReadyForQuery `I` after each operation, and reuse of
the same connection. This is real-server acceptance of this bounded generated
query protocol slice, not production qualification, arbitrary SQL support, or
proof of a native plugin PostgreSQL connection. Large numeric/decimal precision
remains unverified against this real fixture.

Screenshot evidence (outside the repository):
`database-parity-evidence/full-main-round1/netcatty-pg-filtered-read.jpg`.
The evidence and PASS observation were supplied by the coordinating worker;
this worker did not operate the native desktop. Native SSH recordings remain
separate artifacts and should not be assumed to show this later harness run.

Output contains fixed stages/check names and whitelisted TLS failure categories;
it does not print password bytes, server diagnostics, or assertion row contents.
Owned password byte buffers are cleared, but JavaScript strings cannot be securely
erased. The socket closes in `finally`, including failed assertions.
