# Native alpha33 projection view acceptance

Actual unchanged Netcatty main `4a55492c17c3c792fbda4afc08d993f4165ca930`,
plugin `cd5289e`, package SHA256
`fe91b595c1d0f24bd0237d736ff831cc4fda094c50385e6c5e33230f5cf292d0`.
Native Settings import/enable followed by saved Synthetic SQLite connection.
This is plugin-owned disposable SQLite, not a remote database or Docker lane.

Verified in the full application:
1. New object / View opens the structured form without an additional sidebar block.
2. Name notes_projection, select source notes and only id/title columns.
3. Preview shows highlighted exact CREATE VIEW; sidebar still has one view.
4. Explicit confirmation refreshes schema to two views, with no automatic data query.
5. Open notes_projection, inspect two-column structure, switch Data, manually run
   SELECT * FROM main.notes_projection. All three original IDs/titles are returned.

Separate screenshots in
`/workspace/scratch/7197fc4a62d0/database-parity-evidence/full-main-round1/`:
- create-view-preview-alpha33.jpg
- create-view-committed-alpha33.jpg
- create-view-readback-alpha33.jpg

Continuous video `full-app-create-view-alpha33.mp4` is being finalized; do not
claim complete/decodable until the result is appended below.

586 tests, lint/package validation, actual main PackageStore install and 50 injected
main remote-DOM snapshots pass. Deferred busy-owner races are tested using
controlled promises, not claimed as manually timed native races. No general
view SQL editor, joins/expressions/filter projection, remote plugin connectivity,
near-complete DBX parity, merge or release is claimed.
