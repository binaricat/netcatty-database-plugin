# Qualification and next gates

This is an experimental Linux development acceptance slice. Test execution and
exact commits/artifacts are recorded in `/workspace/netcatty-database-worklog.md`
and the implementation report, with real Electron evidence under
`/workspace/netcatty-smoke-shots/database-plugin-m0/`.

| Area | Current slice | Next production gate |
| --- | --- | --- |
| Build/package | Locked npm, vendored source SDK/CLI, validator, reproducible `.ncpkg` | CI on isolated Linux/macOS/Windows, SBOM and provenance attestation |
| SQLite | Memory + fixed M2/M3b files; Gate C held-fd identity; Gate E opt-in stable WAL committed-data snapshots with held sidecars and native snapshot inode audit | Concurrent writer/reader, checkpoint/recovery, broader admission, malformed DB corpus and cross-platform locks |
| Authority | Source/runtime-bound handles; default Ask; per-write exact native review | Broader target revision/plan receipts; lock/policy/source-swap stress and crash recovery |
| Execution limits | Fixed subprocess; 3 s kill; row/string/payload limits | Hard native-memory/CPU OS constraints and cross-platform kill/reap qualification |
| SQL semantics | SQLite authorizer allowlist, no scripts/PRAGMA/ATTACH/extensions | Driver-aware typed plans, cross-schema policy and nontransactional outcomes |
| Result UI | Bounded host DOM table, NULL and blob markers | Virtual paging, column precision/types, accessibility/IME, large-result benchmarks |
| AI | Gate D: optional host AI RPC, schema-only untrusted envelope, four tasks, bounded unexecuted stream, explicit insert, Stop/lifecycle cleanup; en/zh-CN React and deterministic host tests | Real-provider synthetic acceptance SKIPPED_NO_PROVIDER; native installed-plugin/provider dialogs, model output quality, usage UI and draft/diff editor |
| Themes/assets | Six sanitized SVG variants and source/hash ledger | Visual light/dark/high-contrast on all platforms and trademark/release review |
| PostgreSQL/MySQL | Honest unavailable cards; no driver claim | Host-owned TLS/secret/tunnel selection, fixtures, cancel/transaction tests |
| Product parity | Home, saved connections, modal, real table/view tree with search, readonly Structure, query/table tabs and results | Native full-host GUI gate, saved queries/history, broader schema browser, data editing, ER, transfer/import/export/backup/admin |

Tests must never use a user's databases or credentials. Each driver starts with
owned disposable synthetic fixtures. Report skipped/unavailable lanes explicitly.
M3 compares shell organization against the approved DBX screenshot ADR. No live AI
provider or full DBX feature parity is claimed. M3 evidence and exact test counts
are in `/workspace/agent-tools/database/astra-m3-fidelity-report.md`. Browser
screenshots render tested React snapshots; they are not native Electron GUI smoke.

M3b lifts the notes-only residual only for its fixed disposable directory. Real
host service/worker calls are exercised through headless React with injected
chooser/permission decisions; packaged worker checks run Electron in Node mode.
Six light/dark staged PNGs show commerce Structure/Data/bound query. None qualify
native full-host packaged-plugin/dialog/keychain/zh-CN IME acceptance. See
`/workspace/agent-tools/database/astra-m3b-multitable-report.md`.

M5 localizes current plugin controls with an original English/zh-CN map and the
existing host environment signal; no host or security-policy change is required.
English and Chinese React regressions include language changes without losing
session/tab/query state. Manifest permission reasons remain bilingual (plain
string contract); raw host diagnostics, user data and SQL identifiers are not
translated. Native evidence and exact test counts are recorded separately in
`/workspace/agent-tools/database/astra-m5-plugin-zh-report.md`. This does not claim
full product localization, OS IME candidate UI or production/DBX pixel parity.

Gate D replaces the mock-only panel with the host AI path; it adds no database
feature flag, provider transport, autonomous tools or execution path. Both AI
feature and permission are optional, so hosts without negotiated AI, configured models or permission show
an honest unavailable state. Pre-Gate D validators reject optional AI manifests;
the paired host update is required. Drafts require separate insertion and explicit editor Run /
Review write. Row samples are not supported. No provider configuration or secret
objects are passed to the plugin. The gate's real-provider lane is
`SKIPPED_NO_PROVIDER` and its status is `PASS_WITH_RESIDUALS`; deterministic streams
are not real-model evidence. Evidence, design, exact test counts and package hash:
`/workspace/agent-tools/database/gate-d-live-ai/`.

Gate E adds optional `database.sqlite-wal-readonly.fixture.v1` under the existing
default-off Linux file experiment. Only the same fixed evidence fixture roots are
admitted. This reads committed WAL frames into a verified read-only derived
snapshot; it is not a live-refresh connection. Source main/WAL/optional SHM fds
stay held and are revalidated around operations; replacement or content changes
invalidate the session. Source SHM is fingerprinted but never mapped or written.
The derived rollback image receives Gate C's separate native inode audit. English
and zh-CN notices state the snapshot scope; hosts without the flag retain strict
WAL rejection. Saved WAL targets bind sidecar hashes; legacy rollback saves remain
compatible. Public wire/SDK shapes and Gate D's unexecuted AI path are unchanged.

Only complete checksum-valid WAL streams ending in a commit are accepted. No tail
salvage, checkpoint, crash recovery, concurrent writer coordination, custom VFS,
SQLCipher or arbitrary user paths are qualified. Multi-file capture is not atomic;
C's fully restored in-place content/timestamp and native-reopen residuals persist.
A host crash may leave an owned mode-0600 derived fixture, and bounded synchronous
snapshot work precedes the subprocess deadline. M1 resource/parent-death and
native GUI/platform limitations remain. Evidence, design, exact test counts and
package hash: `/workspace/agent-tools/database/gate-e-wal-live-reader/`.
