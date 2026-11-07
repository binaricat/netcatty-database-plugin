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

At this first migration slice: **0 of 24 capability groups complete; 7 partial;
17 missing**. This coarse count is not a percentage of engineering effort or a
weighted product completion score. It also does not establish that every DBX
advertised driver itself has been independently tested in DBX.

| Capability group | Status on main migration | Concrete gap / current evidence |
| --- | --- | --- |
| 1. Broad database connectivity | Partial | Real SQLite memory only. Catalog has 21 entries: 1 fixture, 3 wire labels, 9 protocol aliases and 8 catalog-only entries in the baseline; these labels are not working/qualified drivers. PostgreSQL/MySQL TCP from the old host is unavailable on main. |
| 2. Saved connections | Partial | Host plugin storage saves names/colors for fresh memory samples. TCP targets, files, groups, encrypted connection transfer and import are absent. |
| 3. Persistent secure credentials | Missing | No password persistence in the main adapter. Old synthetic secret tests are historical. |
| 4. SSH tunnels, proxies and reconnect | Missing | Existing host metadata/port/loopback probes in the old snapshot were not a general tunnel. No production tunnel in this port. |
| 5. Table/view/column browser | Partial | Actual SQLite introspection, search and read-only structure. No multi-database/schema navigation. |
| 6. Indexes/FKs/triggers/routines/source browsing | Missing | The exposed structure model contains columns, type, nullability and primary-key flags only. |
| 7. Schema editing and reviewed DDL | Missing | SQLite memory adapter is read-only. |
| 8. SQL editing/highlight/tabs | Partial | Bounded syntax overlay, line numbers and up to eight tabs. No CodeMirror-equivalent editing/selection behavior. |
| 9. Completion, formatting and diagnostics | Missing | No schema-aware completion or formatter/diagnostic engine. |
| 10. Selection/scripts/manual transactions | Missing | One read statement only; no batch, script execution or transaction controls. |
| 11. Query history and saved SQL/snippets | Missing | Current History entry remains disabled. |
| 12. Restored editor tabs/drafts | Missing | Query state lasts only for the mounted workspace/session. |
| 13. Result browsing/search/sort/paging | Partial | Bounded read results and small table preview. No complete paging/filter/sort/virtual scrolling or full cell view. |
| 14. Grid insert/edit/delete with SQL preview | Missing | No data mutations on main. |
| 15. CSV/JSON/Markdown/XLSX/INSERT export | Missing | No export controls or file destination flow. |
| 16. CSV/Excel import | Missing | No importer. |
| 17. Data transfer and data comparison | Missing | No cross-connection engine or reviewed synchronization. |
| 18. Database dumps/backups/scheduling | Missing | No dump drivers, persistent scheduler or background service. |
| 19. ER/schema diff/plans/lineage | Missing | No metadata/query-plan coverage or visualization yet. |
| 20. AI generate/explain/optimize/fix | Partial | Existing host-selected model path, bounded unexecuted drafts, explicit insertion and cancellation. Real provider acceptance remains unperformed. |
| 21. Redis and MongoDB specialist browsers | Missing | Catalog entries only; no protocols or CRUD. |
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
- main's React adapter has no cross-view `openModal` controller. This migration uses
  an inline dialog inside its own view. A true app-wide contributed modal requires
  a generic host UI API; no private host IPC or iframe should be added.

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

This task's requested termination condition has **not** been met. The native recording covers the main-component harness rather than the complete
Netcatty shell, native permission dialogs, a real model, or any TCP database.

The next tasks
must remain open until functionality and evidence actually close these gaps.
