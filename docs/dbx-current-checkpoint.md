# DBX parity checkpoint: implementation is not acceptance

Date: 2026-11-07 UTC. Documentation-only audit at plugin `d5dd168` (including whole-SQL formatter
UI commit `9849b7d`); DBX `b6c3d47`, Netcatty main `4a55492`.
This checkpoint intentionally does not overwrite the older parity ledger, whose
formatter, snapshot and SQL-library rows predate newer slices. No completion
percentage is meaningful from this evidence. The user's termination conditions
(nearly all DBX capabilities plus genuine host/multi-database acceptance; the user later allowed non-Docker hosts) are **not met**.

## Evidence categories

- **N**: installed plugin inside the real Netcatty main application, documented
  native action/readback. Only the particular tested action is qualified.
- **R**: actual database service exercised by independent Node protocol modules or
  official CLI through Netcatty's native SSH terminal. This is **not** a connected
  database-plugin UI or a main broker permission/TLS test. CLI and module evidence
  remain separate.
- **T**: real SQL.js engine, deterministic/injected protocol/storage/provider, or
  main SDK remote-DOM tests. None alone is native visual or real remote acceptance.
- **H**: a specific missing public host interface or deployment/environment
  prerequisite. This does not mean the entire capability is impossible.
- **M**: feature absent or no usable implementation demonstrated.

All local paths below are repository-relative unless prefixed `DBX:`. Native
artifact filenames are locators recorded by the coordinator in the linked docs;
this documentation audit did not re-open the desktop or independently replay video.

## Core acceptance matrix

