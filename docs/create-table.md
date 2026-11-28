# Reviewed SQLite CREATE TABLE

This slice works only in the disposable in-plugin SQL.js SQLite session. It is not a remote server driver or persistent database editor.

Use **New table** in the connection sidebar, define columns, inspect **Preview CREATE TABLE**, then explicitly confirm. Form edits invalidate the preview. A preview is bound to one connection, exact canonical draft and SQLite schema revision; it is issued and consumed once. Cancel before submission does not execute DDL. An already submitted operation is not presented as cancellable.

Supported: up to 32 columns, five SQLite type affinities, nullable columns and at most one non-null primary key. Names are quoted as identifiers; duplicates, reserved SQLite names, unsupported properties and oversized schemas are rejected. There are no raw defaults, expressions, CTAS, virtual tables, DROP, ALTER or foreign-key authoring. The operation uses a savepoint, enforces schema and 1 MiB budgets before commit and restores query-only protection afterward. Failed protection restoration closes the session.

## Evidence and limitations

- Engine tests use actual SQL.js: quoted injection-looking identifiers, exact/one-shot reviews, cross-session/closed/stale rejection, schema budget rollback and read protection.
- Controller tests cover edits, cancellation, unmount, stale async previews, duplicate confirmation and refresh failure.
- The main remote-DOM regression drives the actual UI and SQLite engine through create, edit-invalidated preview, confirm, schema inspection and cancelled preview. Host view transport is injected, so this alone is not native UI evidence.
- Full unmodified Netcatty main `4a55492`, plugin alpha.13: created `release_notes(id INTEGER PRIMARY KEY NOT NULL, title TEXT)`, inspected both columns in the structure tree, reviewed an INSERT and read back `1 / Created in Netcatty`. Native screenshots and a recording are stored separately from source.
- No Docker, SSH host discovery or real remote database acceptance is implied. ALTER/index/constraint editing and vendor-specific DDL remain unfinished.
