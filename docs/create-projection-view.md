# Reviewed SQLite projection views

This is a structured subset, **not arbitrary SELECT authority**. Existing
`sqliteClient.readSql` only checks a read-statement prefix; it is not an authorizer
or AST parser, and the current SQL.js execution path lacks a CPU interrupt. It is
not reused to approve persistent arbitrary view definitions.

DBX exposes broader view operations and source-DDL retrieval (for example
`crates/dbx-core/src/schema/mod.rs` view-DDL tests and source-kind handling around
lines 4961–5017 and 12525). This increment only creates a one-table projection.

## API and constraints

`src/sqliteCreateView.ts` exports `createCreateViewAdapter` with the existing local
`getDatabase`, `inspectSchema`, shared `reviewTokens`, optional `onFatal` contract.
Methods are preview/apply/cancel(handleId,expectedToken?)/dispose.
`CreateViewDraft` is `{name,sourceTable,columns:string[]}`; a review contains exact
SQL, canonical draft, handle/token, main/TEMP schema versions. Result contains
`{schema,sql,changes:0}`. Optional-token cancellation clears only its own current
token, never another operation or a newer preview.

Generated SQL is exactly `CREATE VIEW main.name AS SELECT explicit_columns FROM
main.source`, with every identifier quoted. No WHERE, JOIN, functions, scripts,
expressions, parameters, star expansion or recursive query is accepted. Source
must be an authoritative ordinary non-strict rowid main table with no hidden or
generated columns, never another view or virtual table. Column names/types and
order must agree with xinfo. Names are bounded, system names/conflicts refused,
and 1–32 distinct selected columns are required. TEMP objects are refused.

Apply checks query_only/FK/trusted_schema guards, rejects an existing transaction,
uses its own BEGIN/savepoint, and compares all previous catalog rows and schema
metadata unchanged. The new view's exact stored SQL, identity, column order/types
and view metadata are checked. A LIMIT 0 SELECT is **prepared but never stepped**:
creation does not run source/view data. Schema/SQL/1 MiB database budgets apply.
Failure rolls back; protection or rollback failure closes the DB and notifies the
owner. Parent integration must serialize live-handle access. Other reviewed DDL
and snapshot operations replace/invalidate the shared review; close cancels it.
Read-only schema inspection alone does not invalidate this schema-bound review. It must not expose raw query strings through this API.

Eleven real SQL.js tests cover cancellation, column/type/order, preserved data,
identifier quoting, no data execution, unsupported inputs, exact definition,
shared tokens, stale schema, active transaction, guard drift, budgets and fatal
rollback. The independent UI is developed separately; native acceptance is not
established by these module tests.

Preview checks protections without changing them. Pending tokens are bounded to
four with stale-token pruning. Apply rejects a pre-existing transaction before
entering guard restoration, so the caller transaction and its guard state remain
untouched. Dedicated tests cover both behaviors.

## Alpha33 UI/facade candidate

The existing New table entry becomes a single New object entry with Table/View
content tabs, rather than adding another sidebar button. The view form provides
name, ordinary source table and named-column choices, exact SQL highlighting,
explicit confirmation, schema refresh, and no automatically executed data query.
Parent scopes hold schema busy leases by operation symbol, so one late completion
cannot unlock another operation. Older installed controllers and asynchronous
snapshot/query-library operations are being migrated in the same change.

The facade exposes capability `database.sqlite-create-view.v1`; cross-operation
cleanup cannot erase a newer view's review. In particular a stale rejected DROP
apply no longer deletes the shared authority token before verifying ownership.
Tests include actual SQLite creation and manual readback, and the main remote-DOM
flow now has three additional stages (preview, commit, manual view readback).
Native alpha33 acceptance remains pending until the final reviewed package is frozen.

Freeze gate: alpha33 passes 586 tests, lint/package validation and 50 actual
main remote-DOM snapshots (457 batches, maximum 788 nodes). The busy lease
migration now includes CREATE/ALTER/index/view, DROP/rename, batch mutations,
snapshots and persistent SQL library. Cancel/unmount invalidates publication but
holds each pending operation's owner until its real finally. Tests cover deferred
cross-controller overlap, stale releases, repeated cleanup and callback failure.
Package SHA256: fe91b595c1d0f24bd0237d736ff831cc4fda094c50385e6c5e33230f5cf292d0.
