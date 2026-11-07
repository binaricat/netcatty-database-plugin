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
