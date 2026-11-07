# Restricted SQLite rename-column plan

`previewRenameColumnSql` is a pure SQL preview, not execution authorization. Its
`dependencyValidation: adapter-required` result explicitly does **not** prove the
whole database has no dependencies. It recognizes a narrow plain CREATE TABLE
grammar, rejects target indexes, triggers, outbound/inbound foreign keys and PK
renames, and excludes generated columns, CHECK, defaults and other expressions.
Other tables' triggers and views are deliberately not a global prohibition.

The plugin-local adapter implements the following checks:

1. Read authoritative main **and temp** sqlite_schema plus pragma_table_list and
   table_xinfo. Require an ordinary main table, no hidden/generated columns, no
   ambiguous temp shadowing, and metadata matching the preview. Existing UI
   schema omits some objects and is not sufficient evidence.
2. Bind review to the same connection, SQL, normalized draft and schema versions
   for all inspected schemas; revalidate immediately before application.
3. In a savepoint, snapshot the full main/temp schema (type, name, tbl_name, SQL)
   and the table metadata, execute the single quoted ALTER statement, then
   compare. Every non-target object's SQL and identity must be unchanged. If
   SQLite rewrites a dependent view/trigger/index/FK, roll back. Require target
   column metadata to differ only in the reviewed name, with identical order,
   types, constraints, hidden flags and primary-key membership.
4. Bound snapshots and resulting schema/DB size. Verify row count/data invariants
   in real-engine tests. Do not reconstruct or rewrite other objects manually.
5. On any uncertainty, parsing error, schema mismatch or budget violation roll
   back before reporting success; restore query_only, closing the session if
   rollback/read protection restoration fails. Refresh UI schema and invalidate
   old row/editor reviews after success.

Preview never executes ALTER and remains marked adapter-required. Apply performs
the dependency checks inside its savepoint before releasing it. The model alone
must not drive an execution path without these checks. TEMP objects currently
reject conservatively. The facade issues one-shot reviews bound to both main and
temp schema versions; other structured previews invalidate the previous review.
Immutable data is not copied or rewritten by this ALTER; engine tests verify data
and schema-version preservation on rollback. The alpha.24 Alter table panel exposes Add/Rename as local tabs, with independent capability checks and no extra sidebar entry. Both modes share a serial preview queue so a cancelled request cannot overwrite a newer review. Apply locks mode switching; successful rename refreshes schema and invalidates stale results. SQL is rendered through the shared safe syntax preview.

Required engine tests: unrelated views survive unchanged; directly/indirectly
referencing views and triggers (including triggers owned by other tables and
TEMP objects) cause rollback when rewritten; malformed/unresolvable schema fails
closed; special quoted identifiers stay identifiers; stale reviews reject;
failed alterations restore schema versions and all data. No foreign-key or
legacy-alter compatibility PRAGMA may be weakened to make a rename succeed.

Validation: 319 tests, TypeScript/asset/host-policy lint, and 26 real-SQLite main remote-DOM scenarios pass. The remote-DOM lane uses injected transports and is not native UI evidence. Alpha.24 has been imported/enabled in the full main application; rename native acceptance remains pending.
