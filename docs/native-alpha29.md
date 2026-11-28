# Native alpha29 acceptance (2026-11-07)

Unchanged Netcatty main 4a55492c17c3c792fbda4afc08d993f4165ca930; package SHA256 84b5ba980829cdd1b49dc375f0f31b53fe3a0bd2c288dcc3db5a7a4148db69c4.

Observed in the actual application, using the explicitly synthetic plugin-owned SQLite database:
- Whole-SQL format preview, apply, exact undo, reapply and explicit SELECT readback.
- Named SQL saved through plugin storage. Actual process-restart recovery remains pending, not claimed here.
- Relationships show the actual orders.customer_id → customers.id FK. No inferred links, graphical ER editor, or cardinality claimed.
- Selected notes IDs 1 and 2, reviewed both bound DELETE statements/old values, confirmed once, and explicitly reran SELECT: only ID 3 remained. This is an atomic bounded batch, not a general transaction editor.

Evidence root: `/workspace/scratch/7197fc4a62d0/database-parity-evidence/full-main-round1/`.
Images: format-preview-alpha29.jpg, format-undo-alpha29.jpg, format-readback-alpha29.jpg, query-saved-alpha29.jpg, relationships-alpha29.jpg, batch-sql-alpha29.jpg, batch-commit-alpha29.jpg, batch-readback-alpha29.jpg.
Recording: full-app-library-alpha29.mp4, 470.8 seconds, 3,142,482 bytes; complete decode passed. Frame at 400 seconds verifies the final one-row readback. X11 grab emitted an error toward the end; recording was interrupted cleanly and finalized. No claim that it covers restart recovery.

Found during acceptance: table Data editor collapsed to about one text line after formatting controls were added; batch review lacked the existing single-row SQL highlighter and compact layout. Follow-up corrections are in development. These screenshots are functional evidence, not final design acceptance.

No native external-database connection, Docker testing, or real AI-provider execution is established by this acceptance.

## Completed follow-up
Actual original Netcatty process terminated with Ctrl-C (window disappeared), restarted with the same logged launcher/profile, and saved SQL remained. Loading showed `Nothing executed`, then explicit Run read back both customers. Images: query-after-restart-alpha29.jpg, query-loaded-no-execution-alpha29.jpg, query-restart-readback-alpha29.jpg.

The follow-up recording full-app-query-restart-alpha29.mp4 (300 seconds, 3,400,114 bytes, full decode passed) continues through installing alpha30 and repeating highlighted batch review, atomic confirmation and one-row readback. Frame285 seconds verifies final result. Recorder emitted a startup X11 error but subsequently captured the entire observed sequence; no error suppressed.

Alpha30 package SHA256 7ccc187fe12b6ef3324c9e019d882101b7f850df168f1a7b24d7b9ce992a5546. Native images table-editor-alpha30.jpg, batch-sql-alpha30.jpg, batch-readback-alpha30.jpg verify restored editor height and readable shared highlighted SQL with separate complete bound-value rows. Selection controls could still be more compact; design is not treated as final.
