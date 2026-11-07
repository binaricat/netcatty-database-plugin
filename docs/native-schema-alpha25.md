# Native schema-editing acceptance: alpha.25

Host main `4a55492c17c3c792fbda4afc08d993f4165ca930` was rechecked against GitHub main. Package SHA256 `e33e7ebf515151dcefb7e9d8edb95930bc3af5fb92eb79d468b2cab27de172ca` was imported, enabled and activated through actual Netcatty Settings/Database. No fixture renderer or host modification.

In a disposable SQLite session:
- Created `review_notes(id INTEGER NOT NULL PRIMARY KEY, title TEXT)` through reviewed structured DDL, then reviewed a bound INSERT of id 1 / `Preserved after rename`.
- Alter table → Rename column showed a wider new-name input and highlighted exact ALTER SQL. Confirmed `title` to `label`; subsequent SELECT returned the original id/value under the new column.
- Created ordinary `idx_review_label`. Previewed DROP and cancelled; SELECT from sqlite_master returned the index. Re-previewed and confirmed DROP; the same SELECT returned zero rows. Data SELECT still returned the intact row.
- Created explicit UNIQUE `unique_review_label`, then opened removal preview. The warning explicitly states uniqueness enforcement is removed and duplicates may be accepted, and confirmation names UNIQUE. Cancelled; no native UNIQUE deletion is claimed.

Evidence outside repository: `database-parity-evidence/full-main-round1/`.
`full-app-schema-alpha25.mp4` is an unedited 300-second real desktop recording (2,005,093 bytes); ffprobe and full decode pass. It covers rename through readback and the complete ordinary-index cancel/confirm/readback sequence; at 260 seconds index absence is visible, at 280 seconds the preserved row. It ends before the later UNIQUE warning inspection.

Independent screenshots: `rename-review-alpha25.jpg`, `rename-success-alpha25.jpg`, `rename-readback-alpha25.jpg`, `drop-index-review-alpha25.jpg`, `drop-index-cancel-readback-alpha25.jpg`, `drop-index-success-alpha25.jpg`, `drop-index-readback-alpha25.jpg`, `drop-index-row-preserved-alpha25.jpg`, `drop-unique-warning-alpha25.jpg`.

344 unit/controller/engine tests, lint, 29 main remote-DOM scenes (288 batches), actual main PackageStore install, build/package/validation pass. Remote-DOM is a separate injected-transport lane, not native evidence.

These operations use temporary in-memory SQLite, not PostgreSQL/Redis or a persistent file. Broad ALTER, constraints, arbitrary scripts and remote plugin connections remain unqualified. This is not DBX parity completion or a release.
