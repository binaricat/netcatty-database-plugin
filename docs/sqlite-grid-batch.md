# Bounded atomic row batches

DBX reference: `apps/desktop/src/composables/useDataGridEditor.ts` stages row/cell
changes for explicit save; this implementation is a smaller same-table batch.

The plugin-local API previews and applies 1–10 complete original rows using UPDATE
and/or DELETE. Each step reuses the single-row bound-parameter planner. Primary
keys cannot change; duplicate selected keys, NULL key components, incomplete rows
and unsupported values are rejected. Total parameters <=320, plan <=96 KiB.

Authoritative SQLite schema/xinfo/table-list inspection requires an ordinary rowid
table, no hidden/generated columns, triggers, ON CONFLICT policies or incoming/
outgoing foreign keys. The FK restriction is an implementation limit, not a host
restriction. Full old values use BINARY IS predicates, and each step must match
exactly one original row and change exactly one row. SQLite numeric equality still
regards equal INTEGER/REAL values as equal.

The adapter issues a random review token bound to handle, schema version and exact
plan; apply consumes it before validation/execution. Forged/changed/reused reviews,
closed/wrong handles, replacement previews and schema changes are rejected. The
executor re-plans against current schema and rechecks original rows. One savepoint
makes the batch atomic; any step failure, conflict or pre-commit cancellation rolls
all changes back. A 1 MiB database budget is checked before commit. Foreign-key,
query-only and trusted-schema protections are checked/restored; unrecoverable
cleanup closes the handle. Fresh SQLite connections now verify these protections.

The synchronous SQL.js API cannot interrupt a running statement. Cancellation is
checked only between operations. A signal after successful RELEASE does not claim
the already committed data was rolled back. The adapter currently exposes no UI
cancel signal during synchronous apply.

## Evidence boundaries

Real SQL.js tests exercise multi-step success, second-step uniqueness failure with
first-step rollback, exact original-row conflicts, composite keys, cancellation
boundaries, protection failures and token lifecycle. RELEASE-failure rollback is
fault injection. Because FK-associated targets are refused, this batch slice does
not claim real deferred-FK acceptance. It is not a full DBX pending-change editor,
server transaction management, native app qualification or remote database writes.
