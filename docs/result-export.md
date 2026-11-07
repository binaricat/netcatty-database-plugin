# Returned-result export boundaries (alpha.9)

CSV, JSON, Markdown and SQLite-oriented INSERT text cover rows already returned to the plugin. This is partial DBX parity: no XLSX, disk destination or full-table export.

- Only an explicit copy click calls `context.clipboard.writeText`; rendering/opening does not access it.
- The complete export must fit 4096 UTF-8 bytes. Oversized content disables copy, never copies only the visible fragment.
- Preview pages are at most 4000 UTF-16 units without splitting surrogate pairs and are labelled fragments.
- Upstream truncation, BLOB placeholder limitations, CSV NULL/type caveats and formula apostrophe protection remain disclosed. JSON preserves scalar types.
- Preview-only NUL substitution shows `\0`; original content is unchanged, copy is disabled and JSON recommended.
- SQL requires an explicit destination name and never executes. No result data is logged or persisted by the component.

## Clipboard permissions

`electron/plugins/hostInteractionService.cjs:267–278` handles allow-mode clipboard operations directly without a preview modal. Ask mode may show native confirmation; deny mode rejects. Success therefore says **Export copied.**, not that confirmation occurred. False/cancel and errors remain separate retryable states. No permission setting was changed by this correction.

## Evidence limits

Alpha.8 checkpoint: 84 unit tests; remote-DOM regression 95 mutation batches/9 snapshots. These historical measurements require rerunning after changes. Deterministic clipboard tests validate exact CSV/JSON/INSERT content, no automatic copying, cancellation/error recovery and explicit SQL destination, not native permission dialogs.

Full-App alpha.8 CSV copying returned true without a native modal, consistent with allow mode. Full-App JSON preview switching also passed without missing nodes. SQL INSERT rejected an empty destination with no copy button, then generated a non-executing preview after explicit `notes_copy` entry. Full-App copying is verified only for CSV; JSON/SQL clipboard copying, Markdown and native ask/deny/oversized/NUL cases remain pending. Alpha.9 wording/package needs separate reinstall and native smoke verification; passing unit/build checks alone is not full native acceptance.


## Alpha.9 full-app checkpoint

Installed package SHA256 `cadd8f61e32ecc0252e5d10e3d96084f689744757a23e6e3e25b29f4ef2d62f2` in unmodified main `4a55492c17c3c792fbda4afc08d993f4165ca930`. Queried real plugin-owned disposable SQLite, switched through all four formats and explicitly copied each, observing `Export copied.` from the actual host. SQL empty-target rejection and non-executing INSERT generation passed. This is not a Docker, SSH or external-server test. Native ask/deny, oversize and NUL UI cases remain deterministic-only.

Independent screenshots in `database-parity-evidence/full-main-round1/`: `export-csv-final.jpg`, `export-json-final.jpg`, `export-markdown-final.jpg`, `export-sql-required.jpg`, `export-sql-final.jpg`. The editor height control was adjusted to show both results and export. The initial alpha.7 clipped button was corrected before this run.

`full-app-export-final.mp4` is the 120-second, 1364×1024 real-app recording for this run (not a component harness). The extracted 115-second frame confirms the final SQL preview and copied status are included. This is bounded SQLite-only export acceptance, not overall DBX parity.
