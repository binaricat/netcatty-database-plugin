# Reviewed single-row grid changes

Alpha.15 adds an explicit **Edit** action to rows from the generated table read, not arbitrary SQL results. It opens a form for an UPDATE or DELETE of exactly one row in the disposable SQLite session. It is not an inline auto-save editor. Primary keys cannot be edited. Values have explicit text, number and NULL types.

Preview binds all values as parameters and includes the complete original row plus primary key in the predicate. Confirmation consumes the exact handle-bound, schema-version-bound review once. Any changed original value, stale schema, altered review or non-single-row result fails and rolls back. Comparisons use SQLite `COLLATE BINARY IS`; SQLite numeric equality still treats equivalent integer/real values as equal. Savepoints, read-protection restoration and database-size budgets are retained. There is no retry or undo claim.

Only known regular tables with a complete primary key and full column metadata qualify. Views, BLOB columns, incomplete/truncated results, tables wider than 16 columns, unsupported values, triggers and unsafe cascading effects are refused. Delete checks incoming foreign keys; update checks effects on referenced changed columns. The adapter rechecks current metadata, not just the rendered form. Successful mutation clears every result in that connection; SQL drafts remain, and the user explicitly reruns a read.

## Evidence and limits

- Eight pure-model tests, five actual SQL.js integration tests and eleven controller/SSR tests cover binding, conflict rollback, exact review consumption, metadata restrictions, NULL, tampering and cancellation boundaries.
- Total suite: 212 passing tests. Main remote-DOM regression: 20 scenarios, 197 batches, maximum 777 operations. This regression uses injected host transport and is not native evidence.
- Full unchanged Netcatty main `4a55492`, alpha.15: edited notes row 1 title to `Edited in Netcatty grid`, reviewed and confirmed UPDATE, explicitly reran SELECT and observed the changed value. Then reviewed and confirmed DELETE, reran SELECT and observed only rows 2 and 3.
- Native recording is 180 seconds and covers UPDATE/readback and DELETE preview. The final delete application/readback is evidenced by separate native screenshots, not by that recording.

This is a real SQL.js engine with synthetic disposable data in the full Netcatty app. It is not a remote service or Docker acceptance test. Grid INSERT, bulk edits, persistent databases, wider tables and vendor-specific CRUD remain unfinished.

## Review UI refinement

Alpha.18 replaces large read-only form fields with compact original-value lists in DELETE mode and separates editable fields from the review panel. SQL is rendered as escaped React text tokens, not HTML or editable content. The former 20-token editor budget made generated DELETE statements fall back to plain text; read-only previews now use a bounded 128-segment budget with an exact generated-DELETE regression. Actual full Netcatty screenshots verify keyword highlighting, reduced borders and aligned field layouts. Dark-theme and narrow-window native acceptance remain pending; responsive CSS and inherited host palette alone are not evidence of that acceptance.

Alpha.20 follows the [DBX source layout audit](dbx-row-layout-audit.md): a compact
single-column delete review with full original JSON, highlighted SQL, all bound
parameters and one footer. Legacy two-column CSS was removed. The shared safe
SQL preview is also used for CREATE TABLE/INDEX, CSV and manual write reviews.
Remote-DOM interaction regression passes; native alpha.20 screenshots verify the compact review and subsequent delete
readback (row-delete-dbx-layout-alpha20.jpg, row-delete-readback-alpha20.jpg).
Previous alpha.18 screenshots are not presented as this revision.
