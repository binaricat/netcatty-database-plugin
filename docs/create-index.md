# Reviewed SQLite CREATE INDEX

In a connected disposable SQLite session, **New index** accepts a name, an existing regular table and 1–32 distinct existing columns with explicit ASC/DESC order. UNIQUE is optional. No expressions, predicates, collations, arbitrary DDL, DROP or ALTER are accepted. SQLite ASCII identifier matching resolves inputs to the schema's actual spelling; unknown index metadata, namespace collisions, views and oversized definitions are rejected.

Preview does not execute. Confirmation consumes the exact issued review once, on the same open handle and schema revision. Table and index previews share a single last-issued DDL slot, preventing an older review from being applied after a different operation was previewed. Schema is inspected again before execution. Creation uses a savepoint and 1 MiB/metadata budgets; UNIQUE violations roll back completely, consume the failed review and restore read protection. There is no background retry.

## Validation

- Six pure-model tests cover identifier quoting, schema matching, unsupported syntax, duplicates, unknown metadata and limits.
- Four actual SQL.js integration tests cover explicit creation, ordered index columns, review tampering and cross-session rejection, rollback on duplicate values, unchanged schema revision on failure, subsequent DDL invalidation and read protection.
- Seven controller/SSR tests use an injected adapter; they are not native UI acceptance.
- The main remote-DOM regression uses the actual UI and actual SQL.js engine, but injected view/storage transports.
- Full unmodified Netcatty main `4a55492`, alpha.14: selected notes/title/DESC, reviewed and created `idx_notes`, then inspected the real index metadata and matching CREATE INDEX definition. Separate native screenshots/recording are maintained outside source.

This is not Docker or remote-database qualification. Production drivers, persistent databases, index deletion/alteration, expression/partial indexes and vendor-specific options remain unfinished.
