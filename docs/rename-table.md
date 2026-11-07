# Reviewed SQLite table rename: conservative local adapter

DBX's `crates/dbx-core/src/schema/table_structure_sql/sqlite_rebuild.rs` (around
line 561) emits `ALTER TABLE … RENAME TO …` as part of a larger rebuild workflow.
Its transfer subsystem also renames tables to backup names. This slice does not
copy the full rebuild/dependency-management workflow.

## Integration API

`createRenameTableAdapter({getDatabase,inspectSchema,reviewTokens,onFatal?})` returns:

- `preview({handleId,draft:{from,to}})` → exact SQL, canonical draft, main and TEMP
  schema versions, handle and random token. It does not execute ALTER.
- `apply({handleId,review})` → `{schema,sql,changes:0}` after successful commit.
- `cancel(handleId)` invalidates the review without changing the database.

Use the existing authoritative schema inspector and the **same** review-token map
used by every other schema operation. The database resolver must reject closed
handles and honor existing workspace operation locks. This is a plugin-local
facade, not a new host RPC. No public adapter/UI/permission wiring is included.

## Boundaries

Only ordinary main-schema tables with supported scalar columns are accepted.
System names, strict/virtual tables, hidden/generated/default columns, CHECK,
any target index (including automatic constraint indexes), outgoing/incoming FKs,
unknown FK metadata, all triggers, and any TEMP objects are refused. The bounded shared lexer ignores quoted text and comments when checking those
keywords. It is not a general SQLite grammar parser.

Existing names conflict ASCII-case-insensitively; all identifiers are quoted.
Case-only renames are refused. An INTEGER PRIMARY KEY without an automatic index
can remain supported; this is not general composite-key/index rewrite support.

During apply, a savepoint contains the ALTER and validation. All other full
sqlite_schema SQL/identity rows and displayed metadata must remain unchanged;
target columns and rootpage must remain unchanged. A dependent view rewritten by
SQLite is therefore rolled back, while unrelated views can remain. No claim is
made that dependency rewrite is supported. Object/column/metadata limits and the
existing 1 MiB database limit apply. Failures roll back and query_only is restored;
rollback/protection failures close the unusable database. The parent resolver must
remove a fatally closed instance from its session map when integrating.

Preview tokens are one-shot and exact; other DDL previews must invalidate them.
This module has real SQL.js tests for cancellation, data preservation, identifier
quoting, dependent-view rollback, conflicts/dependencies, stale/cross-handle
reviews, shared-token invalidation, closed handles and post-ALTER budget rollback.
It has not been exposed in the native UI or recorded as native acceptance.

## Transaction and protection contract

Apply checks query_only=ON, foreign_keys=ON, trusted_schema=OFF before doing DDL.
It opens its own BEGIN, which rejects an existing outer transaction without
committing or rolling it back, then creates its savepoint. Only this owned outer
transaction is rolled back on failure. Before commit it verifies protections,
restores query_only=ON, and verifies again. Finally all three protections are
restored and checked. Fatal rollback/protection failure closes the instance and
calls optional onFatal(handleId) so the parent can remove the session reference.
An idle, serialized connection is still the expected caller contract; the BEGIN
check is defense in depth, not concurrent operation support.

Ten real-engine tests now also cover pre-existing transactions, entry protection
drift, pre-commit trusted-schema drift, fatal rollback notification, and quoted
keyword identifiers. Shared-map cross-operation invalidation remains covered.

## Standalone review UI

`RenameTable` now accepts `{database,handleId,schema,locale?,onApplied,onClose,
onBusyChange?}`. `database` implements the exported structural `RenameTableUiClient`
with asynchronous `previewRenameTable` and `applyRenameTable` methods. No main
host API is assumed. The parent must bind those methods to the local adapter,
refresh schema and invalidate/close old object tabs after success.

The component exposes table selection, new name, exact highlighted SQL preview,
and explicit confirmation. Preview and apply synchronously announce global busy;
apply cannot be cancelled or doubled. Late disposed/cancelled previews cannot
install a review, and disposal during apply suppresses UI callbacks without
claiming the already-submitted operation was undone. Success survives schema
prop publication. Error text states conservative scope, not automatic dependency
rewrite. Six controller/SSR tests pass; this does not constitute native UI
integration or smoke-test evidence.
