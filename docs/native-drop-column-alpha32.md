# Native alpha32 DROP COLUMN acceptance

On 2026-11-07 the actual unchanged Netcatty main application
`4a55492c17c3c792fbda4afc08d993f4165ca930` imported alpha32 via native Settings.
Package SHA256: `7ed69e7c63ba2ee1e7888518356d0e3e599968c1f12bb9c7824b50d16b0ff69d`.
Plugin code: `1f12376`. This is plugin-owned disposable SQLite with synthetic data,
not a remote MySQL/PostgreSQL connection and not Docker.

Verified sequence:
1. Connect saved Synthetic SQLite and open Alter table / Drop column.
2. Select notes.status; preview shows exact highlighted ALTER TABLE SQL and explicit
   irreversible loss of that column's values across all three rows.
3. Explicit confirmation reports column removed and schema refreshed, without
   executing an additional user query.
4. Reopen notes: structure contains only id/title. Manually run SELECT * FROM
   main.notes and verify all three original IDs/titles remain, with two columns.

Evidence under `/workspace/scratch/7197fc4a62d0/database-parity-evidence/full-main-round1/`:
- `drop-column-preview-alpha32.jpg`
- `drop-column-committed-alpha32.jpg`
- `drop-column-readback-alpha32.jpg`
- `full-app-drop-column-alpha32.mp4`: 300 seconds, 1,910,732 bytes;
  full ffmpeg decode succeeds. Independently inspected frame at 295 seconds shows
  the three-row/two-column readback, so this recording includes the complete cycle.

Safety regressions for embedded-NUL/invalid-UTF8 preservation, literal sqlite_
name prefix and legacy rename mode shipped before this package was installed.
All 550 unit/integration tests pass; 47 injected main remote-DOM scenes passed
before package freeze. Negative dependency/constraint/refusal cases are engine
regressions, not newly claimed native interactions. Batch checkbox alignment has
not yet received its alpha32 native visual acceptance. No near-DBX-complete,
merge, release, encrypted storage, arbitrary file editing or remote plugin
connectivity claim is made.
