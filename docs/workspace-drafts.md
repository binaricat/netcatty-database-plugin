# Explicit workspace drafts

Alpha.10 stores editor drafts only after **Save workspace drafts** in Query library. SQL and parameters can contain private information; this is disclosed before the button. No auto-save or automatic reconnect/execute. Saved connection IDs partition storage. Runtime handles, result rows, credentials fields and pending writes are excluded (SQL text itself is not redacted).

Bounds: version 1; eight tabs; SQL/parameters each 8192 characters; total serialized UTF-8 96 KiB. Invalid documents fail atomically. Restore and clear require a host quick-pick confirmation. Restore replaces editor tabs, clears results and pending write approval, resumes stable IDs, and converts missing objects to ordinary SQL with notice. Edits, execution, refresh or connection changes invalidate a waiting restore, including a query that finishes before confirmation returns.

## Validation

- 103 tests passed with RESP2 codec tests included; lint and actual main package installation check passed.
- Main remote-DOM regression: 11 scenarios, 126 batches, max 771 nodes. Storage and quick-pick transport are injected; this is not native confirmation evidence.
- Full unmodified Netcatty main `4a55492c17c3c792fbda4afc08d993f4165ca930`, actual installed alpha.10 package SHA256 `36e87a3f9e86d967c40e61fd653ee3e5c6550836ce67e3477dfe72fc134b7f7e`: saved initial synthetic SQLite SQL/parameters; added an unsaved query tab; cancelled native restore; confirmed restore through real host dialog; returned to one original tab with no result and `Nothing executed`; confirmed clear through real host dialog.
- Independent full-app screenshots: `draft-saved-final.jpg`, `draft-confirm-final.jpg`, `draft-restored-notice.jpg`, `draft-restored-editor.jpg`, `draft-cleared-final.jpg`, under `database-parity-evidence/full-main-round1`. No new draft-specific video was recorded for this checkpoint.

Restart persistence, cross-connection native isolation, native storage rejection and race cases are not separately qualified in the full app. This is partial DBX parity and does not change the incomplete Docker/SSH/real-server acceptance status.
