# PostgreSQL information-schema protocol harness

Manual command in the authorized existing fixture's SSH/desktop network namespace:

```sh
node --import tsx scripts/postgres-metadata-local.ts
```

The harness uses verified TLS (exact IP identity and fixture CA), SCRAM, and the
production `createPostgresMetadataReader` entry point. It does not use the internal
injected-reader test seam. It performs five bounded read-only queries without
seeding or changing the service:

1. Find `public.netcatty_smoke` as a visible base table.
2. Verify its three columns in ordinal order: non-nullable integer `id`, nullable
   text `label`, and nullable text `optional_value`, including exact UDT names.
3. Request one column and assert an explicit truncated unordered subset, with no
   invented pagination cursor.
4. Bind a SQL-looking schema name and assert an empty result.
5. Re-read columns on the same connection and verify unchanged metadata.

The model requests one extra row as a truncation sentinel. Complete column sets
are sorted by ordinal; truncated sets are not ordered pages. Results describe
objects visible to this database account, not every object in the database.
Different calls use different read-only transactions, not one consistent catalog
snapshot. No primary-key, index, default, or constraint semantics are inferred.

Unknown RowDescription OIDs are rejected by the underlying protocol. These tests
must not be made to pass by silently adding unknown domain OIDs to an allowlist.
An actual server run is required to qualify information-schema type compatibility.

The coordinating worker subsequently ran this harness through **Netcatty's real
native SSH terminal** and reported **PASS**, with verified TLS 1.3, SCRAM, and all
five queries. The observed checks cover visible fixture table discovery, exact
column names/ordinals/types/nullability, the complete visible column set, explicit
truncation without pagination claims, a SQL-looking schema name returning zero
results, and same-connection reuse with unchanged readable metadata. This verifies
information-schema type compatibility for this actual fixture and query subset,
not arbitrary PostgreSQL domain types.

Screenshot evidence (outside the repository):
`database-parity-evidence/full-main-round1/netcatty-pg-metadata.jpg`.
The run and screenshot were supplied by the coordinating worker; this worker did
not operate the desktop or make exec network attempts. Module tests (53 PG tests)
and project plus standalone-script strict TypeScript checks also passed.

Even a PASS is independent Node protocol-module integration evidence, not proof
of native plugin PostgreSQL connectivity. Node supplies PostgreSQL SSLRequest / TLS
upgrade, which current main public byte-stream APIs do not supply. No production,
arbitrary SQL, Docker, PK/default editing, or complete DBX parity claim follows.
The script reports fixed stages and checks, never passwords or server diagnostics.
