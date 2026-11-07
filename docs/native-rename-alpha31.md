# Native SQLite table rename, alpha31

Actual unchanged Netcatty main `4a55492c17c3c792fbda4afc08d993f4165ca930`, installed through native plugin import/enable. Package SHA256 `2452f74ea40bf7c3c1f462a224c3b3b96c7df3ee80cd200a20ff215e22a5a35a`.

On the explicitly synthetic plugin-owned SQLite fixture:
1. Alter table → Rename table, selected notes and entered notes_archived.
2. Reviewed highlighted exact `ALTER TABLE "main"."notes" RENAME TO "notes_archived";`.
3. Confirmed once, saw new sidebar name and success.
4. Opened new table Data, explicitly ran SELECT and verified all original three rows.
5. Tried customers→customers_rejected; dependency check refused preview, confirm stayed disabled, original name remained.

Images under `database-parity-evidence/full-main-round1/`: rename-table-preview-alpha31.jpg, rename-table-committed-alpha31.jpg, rename-table-readback-alpha31.jpg, rename-table-dependency-rejected-alpha31.jpg.
Recording full-app-rename-alpha31.mp4 finalized at 300 seconds / 2,464,141 bytes, passed complete decode; frame at 290 seconds confirms the final dependency refusal. Also includes a repeat real MySQL metadata harness PASS through actual Netcatty SSH; this is an independent Node protocol lane, not native plugin MySQL connection.

527 tests and 44 main remote-DOM scenes passed before package installation. No general dependency rewriting, table rebuild, file-backed SQLite durability, external DB DDL, or release/merge is claimed.
