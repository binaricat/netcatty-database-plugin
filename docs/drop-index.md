# Reviewed SQLite DROP INDEX

This slice implements a plugin-local preview model, SQL.js adapter and alpha.25
Indexes panel with Create/Remove modes. **Native application acceptance remains pending.** Tests
use the actual SQL.js engine and injected plugin storage, not a remote database.

## Supported scope

`previewDropIndex({handleId,draft:{table,name}})` returns the normalized draft,
exact schema-qualified DROP INDEX SQL, `unique`, and connection/main/temp schema
revision binding. Preview executes no DDL. `applyDropIndex({handleId,review})`
accepts only the unchanged one-shot review for that live connection. All existing
structured DDL previews share the same review slot, invalidating each other.

Only explicit indexes with SQLite origin `c`, real named columns and a stored
CREATE INDEX definition qualify. Partial and expression indexes, reserved
`sqlite_*` names, primary-key indexes and UNIQUE-constraint autoindexes reject.
An explicit CREATE UNIQUE INDEX **is** supported: dropping it removes that
index's uniqueness enforcement. The confirmation UI shows `unique`
and explicitly discloses this consequence; it is not just a performance change.

## Conservative exclusions

- Any foreign keys on, or pointing to, the target table.
- Persistent view/trigger/table SQL containing `INDEXED` hints. SQLite can leave
  INDEXED BY references broken without rewriting their stored SQL, so a simple
  before/after SQL comparison alone is insufficient. This check can reject
  unrelated hints or quoted occurrences conservatively.
- TEMP objects, strict/virtual/shadow tables, hidden/generated columns, and target
  columns with defaults. These follow the shared authoritative metadata guard.
- Unknown/incomplete metadata or metadata/database budget overflow.

Unrelated ordinary views and indexes remain allowed. No PRAGMA disabling foreign
keys, host policy, or verification is used to make a drop succeed.

## Transaction guarantees and bounds

Apply snapshots complete main/temp sqlite_schema identities and SQL plus table
column metadata, disables query_only within the controlled operation, opens a
savepoint, drops the single reviewed index, then checks that every other schema
object and all other structured metadata are unchanged. Maximum snapshots are
128 objects and 96 KiB; existing metadata limits and a 1 MiB database size cap
also apply. A violation rolls back the index and schema version. Read protection
is restored on all paths; rollback/protection failure closes the session.

Known RenameColumnError values from the shared authority/temp-version helper are
translated into DropIndexError classifications. Unknown shared-helper codes
become a generic error rather than leaking the rename-specific UI taxonomy.

Real-engine tests cover preservation of rows and other indexes, quoted names,
autoindex/partial/expression/FK/hint rejection, TEMP/default/metadata-budget error
classes, post-DROP size-budget rollback, one-shot and cross-DDL invalidation,
tampered/cross-session/closed reviews. The 29-scene main remote-DOM lane covers ordinary/UNIQUE removal and metadata readback, but uses injected transports and does not replace native screenshots or confirmation acceptance.

Native alpha.25 scoped acceptance is now recorded in `native-schema-alpha25.md`; only its explicitly exercised paths are qualified.
