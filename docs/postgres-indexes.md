# Bounded PostgreSQL index definitions

`readPostgresIndexes(connection,{schema,table,limit?,timeoutMs?,signal?})` uses the
existing filtered extended-query executor against **only** `pg_catalog.pg_indexes`.
Schema and table are Bind values. It returns `name` and original `definition` text,
never parsed UNIQUE/primary-key/constraint flags and never executed DDL.

Default limit is 32, maximum 98. One extra row detects truncation. A truncated
result is an unordered subset, not pagination; no continuation is invented.
Definitions are limited to 2048 characters and 8192 UTF-8 bytes. Existing wire,
row and 96 KiB result budgets remain in force. Unsupported/unknown OIDs fail
closed; no protocol allowlist was expanded. NULLs, duplicate names and malformed
metadata fail rather than being guessed or silently repaired.

Five tests inject actual PostgreSQL protocol bytes through the real filtered
executor (including fragmentation, NULLs, unknown OIDs, limits and Bind safety).
They are not real-server acceptance.

## Explicit real-server harness

In the existing authorized fixture's native SSH network namespace:

```sh
node --import tsx scripts/postgres-indexes-local.ts
```

The script copies the existing verified TLS / SCRAM setup and does three reads:
find the known fixture index and its raw definition, bind an SQL-looking unknown
table name and obtain zero matches, then read the same index again on the same
connection. It does not create indexes, modify a seed, infer constraint authority,
or print credentials. The fixture normally has one index, so positive truncation
is covered in protocol tests, not claimed as a real fixture assertion.

On 2026-11-07 the coordinator ran the harness through actual Netcatty SSH against
PostgreSQL 17.6. All three reads passed over strictly verified TLS 1.3 with SCRAM.
Screenshot: `database-parity-evidence/full-main-round1/postgres-indexes-pass.jpg`.
This establishes independent Node protocol-module integration only: Node supplies
the SSLRequest/TLS upgrade unavailable through current main public plugin byte
streams. It does not establish native plugin PG connectivity, arbitrary DDL,
production qualification, or complete DBX parity.
