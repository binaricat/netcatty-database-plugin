# Reviewed SQLite DROP VIEW

`src/sqliteDropView.ts` exports `createDropViewAdapter` with the same local
getDatabase/inspectSchema/shared reviewTokens/onFatal contract as CREATE VIEW.
Methods: preview/apply/cancel(handleId,expectedToken?)/dispose.

Draft is `{name}`. Review binds exact SQL and original view definition to the live
handle, main/TEMP schema versions and one-use token, and includes the explicit
warning `removes-view-definition-only`. Confirming permanently removes that view
**definition**, not source table data. No materialized-view or trigger management
is supported. This is not DROP TABLE or arbitrary SQL authority.

Only an authoritative ordinary main view is accepted. System names, tables,
TEMP objects, any triggers, virtual/shadow tables, invalid dependent views and
metadata beyond bounded budgets are refused. Every view is checked using xinfo
and a prepared SELECT * LIMIT 0 statement, **never stepped**. After DROP, all other
catalog rows, view column metadata and schema metadata must remain identical.
Dependent views that no longer compile cause rollback; no dependency rewrite or
cascade option is offered. No view/source data is read or executed by this module.

Guard checks, an owned BEGIN/savepoint, pre-commit protection verification and
finally restoration follow CREATE VIEW. Pre-existing transactions are rejected
before restoration paths, leaving caller guard state untouched. Rollback or
protection failure closes the instance and notifies the parent. Limits include
128 catalog objects/96 KiB catalog, 64 columns per view/96 KiB view metadata,
8192-byte definition, existing schema inspector limits, a 1 MiB database, and four
pending token owners. Cancellation only clears its exact owned token; late old
cleanup cannot invalidate a newer preview or another operation. Parent wiring
must serialize operations and invalidate on close/schema access.

Seven real SQL.js tests cover preview/cancel, unchanged source data, dependent
view rollback, no view stepping, quoted names, scope refusal, token and stale
reviews, transaction/guards, post-DDL budget rollback and fatal cleanup. Native UI
acceptance and public-facade wiring are separate work, not established here.

Alpha34 integration candidate adds the action to a selected view's existing
Structure/Data navigation, not a new sidebar block. Entry preselects that view.
Facade capability is database.sqlite-drop-view.v1; schema refresh removes obsolete
object tabs and clears prior results without running a data query. Native evidence
is pending; 53/54-stage injected main remote-DOM runs cover exact review, removal,
manual source-row readback and leaving a pending review for Local snapshot.
