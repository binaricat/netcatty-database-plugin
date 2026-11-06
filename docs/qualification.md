# Qualification and next gates

This is an experimental Linux development acceptance slice. Test execution and
exact commits/artifacts are recorded in `/workspace/netcatty-database-worklog.md`
and the implementation report, with real Electron evidence under
`/workspace/netcatty-smoke-shots/database-plugin-m0/`.

| Area | Current slice | Next production gate |
| --- | --- | --- |
| Build/package | Locked npm, vendored source SDK/CLI, validator, reproducible `.ncpkg` | CI on isolated Linux/macOS/Windows, SBOM and provenance attestation |
| SQLite | Real in-memory synthetic notes; parameterized reads and reviewed DML | Host chooser, persistent read-only file identity, WAL/SHM/locks, malformed DB corpus |
| Authority | Source/runtime-bound handles; default Ask; per-write exact native review | Broader target revision/plan receipts; lock/policy/source-swap stress and crash recovery |
| Execution limits | Fixed subprocess; 3 s kill; row/string/payload limits | Hard native-memory/CPU OS constraints and cross-platform kill/reap qualification |
| SQL semantics | SQLite authorizer allowlist, no scripts/PRAGMA/ATTACH/extensions | Driver-aware typed plans, cross-schema policy and nontransactional outcomes |
| Result UI | Bounded host DOM table, NULL and blob markers | Virtual paging, column precision/types, accessibility/IME, large-result benchmarks |
| AI | Grounded bounded prompt builder; streaming/stop/stale/budget tests with mocks | Real-provider approved synthetic acceptance, usage UI, diagnostics and draft/diff editor |
| Themes/assets | Six sanitized SVG variants and source/hash ledger | Visual light/dark/high-contrast on all platforms and trademark/release review |
| PostgreSQL/MySQL | Honest unavailable cards; no driver claim | Host-owned TLS/secret/tunnel selection, fixtures, cancel/transaction tests |
| Product parity | One connection/schema/editor/results/AI-draft page | Saved queries/history, multi-tab editing, metadata browser, data editing, ER, transfer/import/export/backup/admin |

Tests must never use a user's databases or credentials. Each driver starts with
owned disposable synthetic fixtures. Report skipped/unavailable lanes explicitly.
No live AI provider call or DBX comparison is claimed by this milestone.
