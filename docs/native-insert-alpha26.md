# Native single-row INSERT acceptance: alpha.26

The unchanged Netcatty main host `4a55492c17c3c792fbda4afc08d993f4165ca930`
imported and enabled the actual plugin package on 2026-11-07. Package SHA-256:
`097581d7e2c52d0131d82c77cc1a389f4cc4c6bb6edde87047c21949ac64442a`.

## Observed native flow

1. Opened the saved disposable SQLite sample and `customers` table.
2. Opened Insert row; retained the verified INTEGER rowid Auto key and entered
   `Native INSERT, reviewed` as a Text value.
3. Reviewed highlighted bound INSERT SQL, exact bound value, and automatic `id`.
4. Confirmed once; the UI reported one inserted row and cleared stale results.
5. Closed the form, opened Data and explicitly ran the table query: original Ada
   and Unicode name rows remained, new row had generated `id = 3`.
6. Tried explicit `id = 1` with `Duplicate should roll back`: preview was allowed,
   confirmation was rejected by the engine and the UI reported rollback.
7. Cancelled the failed form and explicitly re-ran the query: exactly the previous
   three rows remained, original `id = 1` was unchanged, and no duplicate survived.

Independent screenshots under `database-parity-evidence/full-main-round1/`:
`insert-form-alpha26.jpg`, `insert-review-alpha26.jpg`,
`insert-success-alpha26.jpg`, `insert-readback-alpha26.jpg`,
`insert-duplicate-rollback-alpha26.jpg`,
`insert-duplicate-readback-alpha26.jpg`.

Continuous native recording `full-app-insert-alpha26.mp4`: 240 seconds,
1,394,074 bytes. ffprobe and full decode passed; the 220-second frame was visually
checked and shows the final three-row readback after duplicate rollback.

## Scope

This is the installed main plugin using real SQL.js engine operations, not a
component fixture, Docker server, persistent SQLite file or remote database.
The native run covers Auto, explicit text/integer values, highlighted review,
confirmation, readback and duplicate-key rollback. NULL/default modes, deferred
foreign-key rollback, malformed metadata, size budgets and racing actions have
engine/controller/remote-DOM tests, but are not claimed native acceptance here.
Snapshots and other changes developed after alpha.26 are not in this artifact.
