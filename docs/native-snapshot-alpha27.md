# Native local snapshot acceptance: alpha.27

Tested 2026-11-07 in unchanged Netcatty main
`4a55492c17c3c792fbda4afc08d993f4165ca930`, actual installed package SHA-256
`d7a6739979a0f56a44e7fe88c74a528095900101ce5207d14ecb1676b014ff7a`.

## Observed flow

- Inserted `Snapshot survives restart` into sample customers with Auto key.
- Explicitly saved the entire database after reading the unencrypted-storage
  notice. Saved size 16,384 bytes, timestamp 2026-11-07T19:52:17.907Z and hash
  `8cbb47ee3147d5023b58d277d0f221dc4310cdd0ef1f2185263ca39ec997361a`.
- Closed and reopened the saved connection, previewed the stored snapshot and
  its objects, explicitly confirmed replacing the in-memory database.
- Re-ran SELECT: Ada, the original Unicode name and the new id 3 row survived.
- Closing the window initially hid it to tray, so this was **not** counted as a
  restart. Stopped the original app process through its owning terminal, observed
  process/window exit and shell prompt, then restarted the same profile through
  run-logged.sh. New log: native-20261107T195511Z.log.
- Reopened Database and the saved connection; snapshot metadata/hash persisted.
  Previewed, confirmed restore and explicitly queried again: same three rows.

Evidence directory: `database-parity-evidence/full-main-round1/`:
`snapshot-saved-alpha27.jpg`, `snapshot-restore-preview-alpha27.jpg`,
`snapshot-readback-alpha27.jpg`, `snapshot-after-app-restart-alpha27.jpg`,
`snapshot-restart-readback-alpha27.jpg`.

## Boundaries

This is explicit plugin-owned SQLite whole-database storage, not arbitrary file
open/sync, encrypted credential storage, WAL backup, automatic session restore,
remote database persistence, or Docker testing. The saved snapshot is retained.
Destructive clear was not tested natively in this pass. Negative/corrupt/concurrent
cases remain automated engine/storage tests. Restart did not stop SSH/database
server processes. UI query results must be explicitly refreshed after restore.

Continuous recording `full-app-snapshot-alpha27.mp4`: 480 seconds, 5,118,193 bytes;
ffprobe and full decode passed. The final segment also records the independent
real MySQL prepared-read and PostgreSQL-index protocol PASS results through
Netcatty SSH. The restart sequence deliberately includes the unsuccessful
window-close-only attempt before the actual process restart. No cuts conceal it.
