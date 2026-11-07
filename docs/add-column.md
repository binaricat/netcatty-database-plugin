# Reviewed SQLite ADD COLUMN

A bounded partial schema-editor capability for disposable memory SQLite only.

- One nullable scalar column, no default, PK, UNIQUE, REFERENCES, CHECK, generated expression or multi-action DDL.
- Names are quoted; reserved sqlite_ names and NUL are refused; existing names use SQLite ASCII case folding.
- Authoritative table_list/table_xinfo checks reject views, virtual/shadow/STRICT/generated layouts and trigger-bearing tables.
- Exact handle, schema revision, draft and SQL are bound to a one-shot review. Editing invalidates UI review. Confirmation rechecks the database.
- Savepoint rollback, 1 MiB database and schema metadata budgets, query_only restoration (or closing an unsafe session) apply.
- Success updates structure and invalidates prior query results. Existing rows contain NULL for the added column.
- An independent capability gate prevents assuming ADD support from CREATE TABLE support.

Tests: actual SQL.js ALTER and rollback, forged/stale/replayed reviews, old-row NULL readback, rejected layouts, controller edit/cancel/disposal/confirm races and remoteDOM form flow. Native alpha.23 acceptance passed: customers.nickname TEXT preview, confirmation and SELECT readback preserved both original rows with NULL in the new column. Evidence: add-column-review-alpha23.jpg, add-column-success-alpha23.jpg, add-column-readback-alpha23.jpg. this is not a full DBX designer or remote/persistent DDL.
