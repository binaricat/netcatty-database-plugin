# Structured SQLite estimated plans

`src/sqliteExplainPlan.ts` is an independent SQL.js module, not yet a facade,
editor command, native UI or arbitrary-SQL explain implementation.

## Contract

- `buildSqliteExplainSource(draft)` accepts one named main table, 1–32 named
  projected columns, up to eight AND-connected scalar predicates (`=`, `<`, `>`,
  `IS`), up to two ordered columns and LIMIT 1–100. Identifiers are quoted;
  values remain bound parameters. The output is a detached draft, exact
  `sourceSql` and original scalar `parameters` (booleans bind as SQLite 0/1).
- `explainSqliteProjection(db,draft)` checks existing query_only=ON,
  foreign_keys=ON and trusted_schema=OFF without changing them, rejects TEMP
  objects, views, virtual/shadow tables, hidden/generated columns and unknown
  columns, and compiles/steps only `EXPLAIN QUERY PLAN <generated SELECT>`.
- The result includes exact source/parameters, schemaRevision, nodes,
  `estimatedOnly: true` and `scope: structured-single-table-projection`.
- Nodes preserve id, parent, auxiliary and opaque detail. No cost, duration or
  measured row count is inferred. SQL.js 1.14.1 embeds SQLite 3.49.1; a real test
  returns nonzero 216 in the column labelled `notused`. It is retained only as
  opaque auxiliary data, not relabelled as actual cost.

The supplied connection must be the exclusive live plugin-owned stock SQL.js
instance, without user-defined functions/extensions. No source SELECT is run;
no query results, SQL history, PRAGMAs, transaction state or schema are modified.
The module cannot prove safety for an arbitrary customized engine.

## Deliberately unsupported

SQL.js exposes iterateStatements/getSQL but no public statement-readonly API.
A prefix check would not establish that WITH targets a SELECT. This version
therefore does **not** accept raw SQL, WITH, expressions, functions, scripts,
ANALYZE, DML or DDL; extra request fields are rejected. It must not be wired to an
arbitrary editor string while claiming equivalent validation.

Limits: SQL 8192 UTF-8 bytes, 64 authoritative source columns, 128 plan nodes,
2048 characters per detail, 32 KiB aggregate detail and depth 16. Duplicate IDs,
missing parents, cycles and malformed result columns are rejected, not silently
truncated. Generic engine errors do not echo SQL or values.

These are input/output limits, **not a hard synchronous CPU/memory watchdog**.
This slice does not repair the existing arbitrary-read execution-budget gap.
The estimated plan can change with schema/statistics or SQLite versions and
must not be presented as runtime performance evidence.

## Evidence and follow-up

Six independent tests run actual SQL.js: SCAN before an index versus SEARCH
using the created index; unchanged row data/schema during explanation; bound
and quoted SQL-looking inputs; source query never prepared/executed; unsupported
sources/guards; structural tree rejection. These are engine tests, not native
App acceptance. Next integration should be a separately labelled table-browser
projection action, followed by explicit native clicks and index-before/after
screenshots. Do not claim arbitrary editor/WITH support.

DBX reference: `apps/desktop/src/components/editor/QueryEditor.vue:1025–1027`
exposes Explain; `composables/useSqlExecution.ts:1008–1022` resolves its inputs;
`crates/dbx-sql-core/src/query_execution_sql.rs:142–184` separates estimated
plans and execution-bearing ANALYZE. This module is a narrower SQLite slice.

The alpha34 facade/UI candidate is reached from a table's Estimated plan action,
not the arbitrary SQL editor. The user chooses projection, at most one UI filter
and optional ordering. It displays exact generated SQL, bound parameters, a plan
tree and raw node rows, explicitly estimated-only. No performance or measured cost
claim is made; engine auxiliary fields remain opaque. Native verification pending.
