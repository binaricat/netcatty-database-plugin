# Qualification and next gates

This is an experimental Linux development acceptance slice. Test execution and
exact commits/artifacts are recorded in `/workspace/netcatty-database-worklog.md`
and the implementation report, with real Electron evidence under
`/workspace/netcatty-smoke-shots/database-plugin-m0/`.

| Area | Current slice | Next production gate |
| --- | --- | --- |
| Build/package | Locked npm, vendored source SDK/CLI, validator, reproducible `.ncpkg` | CI on isolated Linux/macOS/Windows, SBOM and provenance attestation |
| SQLite | Memory + fixed M2/M3b files; C held-fd identity; E verified WAL snapshots; F separate-process writer invalidation and explicit fresh selection after writing pauses | Continuous-writer capture/live refresh, checkpoint/recovery, broader admission, malformed DB corpus and cross-platform locks |
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


Gate F adds optional `database.sqlite-wal-concurrent.fixture.v1` as a host
qualification marker, advertised only with Gate E and the default-off Linux file
experiment. It does not enable WAL by itself or add a write/path RPC. Tests use
a separate-process synthetic writer inside M2: stable repeated snapshot reads,
commits while the session exists, invalidation at preflight/native-query/final
publication boundaries, and fresh chooser selection after writing pauses that
returns newly committed rows. Old handles are closed and cannot publish stale
rows after a detected change. No automatic refresh or in-session re-snapshot.
Changed saved targets still require reselection and saving again. en/zh-CN
notices state invalidation and reselection, not live concurrent WAL support.

Held source fds neither take WAL read locks nor coordinate writers. Tests prove
SQLITE_BUSY for a second writer during BEGIN IMMEDIATE and successful commit
after rollback. BEGIN itself can change SHM and invalidate a snapshot before a
commit. Hostile WAL/SHM replacement during a held write transaction still rejects;
C/E held-fd, hash, parser, race and cleanup guards remain; an admission timestamp
fence also fixes a same-tick restored-name ABA failure found in Electron.
PASSIVE/FULL/RESTART/TRUNCATE checkpoint attempts invalidate old handles; this is
rejection evidence only. A truncated WAL cannot be reopened through E. Checkpoint
availability/reader compatibility, crash recovery, continuous-writer acquisition,
live refresh and cross-platform lock behavior remain unqualified. Boundary
checks are not a background watcher; already displayed rows remain historical.
C/E non-atomic capture, fully restored content ABA/native-call and cleanup
residuals, M1 limits and D's SKIPPED_NO_PROVIDER remain. Exact tests and artifact:
`/workspace/agent-tools/database/gate-f-wal-concurrent/`.


The timestamp fence retains captured fingerprints, ages their newest ctime to
50 ms and revalidates before admission (maximum requested wait 100 ms; clock
anomalies reject). It performs no source writes. Original E rejection tests plus
36 immediate main/WAL/SHM restored-name ABA attempts pass on the fixed Linux
fixture filesystem. Coarse/foreign filesystems, clock rollback and privileged
metadata manipulation are not qualified. The bounded synchronous wait is outside
the worker deadline, preserving M1's event-loop/resource limitation.
