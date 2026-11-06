# Qualification and next gates

This is an experimental Linux development acceptance slice. Test execution and
exact commits/artifacts are recorded in `/workspace/netcatty-database-worklog.md`
and the implementation report, with real Electron evidence under
`/workspace/netcatty-smoke-shots/database-plugin-m0/`.

| Area | Current slice | Next production gate |
| --- | --- | --- |
| Build/package | Locked npm, vendored source SDK/CLI, validator, reproducible `.ncpkg` | CI on isolated Linux/macOS/Windows, SBOM and provenance attestation |
| SQLite | Synthetic memory + M2 notes files + fixed M3b commerce directory; saved target identity revalidated | Broader file admission, WAL/SHM/locks, malformed DB corpus |
| Authority | Source/runtime-bound handles; default Ask; per-write exact native review | Broader target revision/plan receipts; lock/policy/source-swap stress and crash recovery |
| Execution limits | Fixed subprocess; 3 s kill; row/string/payload limits | Hard native-memory/CPU OS constraints and cross-platform kill/reap qualification |
| SQL semantics | SQLite authorizer allowlist, no scripts/PRAGMA/ATTACH/extensions | Driver-aware typed plans, cross-schema policy and nontransactional outcomes |
| Result UI | Bounded host DOM table, NULL and blob markers | Virtual paging, column precision/types, accessibility/IME, large-result benchmarks |
| AI | Local mock-only draft UI; dormant streaming helpers tested with mocks | Real-provider approved synthetic acceptance, usage UI, diagnostics and draft/diff editor |
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