| Capability | Current supported slice and strongest evidence | Missing scope / acceptance boundary | Verifiable source / evidence |
|---|---|---|---|
| SQLite connection and durable data | **N**: plugin-owned SQL.js database; explicit whole-DB snapshot save, connection reopen+restore, actual app process termination/restart+restore, three-row readback | Not arbitrary SQLite files, file synchronization/WAL, auto-restore or encrypted storage. Clear/corrupt/race paths **T**, not native in this pass | `sqliteClient.ts`, `snapshotStorage.ts`; `docs/native-snapshot-alpha27.md` (`full-app-snapshot-alpha27.mp4`, restart screenshots) |
| PostgreSQL | **R**: PG 17.6 TLS/SCRAM; actual protocol read/filtered/metadata/index slices have separate qualification. Native SSH psql DDL/UPSERT is separate CLI evidence | **H/M**: main byte-stream API cannot perform PG SSLRequest→TLS upgrade; no installed-plugin PG connection/query workspace. No broad arbitrary SQL, writes, type or production qualification | `docs/postgres-transport-boundaries.md`, `postgres-filtered-local.md`, `postgres-metadata-local.md`, `postgres-indexes.md`; `src/postgres*.ts` |
| MySQL | **R**: MySQL 8.4.7 verified TLS, caching_sha2 full/fast auth and failures; text SELECT and prepared bound int64/text/NULL repeat reads using actual modules | **H/M**: same greeting→TLS upgrade gap. Metadata module is **T** until its harness is actually run. No native-plugin MySQL connection, arbitrary writes, MariaDB/auth-switch breadth | `docs/mysql-live-protocol-acceptance.md`, `mysql-read-boundaries.md`, `mysql-prepared-boundaries.md`, `mysql-metadata-boundaries.md` |
| Redis | **R**: Redis 7.4.2 TLS, codec/browser INFO/SCAN/TTL and all five value types, list paging, wrong-password/certificate rejection. **N**: unconfigured endpoint UI only | Packaged TLS endpoint list is empty; no usable installed-plugin real-service connection. No Redis mutation, pub/sub, cluster or DBX specialist-tool parity | `docs/redis-live-protocol-acceptance.md`, `redis-ui-validation.md`; `redisDeclarations.ts`, `RedisWorkbench.tsx` |
| ClickHouse and remaining drivers | ClickHouse HTTPS read adapter with fixed metadata/typed bounded reads is **T** | No ClickHouse UI route, configured declaration or real-server acceptance. MongoDB, most SQL vendors, queues/middleware **M**; catalog names are not drivers | `docs/clickhouse-client.md`, `src/clickhouseClient.ts`, `src/domain.ts`; DBX `src-tauri/src/commands/external_db.rs`, specialist `*_cmd.rs` |
| Saved connections/credentials/SSH host discovery | **N** local saved connection metadata; real Netcatty SSH terminal exists independently | No plugin-owned host→database detection→tunnel→connection end-to-end. No persistent encrypted database credentials. Host metadata listing/requestConnect must not be called database detection/tunnelling | `docs/local-docker-acceptance.md`, `native-ssh-postgres-acceptance.md`, `src/VaultHosts.tsx`; DBX `commands/connection.rs`, `connection_secrets.rs`, `keychain.rs` |
| Metadata browser | **N** SQLite table/view/columns/indexes/FK definitions; **T** bounded metadata error cases | No full multi-catalog/schema remote explorer, procedures, triggers editing or vendor metadata parity | `inspectSqliteSchema` in `sqliteClient.ts`; DBX `components/objects/`, `components/structure/TableStructureEditor.vue:752–755,1023,1156` |
| Reviewed DDL | **N** SQLite CREATE TABLE/INDEX, nullable ADD COLUMN, conservative RENAME COLUMN, ordinary DROP INDEX; UNIQUE-drop warning inspected and cancelled | General ALTER/DROP TABLE, defaults/types/constraints editing, dependency-preserving rebuilds, full FK/trigger editing and remote DDL **M**. UNIQUE-drop commit only **T** unless later evidence says otherwise | `docs/native-schema-alpha25.md`, `create-table.md`, `create-index.md`, `rename-column-safety.md`, `drop-index.md`; DBX `components/structure/TableStructureEditor.vue` |
| Grid single-row CRUD | **N** UPDATE/DELETE with readback; INSERT Auto PK/text review+confirm/readback and duplicate-key rollback | Native NULL/literal-default/deferred-FK cases not all performed; those **T**. Strict column/type/PK/table restrictions; remote grid CRUD **M** | `docs/grid-mutation.md`, `native-insert-alpha26.md`; `RowMutation.tsx`, `RowInsert.tsx`, `rowInsertModel.ts` |
| Grid staged/bulk edits | **M** multi-row staging/undo and atomic reviewed update/delete batches; CSV batch insert is not this feature | Need exact original-row conflict checks, affected-row counts, atomic rollback and one immutable batch review | DBX `composables/useDataGridEditor.ts:221,428–432,492,533–560` holds pending-change snapshots/version checks; `:1438–1457` stages new rows; `:1731–1774` stages deletions |
| Manual transactions / scripts | **M** user-controlled BEGIN/COMMIT/ROLLBACK and script execution | Internal savepoints and read-only protocol transactions are safety mechanisms, not user transaction controls. Selection execution also needs **H** caret contract | DBX `components/layout/EditorToolbar.vue:96–104,136–137,408–412`; plugin `sqliteClient.ts` reviewed single operations |
| Result grid | **N** bounded returned rows, local paging/filter/sort and cell inspection | No server-side cursor paging, large virtual grid or unrestricted data loading. Export/inspection must disclose truncation | `preview.ts`, `ResultGrid.tsx`; DBX `components/grid/DataGrid.vue` |
| Export | **N** CSV/JSON/Markdown/SQLite INSERT full returned-result copy workflow | Returned bounded result only, not whole database/table dump. XLSX/native file/export queues/scheduling **M** | `docs/result-export.md`; DBX `components/export/DatabaseExportDialog.vue`, `src-tauri/src/commands/database_export.rs`, `csv_export.rs` |
| Import | **N** pasted CSV reviewed atomic two-row import; **T** bounds/null/errors/rollback | No file chooser ingestion, XLSX/JSON/SQL script import, column mapping/conflict modes or remote import | `docs/csv-import.md`; DBX `components/import/TableImportDialog.vue:142,179,192–219,222` lists CSV/JSON/Excel/SQL and conflict capabilities |
| SQL editing | **N** bounded textarea/highlight/tabs. **T** newly integrated whole-document format→review→apply→Undo; native format acceptance pending | Actual CodeMirror-grade editing, selection/caret formatting/execution, completion acceptance **H**; diagnostics/snippet expansion **M** | `docs/editor-capabilities.md`, `SqlEditor.tsx`, `SqlFormatControls.tsx`; DBX `QueryEditor.vue:1911–1924,1964–1980,3201–3210`, `useQueryEditorExecution.ts:45–93` |
| SQL library / drafts | Draft save/restore native path has separate evidence. New explicit persistent named SQL library, stale revisions and delete/replace review are **T** | Native named-library restart durability not yet qualified; snippets/cloud sync/external SQL files **M** | `docs/workspace-drafts.md`, `query-library-storage.md`; DBX `commands/history.rs`, `list_sql_files.rs` |
| AI generate/explain/optimize/fix | Host draft/Agent integrations, explicit unexecuted insertion, cancellation and bounds **T** | No real configured provider acceptance; database-tool registry and DBX agent SQL-tool approval loop not complete. Fake provider output is not live AI | `docs/ai-parity.md`; DBX `components/editor/AiAssistant.vue:400–408,671`, `crates/dbx-core/src/ai/` |
| ER, schema diff, explain plans, lineage | **M** usable plugin visualization/diff/plan UI | Ordinary metadata relationships are available; this is not entirely a host limitation. Host disallows dynamic SVG/canvas in remote DOM, but a bounded HTML relationship view remains feasible | DBX `components/diagram/SchemaDiagramDialog.vue:48–49,72,155–199`, `lib/diagram/erDiagram.ts`, `src-tauri/src/commands/data_compare.rs`; main `domain/pluginRemoteTreePolicy.cjs:7–9` |
| Transfer/dumps/scheduling | **M** cross-connection compare/sync, vendor dumps and background scheduled jobs | Whole-SQLite snapshot is explicit local storage, not scheduled/vendor dump parity | DBX `commands/data_compare.rs`, `database_export.rs`, `dameng_dump.rs`; `docs/native-snapshot-alpha27.md` |
| Docker versus later authorized real-host acceptance | Docker **H**, not completed; non-Docker real services **R** | User later explicitly allowed a real host without Docker. Docker is no longer a termination prerequisite, but genuine plugin/host/multi-database qualification is still incomplete. Official binaries do not establish daemon access; their real-service tests remain separately labeled | `docs/local-docker-acceptance.md`, `runtime-port-isolation.md`. Do not reinterpret real SSH service tests as Docker acceptance |

