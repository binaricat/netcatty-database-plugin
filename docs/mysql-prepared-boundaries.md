# MySQL prepared bounded SELECT: offline protocol slice

`mysqlPreparedProtocol.ts` and `mysqlPreparedRead.ts` implement a restricted
prepared read on an exclusively owned, already authenticated and verified-TLS
connection. They do not open a connection, upgrade TLS or change main policies.
No other consumer, including `mysqlRead`, may concurrently use that stream;
this module's WeakSet guard only serializes its own API calls.

## Fixed transaction and parameter contract

`executeMysqlPreparedRead(connection, options)` snapshots a generated SELECT
plan before awaiting anything. Options contain quoted schema/table/projections,
1–8 NULL-safe equality predicates (`column <=> ?`), and LIMIT 1–100. Values are
explicit signed-int64 decimal strings, bounded UTF-8 text, or NULL. Neither
predicate data nor values become SQL source. No arbitrary SQL, operators,
expressions, long-data, cursor or re-execution entry point is offered.

Wire sequence: START TRANSACTION READ ONLY → COM_STMT_PREPARE →
COM_STMT_EXECUTE → COM_STMT_CLOSE (no response) → ROLLBACK. Each response-bearing
command restarts packet sequence at 1. Statement IDs come only from the validated
prepare response. Success requires both statement-close write completion and
idle rollback OK. A failure closes the connection instead of pretending that
statement cleanup or server-side query cancellation succeeded.

PREPARE parameter metadata may have empty schema/table/original names and a
placeholder name; it is structurally parsed, counted and restricted to known
wire types, not compared with projection names. Result metadata must match the
requested schema/table/original names, and EXECUTE metadata must match PREPARE.
Binary rows support exact signed/unsigned integer strings, bounded UTF-8 text
and NULL; unsupported types are rejected even for NULL cells. Their NULL bitmap
uses the protocol's two-bit offset, unlike EXECUTE parameter null bits.

## Bounds and status checks

At most 16 projected columns, 8 bound parameters, 100 returned rows, 96 KiB total
received bytes, 4096 reads and 1–10,000 ms whole-operation timeout. Packet-level
budgets also apply. Empty reads reject; monotonic checks prevent immediate
microtask streams from starving the timer. Cancel/timeout/failure clears owned
wire and decoded packet buffers and closes; JS strings cannot be guaranteed
zeroized. A failed connection cannot be reused by this module.

Transaction flags permit AUTOCOMMIT+IN_TRANS with optional IN_TRANS_READONLY.
Only EXECUTE result EOFs may additionally contain official query informational
bits 16/32. MORE_RESULTS and other unknown status bits remain rejected. All
warnings, malformed metadata, server errors, extra/coalesced trailing packets
and excess rows fail closed. Diagnostic output is fixed phase/status only, never
SQL, parameters or raw server error text.

READ ONLY does not sandbox UDFs/views/extensions. Use a trusted table and
least-privilege account. The caller remains responsible for verified TLS and
classic-EOF capability compatibility with `MysqlTlsFastAuth`.

## Evidence

Seven offline state-machine tests cover fragmented/coalesced protocol responses,
exact values, immutable input snapshots, parameter/result metadata, counts and
warnings, transaction status, budgets, cancellation, hung writes, concurrency,
statement-close failure and server-error redaction. Six pure codec tests cover
wire bytes, integer boundaries and NULL-bitmaps including cross-byte boundaries.
These remain synthetic protocol tests.

On 2026-11-07 the coordinator additionally ran `--prepared-read` through the
actual Netcatty SSH terminal against official MySQL 8.4.7 on the local test host.
Verified TLS 1.3 and fast caching_sha2 authentication preceded three real
prepared exchanges: bound int64/text/NULL returned the expected row; SQL-looking
text returned zero rows; the valid read repeated on the same connection.
Statement close, rollback and connection reuse passed. Screenshot:
`database-parity-evidence/full-main-round1/postgres-indexes-pass.jpg`.
This is independent Node transport executing plugin protocol modules, not native
main plugin connectivity. Cold full-auth and text-query evidence are separate.
