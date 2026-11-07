# DBX capability comparison and acceptance ledger

Audit date: 2026-11-07. This is a source-backed inventory, not a completed parity claim.

## Reproducible baselines

- Plugin before this work: [`6a5cbe0`](https://github.com/binaricat/netcatty-database-plugin/tree/6a5cbe0c0676aaf16c21750a22fbc8cdb4fb3ec6).
- Requested host main: [`4a55492`](https://github.com/binaricat/netcatty/tree/4a55492c17c3c792fbda4afc08d993f4165ca930).
- DBX: [`b6c3d47`](https://github.com/t8y2/dbx/tree/b6c3d4780448c6f42c9a6aef2f187937d0660369).
- The old host commit `1cfa14b808bcff813676c0e41c8ea522149b76dd` returned GitHub HTTP 422 (unresolvable commit) and `feat/plugin-database-foundation` returned 404 during the public audit. No old branch was used for debugging.
- Neither the plugin nor the host main snapshot contains `.agents/skills`. The host's root `AGENTS.md` was read. No host source changes are included.

The original plugin passes its 29 tests, lint, packaging and its vendored validator.
It fails **main's actual CLI validation** because `database.query.read` and
`database.query.write` are not main permissions. main's SDK has no
`context.database`, and its React adapter has no `HostViewController`.
The missing `views.modals` feature must not be confused with `modal` as an existing
view location. main **does** support `metadata.brand-icon`; its source constant
lives outside the JSON schema's named feature definitions.

Evidence: [main SDK](https://github.com/binaricat/netcatty/blob/4a55492c17c3c792fbda4afc08d993f4165ca930/packages/plugin-sdk/src/index.ts#L781),
[main permissions](https://github.com/binaricat/netcatty/blob/4a55492c17c3c792fbda4afc08d993f4165ca930/packages/plugin-contract/schema/plugin-contract.schema.json#L1761),
[main advertised features](https://github.com/binaricat/netcatty/blob/4a55492c17c3c792fbda4afc08d993f4165ca930/electron/plugins/hostService.cjs#L101),
[main React adapter](https://github.com/binaricat/netcatty/blob/4a55492c17c3c792fbda4afc08d993f4165ca930/packages/plugin-sdk/src/hostReact.ts).

## Completion method

A row is complete only when the stated user capability works on the requested main
host and has appropriate real integration/UI evidence. Partial means some usable
behavior exists but scope or qualification is materially narrower than DBX.
Missing means no usable implementation on main. Historical experimental-host
results cannot be carried forward as main acceptance.

After the reviewed CREATE TABLE slice: **0 of 24 capability groups complete; 12 partial;
12 missing**. This coarse count is not a percentage of engineering effort or a
weighted product completion score. It also does not establish that every DBX
advertised driver itself has been independently tested in DBX.

| Capability group | Status on main migration | Concrete gap / current evidence |
| --- | --- | --- |
| 1. Broad database connectivity | Partial | Real SQLite memory only. Catalog has 21 entries: 1 fixture, 3 wire labels, 9 protocol aliases and 8 catalog-only entries in the baseline; these labels are not working/qualified drivers. PostgreSQL/MySQL TCP from the old host is unavailable on main. |
| 2. Saved connections | Partial | Host plugin storage saves names/colors for fresh memory samples. TCP targets, files, groups, encrypted connection transfer and import are absent. |
| 3. Persistent secure credentials | Missing | No password persistence in the main adapter. Old synthetic secret tests are historical. |
| 4. SSH tunnels, proxies and reconnect | Missing | Existing host metadata/port/loopback probes in the old snapshot were not a general tunnel. No production tunnel in this port. |
| 5. Table/view/column browser | Partial | Actual SQLite introspection, search and read-only structure. No multi-database/schema navigation. |
| 6. Indexes/FKs/triggers/routines/source browsing | Partial | Bounded SQLite definitions, ordered composite PK, indexes, grouped foreign keys and triggers are implemented and engine-tested. Remote routines and full vendor-specific structure remain absent. |
| 7. Schema editing and reviewed DDL | Partial | Structured, one-shot reviewed CREATE TABLE for disposable SQLite, schema-version guards and rollback budgets; full Netcatty alpha.13 create/structure/INSERT/readback tested. Reviewed ordinary CREATE INDEX also works in alpha.14, with UNIQUE rollback and real native metadata inspection. No ALTER, index deletion, constraint editing, persistence or remote DDL. See `create-table.md` and `create-index.md`. |
| 8. SQL editing/highlight/tabs | Partial | Bounded syntax overlay, line numbers and up to eight tabs. No CodeMirror-equivalent editing/selection behavior. |
| 9. Completion, formatting and diagnostics | Missing | No schema-aware completion or formatter/diagnostic engine. |
| 10. Selection/scripts/manual transactions | Missing | One read or reviewed simple DML statement only; no batch, script execution or manual transaction controls. |
| 11. Query history and saved SQL/snippets | Partial | Bounded in-view history and named SQL library. No persisted SQL library or richer snippets yet. |
| 12. Restored editor tabs/drafts | Partial | Explicit bounded save/restore/clear by saved connection, native confirmation and stale-operation protection. Full-app synthetic lifecycle tested; restart/multi-connection native acceptance remains. See `workspace-drafts.md`. |
| 13. Result browsing/search/sort/paging | Partial | Bounded returned-result paging, filtering, sorting and cell inspection. No server-side paging or virtual scrolling. |
| 14. Grid insert/edit/delete with SQL preview | Missing | Reviewed simple SQL INSERT/UPDATE/DELETE now work on disposable memory; direct grid mutation controls are still absent. |
| 15. CSV/JSON/Markdown/XLSX/INSERT export | Partial | CSV/JSON/Markdown/SQLite INSERT export of returned rows only, bounded preview and explicit clipboard action (4096 UTF-8 bytes). Upstream truncation is disclosed. No XLSX, disk or full-table export. Full-App alpha.9 previews and explicit copying tested for all four formats, including SQL explicit-target protection; native cancellation/limits remain deterministic-only. Native confirmation depends on host permission mode. See `result-export.md`. |
| 16. CSV/Excel import | Missing | No importer. |
| 17. Data transfer and data comparison | Missing | No cross-connection engine or reviewed synchronization. |
| 18. Database dumps/backups/scheduling | Missing | No dump drivers, persistent scheduler or background service. |
| 19. ER/schema diff/plans/lineage | Missing | No metadata/query-plan coverage or visualization yet. |
| 20. AI generate/explain/optimize/fix | Partial | Existing host-selected model path, bounded unexecuted drafts, explicit insertion and cancellation. Real provider acceptance remains unperformed. |
| 21. Redis and MongoDB specialist browsers | Missing | Redis TLS AUTH/PING, bounded read-only browser and main UI route are implemented with injected-transport tests. Packaged endpoints remain empty; only native unconfigured gate is qualified, not a usable real-service connection. MongoDB and write CRUD remain absent. See `redis-ui-validation.md`. |
| 22. Message queues and middleware | Missing | Kafka/RocketMQ/RabbitMQ/Pulsar/MQTT and service-discovery consoles absent. |
| 23. MCP/CLI/headless Web/Docker delivery | Missing | No plugin-owned external MCP/CLI service. Independent DBX application delivery modes differ from an ordinary Netcatty browser plugin. |
| 24. Language/theme/accessibility/layout | Partial | Existing English/Chinese labels, inherited allowed theme tokens and responsive layout. Spanish, full keyboard/IME/accessibility and cross-platform native acceptance remain. |

DBX source anchors: [advertised features](https://github.com/t8y2/dbx/blob/b6c3d4780448c6f42c9a6aef2f187937d0660369/README.zh-CN.md#L269),
[editor](https://github.com/t8y2/dbx/tree/b6c3d4780448c6f42c9a6aef2f187937d0660369/apps/desktop/src/components/editor),
[backend commands](https://github.com/t8y2/dbx/tree/b6c3d4780448c6f42c9a6aef2f187937d0660369/src-tauri/src/commands),
[database Docker recipes](https://github.com/t8y2/dbx/tree/b6c3d4780448c6f42c9a6aef2f187937d0660369/deploy/database).
Current plugin anchors: `src/sqliteClient.ts`, `src/useWorkbench.ts`,
`src/index.tsx`, `src/SqlEditor.tsx`, `src/domain.ts`, `src/preview.ts`.

## Work order and host requests

1. Establish main-compatible SDK, package admission and real native sample behavior.
   No database-specific RPC is reintroduced. This is the present draft PR.
2. Add plugin-owned history/saved SQL/result paging/cell inspection and exports
   using generic storage/clipboard/file capabilities. Validate through main remote DOM.
3. Port network drivers through `context.network.connect`, with prepared/bound
   operations, strict protocol parsers, authentication/cancellation and exact endpoint
   package declarations. Start with PostgreSQL/MySQL/MariaDB and Redis; then expand
   only with actual fixtures and dialect evidence.
4. Add metadata coverage and reviewed write/DDL paths before edit/ER/diff/import,
   transfer or backup claims. A SELECT-only permission label is not server read-only enforcement.
5. Qualify each supported engine and major behavior using Docker fixtures plus
   installed-plugin UI smoke, screenshot/video artifacts and failure/recovery lanes.
   Provider calls, native dialogs and cross-platform qualification remain separate.

Concrete main limitations to report before any other-repository changes:

- `network.stream` endpoints must be exactly declared in the installed package.
  Arbitrary new connection destinations need package regeneration or a reviewed
  generic host flow for user-selected exact endpoints; wildcard access is not an
  acceptable substitute. Loopback and the app machine's own interface addresses
  are blocked by main's transport. Use a separate fixture container/machine.
- main offers initial TCP or TLS, not in-place STARTTLS. PostgreSQL's traditional
  SSLRequest upgrade and MySQL's post-greeting SSLRequest need a generic transport
  upgrade facility or a compatible verified direct-TLS endpoint. Do not weaken
  existing host endpoint/TLS policy to claim support.
- The browser runtime forbids workers and dynamic code evaluation/WebAssembly
  compilation under its current CSP. asm.js provides genuine bounded-memory SQLite,
  but cannot enforce a CPU deadline or interrupt a synchronous query. Broader user
  file/SQL workloads need a reviewed generic isolated worker/execution capability.
- Ordinary browser plugins cannot start native companions. Native/JDBC vendor
  drivers require a separately designed advanced utility integration and explicit
  permission, packaging and platform qualification. Adding names/icons is insufficient.
- main supports native contributed modal views, now verified through its own +/quick switcher. Its SDK has no cross-view open/close-modal controller, so plugin home/toolbar buttons retain an inline fallback. Native view closure uses the host X. No private host IPC or iframe is used.

## Acceptance ledger

| Lane | Result so far | Scope |
| --- | --- | --- |
| Original plugin checks | Passed: 29 tests, lint, pack, validate | Old SDK only |
| Original package vs main CLI | Rejected as expected | Real main validator; invalid database permission declarations |
| Migrated checks | Passed: 34 tests and lint/build locally | Includes actual SQLite joins/binds, read-only escapes, row/native allocation budgets, saved-connection serialization, disposal races |
| Main PackageStore/PluginManager install | Passed locally on main 4a55492 | Actual installed immutable package, disabled admission check, disposable profile; no native settings UI claim |
| Native installed-plugin main-component UI | Passed basic sample flow locally | Actual main service/renderer components and sandboxed plugin: create/test/save, schema, bound reads, NULL/empty, rejection/recovery, close/reopen; 10 screenshots and a timestamped recording. Fixture permission decisions; not full-app Settings/native permission/provider or cross-platform acceptance |
| Docker multi-database | Blocked locally; remote CI lane pending | Official Docker tools downloaded. Official rootless prerequisite check rejects missing newuidmap/newgidmap, iptables/nf_tables; no cgroup mount or configured remote daemon. No Docker database test has run. |
| Live AI provider | Not run | No configured model verified |
| Cross-platform CI/native | Pending CI; native acceptance pending | Three-platform build/unit workflow added; CI cannot replace native GUI evidence |

This task's requested termination condition has **not** been met. New full-app recordings now cover the complete Netcatty shell, native modal and native host metadata picker, plus real disposable SQLite queries. They do not cover a real AI model, Docker SSH host, or any TCP database. See `full-app-validation.md`.

The next tasks
must remain open until functionality and evidence actually close these gaps.

## Follow-up: result navigation, query library and AI (2026-11-07)

- Added bounded returned-result row/column paging, numeric/stable client sorting, all-column filtering and cell inspection. These navigate the returned 100-row/64-column budget, not server-side pagination or a complete DBX grid.
- Added an in-view query history (successful and failed dispatched queries) and named SQL library; bounded 30 entries each, reload fills the editor without executing. No disk persistence of SQL/parameters has been enabled.
- Sidebar connection status is a green capsule only for an actual open session; disconnected/error states remain distinct. Removed repeated “SQLite memory only / Read-only memory” sidebar copy; connection form still discloses read-only disposable data.
- AI gained bounded follow-up context, reset, and SQL code-block extraction. See `ai-parity.md`; live provider remains unverified.
- Local main SDK/SQLite UI regression now exercises 25 rows / 9 columns, paging, filtering, cell inspection, save/reload, and AI unavailable behavior. Native controlled-Xfce recording covers connection, query and history. This is not Docker multi-database or full application qualification.
- Overall parity remains far from completion; these turn history into a partial capability, not a complete reproduction. No merge or release.

## Full-app iteration

64 tests, lint, main install and SDK/SQLite UI regression pass locally. Full application alpha.4 was imported through native Settings and exercised on unchanged main. Native modal and host metadata picker are real host UI; no saved hosts exist in the isolated profile. See full-app-validation.md for evidence boundaries. Docker execution remains blocked as detailed in local-docker-acceptance.md. No near-parity completion, merge or release is claimed.