## Three next core implementation slices

1. **Atomic reviewed multi-row SQLite UPDATE/DELETE staging.** Build on the existing
   exact-row models, not arbitrary SQL or eager writes. Cap rows/parameters and
   reject unsupported tables; show every SQL statement and binding before one
   confirmation. Any stale original row or wrong affected-row count rolls back the
   entire batch. Add discard/undo before apply, connection/schema isolation and
   native readback/conflict rollback. This directly closes the DBX staged-grid gap
   and needs no new host permissions.
2. **Broader structured SQLite DDL with dependency-safe rebuilds.** First define a
   narrow supported ordinary-table schema and rebuild plan for changing nullability
   or a literal default; preserve exact columns/data/indexes/FKs or refuse. Inspect
   dependencies, preview all generated SQL, validate candidate schema and data under
   a transaction, then apply once with rollback on any mismatch. Avoid advertising
   general ALTER until checks/collations/triggers/views are genuinely preserved.
   Start with engine/model tests before UI/native migration acceptance.
3. **First genuine installed-plugin remote read workspace through an available
   public transport.** ClickHouse HTTPS is a candidate already supported by a
   read-client module; Redis direct TLS is another narrower specialist route.
   Choose one explicit, authorized endpoint with suitable verified TLS and a real
   fixture, declare only that exact resource, then integrate auth, metadata and
   real reads into the plugin UI and record native acceptance. This is conditional
   on legitimate endpoint/credential permissions and a reachable service, not
   permission to repurpose the loopback Node harness or bypass main's local-peer
   restrictions. PG/MySQL modules still need a public STARTTLS-capable transport;
   independent protocol progress alone cannot close their main-UI gap.

The first two slices can advance immediately in the current plugin environment.
For the third, develop UI/controller boundaries with honest injected tests while
obtaining the precise supported fixture/endpoint; never mark it real until the
installed plugin actually connects. A bounded ER relationship view is worthwhile
but ranks behind safe data/schema modification and a usable remote database lane.


## Later candidate progress (alpha29, native acceptance pending)

The atomic batch adapter and selected-row DELETE UI are now implemented with
real SQL.js + remote-DOM acceptance, not yet native GUI acceptance. Shared schema
lexing now preserves bare CR inside -- comments, and single-row mutation refuses
implicit ON CONFLICT side effects. Plain HTML reported-FK relationships and explicit
AI draft Retry/Edit-last are implemented; no real AI provider or full ER editor
claim is added. See sqlite-grid-batch.md and ai-parity.md for exact boundaries.

## Verified follow-up (alpha30, 2026-11-07)

- **N**: whole-SQL formatting preview/apply/undo, named SQL saved and recovered after true original-app process restart, loading without automatic execution followed by explicit readback.
- **N**: actual reported FK relationship overview; bounded selected-row atomic DELETE, full SQL/parameter review, confirmation, explicit reread. Alpha30 repeats native verification with highlighted shared SQL, compact parameters and corrected editor height.
- **R**: independent MySQL 8.4.7 fixed TABLES/COLUMNS/STATISTICS reads passed strict TLS1.3, bound SQL-looking name negative and same-connection read reuse. Exact system-view metadata profiles are isolated from ordinary prepared reads. This is not installed-plugin MySQL connectivity.
- **T**: conservative SQLite table rename now integrated in facade and UI, 44 actual main remote-DOM scenes including preview/confirm/new schema. Native alpha31 acceptance remains pending. Dependencies outside the supported subset refuse or rollback; general table rebuilds are not implemented.

Actual image/video details: native-alpha29.md (also covers alpha30), mysql-metadata-boundaries.md. Core remote-transport and broader DDL gaps above remain; no near-complete claim.
