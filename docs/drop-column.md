# Conservative reviewed SQLite DROP COLUMN

DBX's `crates/dbx-core/src/schema/table_structure_sql/sqlite_rebuild.rs` implements
broader table reconstruction (including rename/swap SQL around line 561). This
slice deliberately uses native `ALTER TABLE … DROP COLUMN`, not that rebuild
strategy or a general dependency-rewrite engine.

`createDropColumnAdapter({getDatabase,inspectSchema,reviewTokens,onFatal?})` exposes
`preview({handleId,draft:{table,column}})`, `apply({handleId,review})`, `cancel(handleId, expectedToken?)`
and `dispose()`. Review includes exact SQL, schema versions, handle/token,
`affectedRows`, and `warning:'permanently-deletes-column-values'`. The alpha32 UI explicitly discloses that every value of the selected column is permanently lost.
No row contents enter the public review.

Supported target: ordinary non-strict rowid table, at least two columns, dropping
one non-PK column. All target indexes, outgoing/incoming FKs, defaults, CHECK,
UNIQUE, COLLATE, generated/hidden columns and AUTOINCREMENT are refused. In this
first slice **any** trigger, TEMP object, virtual/shadow/WITHOUT ROWID table,
or internal persistent system table anywhere in the database refuses the operation.
Unrelated views are permitted: all views' xinfo is compared before/after, and
SELECT * FROM each view LIMIT 0 is prepared (never stepped) to verify compilation.
Other objects' exact sqlite_schema rows must remain unchanged. Direct/indirect
dependent views that fail compilation, and SELECT * views whose output columns
change, cause refusal or rollback. Views are never included in data scans. Quoted identifiers remain quoted, not executed as SQL.

## Data preservation, not only schema preservation

Preview retains a private bounded snapshot of actual data. Apply rejects data-only
changes since preview. During the owned transaction, a second snapshot compares
all retained target columns and all other table rows before/after ALTER. Rowid and
SQLite storage classes are included. Integer values are converted by SQLite to
text to preserve int64, BLOBs and TEXT bytes to exact hex (TEXT via CAST AS BLOB
to avoid embedded-NUL/invalid-UTF8 conversion loss), finite REAL values to exact JS numeric
representations (including a distinct negative-zero marker), and NULL is retained.
NaN/infinite values are refused. One unshadowed rowid alias is required; tables
shadowing all `_rowid_`, `rowid`, `oid` aliases are refused.

Limits: 1 MiB database, 32 ordinary tables, 64 columns per table, 1000 total rows,
96 KiB serialized row snapshots, 96 KiB schema snapshots. Oversize data fails rather
than being sampled. At most four pending private snapshots are retained. JavaScript
strings cannot be securely erased; clearing references is not a secure wipe.

Use the same shared review token map as other operations. Cancel/consumption clears
the private snapshot. Other operations must call this adapter's `cancel(handleId, expectedToken?)`
when invalidating its review; merely overwriting the shared map prevents use but
cannot immediately notify the private map. Stale entries are additionally pruned
on the next preview. Close/disposal must call cancel/dispose. No persistence occurs.

Entry/commit guard checks require query_only=ON, foreign_keys=ON, trusted_schema=OFF.
An owned BEGIN rejects a pre-existing transaction without committing it. DDL and
verification run under a savepoint; failure rolls back the owned transaction.
Rollback/protection failures close the DB and notify the owner. The parent must
serialize calls, resolve only live handles, and remove fatally closed instances.

Twelve real SQL.js tests cover data fidelity, stale data, injected row corruption
rollback, constraints/dependencies, budgets, rowid shadowing, quoting, review
invalidation, transaction/protection refusal and closed handles. Facade and native evidence are recorded below; engine tests are not GUI evidence.

Token cleanup uses parsed exact handle/token equality, never substring matching.
System-table prefix filtering uses an exact sqlite_ prefix, not SQL LIKE wildcard
semantics; legitimate names such as sqliteXdata remain in row preservation scans.

UI late cleanup should pass its review token to cancel; a mismatched token is a
no-op and cannot remove a newer preview. Central access/close invalidation omits
the token to clear the current pending drop review.

## Facade and UI integration (alpha32)

The facade now clears this adapter's private snapshot on every unrelated database
operation, close and disposal. Its own preview/apply resolver preserves the review
until exact consumption. UI cleanup supplies the exact token; delayed cleanup
cannot erase a newer preview or another operation's token. The UI discloses the
permanent loss and exact affected-row count before a red explicit confirmation.
47 main remote-DOM scenes include DROP preview, commit and retained-data readback;
550 full tests pass. Native alpha32 installation and preview/commit/readback passed;
see `native-drop-column-alpha32.md`. Snapshot operations also immediately clear
private DROP review data, not only the shared authority token.

Audit regressions fixed before native use: SQLite TEXT containing NUL/invalid
UTF-8 is compared as full hex bytes, not SQL.js's truncated text value; system-name
filtering matches literal sqlite_ rather than LIKE's wildcard underscore. Exact
private-review cleanup is covered by late-token and cross-operation tests.
