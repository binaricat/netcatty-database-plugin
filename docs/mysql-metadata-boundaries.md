# MySQL bounded metadata reads

`mysqlMetadata.ts` exposes `createMysqlMetadataClient(connection)` with
`tables({schema})`, `columns({schema,table})` and `indexes({schema,table})`.
Each accepts optional limit (1–100), timeout and abort signal. The connection must
already be authenticated, strictly verified TLS, idle and exclusively owned.
The default executor is the fixed-view `executeMysqlMetadataPreparedRead`; an injected
executor exists solely for offline contract tests.

Queries target only fixed `information_schema.TABLES`, `COLUMNS` and `STATISTICS`
projections, with TABLE_SCHEMA/TABLE_NAME passed as prepared text parameters.
No identifier interpolation of caller schema/table values into those predicates,
SHOW fallback, DDL, arbitrary SQL, hidden query retries or network connection is
provided. The existing prepared protocol's read-only transaction and all budgets
remain in force, including strict response metadata/origin/type verification.

Results include:
- Table name, table/view kind, engine.
- Column name, ordinal position, data type/type declaration, nullable, default
  and extra attributes. Defaults/expressions are displayed data, never executed.
- Flat index parts: index name, uniqueness, sequence, column or expression,
  direction and index type. No invented grouping or full definition is returned.

At the row limit, `possiblyTruncated:true` means completeness is **unknown**.
Even a composite index can be cut mid-definition. Returned columns/index parts
are sorted locally; there is no server ORDER BY or pagination in this slice.
Empty metadata may reflect permissions or absence; it does not prove an object
never exists. Duplicate/malformed metadata and unexpected types fail closed.
This first route requires MySQL's STATISTICS.EXPRESSION column; compatibility
fallbacks for older vendors are not implemented.

DBX references: `dbx-driver-mysql/src/mysql.rs:3767` tables, `5264–5282` columns
(and separate generated expressions), `7897` index SQL. DBX additionally provides
comments, precision/scale, character sets, generated expressions, vendor
fallbacks and broader schema navigation; these are not all reproduced here.

## Qualification and next real-service check

Five injected-executor tests validate exact bound plans and metadata conversion,
limits, uncertainty markers and error redaction. These tests do not qualify real
information_schema wire metadata. Existing plain/prepared data-read acceptance
is not sufficient evidence for this new module.

Proposed independent manual harness mode, without changing default modes:
`--metadata` on the already authenticated same-TLS socket. Call tables for
`netcatty_test`, find `netcatty_smoke`, then columns and indexes for that table.
Require the fixture's id/label/optional_value types and nullability plus PRIMARY
index part on id, and repeat a normal prepared read on the same connection to
prove cleanup/rollback reuse. Only after actual execution report metadata
qualification. Do not relax origin/type validation in advance to make views pass;
if MySQL information_schema uses differing origin metadata, diagnose safe fields
and review a narrow fixed-view profile before changing protocol acceptance.

No real MySQL metadata query, native plugin connectivity or Docker qualification
is claimed by this commit. No main permission or endpoint boundary was changed.

## MySQL 8.4.7 view metadata qualification

First actual SSH-launched module test failed in the TABLES PREPARE phase. This
is retained as a failure, not counted as metadata acceptance. The server sent
UTF-8 charset 45 with flags 20609 for TABLE_NAME and 20873 for TABLE_TYPE;
ENGINE's schema origin did not match information_schema. Official tagged source
[`sql/dd/impl/system_views/tables.cc`, lines 37–41](https://github.com/mysql/mysql-server/blob/mysql-8.4.7/sql/dd/impl/system_views/tables.cc)
shows TABLE_TYPE derives from the dictionary enum while ENGINE is an IF
expression, not a simple base-column projection.

A separate `executeMysqlMetadataPreparedRead` authority lane now requires the
complete fixed projection and correctly ordered text-bound schema/table filters.
Ordinary `executeMysqlPreparedRead` retains its original strict origin/type
checks. Only the observed TABLES name/enum type+charset+flag tuples receive
text-decoding normalization; only ENGINE's matching type/charset/flags may have
an empty schema origin. Table/original-table/column names remain exact. The
unmodified raw PREPARE and EXECUTE metadata must still match. An origin of mysql
or any other schema is not accepted as an alternative. COLUMNS/STATISTICS
exceptions are not guessed in advance. Diagnostic schema categories are limited
to information_schema, mysql, empty and other, never arbitrary server strings.

The narrow correction has offline protocol tests, including unchanged ordinary
reads, wrong authority/projection, unknown flags/charsets/origins and changed
PREPARE/EXECUTE metadata. Real rerun remains required; this is not native plugin
or full metadata acceptance.


## Actual qualification (2026-11-07)

The independent `scripts/mysql-metadata-local.ts` harness passed against official
MySQL 8.4.7 over strictly verified TLS 1.3, after three safely rejected origin/type
differences were captured and reviewed. Fixed TABLES, COLUMNS, and STATISTICS
profiles now match only each explicitly observed field tuple; ordinary prepared
reads remain unchanged. Raw PREPARE/EXECUTE metadata equality remains mandatory.
The test verified fixture table, column metadata, PRIMARY index, zero rows for a
bound SQL-looking name, and normal prepared reading on the same socket afterward.

Evidence: `full-main-round1/mysql-metadata-fourth.json` and actual Netcatty SSH
screenshot `mysql-metadata-fourth.jpg`; prior failures are retained as first,
second and third evidence. It is an independent Node protocol harness launched
from real SSH, **not** native plugin transport (`nativePluginConnected:false`).
No full-vendor, pagination, generated-column or expression-index qualification is
claimed from this simple fixture. The earlier pending notes describe development
history, not the final result for this fixture.
