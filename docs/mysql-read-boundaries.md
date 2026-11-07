# MySQL bounded read protocol slice

`mysqlRead.ts` accepts an **exclusively owned, already authenticated and strictly
verified TLS** `PluginByteConnection`, idle with the exact capabilities used by
`MysqlTlsFastAuth`. It does not establish or verify TLS itself. No socket, endpoint
permission, auth policy or UI was added.

## Generated command sequence

Three separate COM_QUERY exchanges, each request sequence 0 / response sequence 1:

1. `START TRANSACTION READ ONLY`, requiring a clean transaction OK.
2. A single generated `SELECT` with quoted schema/table/column identifiers and
   LIMIT 1–100. No arbitrary SQL, expression, WHERE, parameter interpolation or
   multi-statement input is accepted.
3. `ROLLBACK`, requiring a clean idle OK before returning results.

Classic ColumnDefinition41 and EOF packets are expected: the auth module does
not negotiate DEPRECATE_EOF. Metadata schema/table/original names and requested
column names must match exactly. Status is restricted to AUTOCOMMIT idle (2) or
AUTOCOMMIT+IN_TRANS, optionally IN_TRANS_READONLY (3 or 8195). In particular,
MORE_RESULTS_EXISTS and unknown status bits are rejected.

Known integer/decimal/float/year types require charset 63 and ASCII numeric
syntax. All numeric values remain **strings**, preserving precision; no floating
conversion or unsafe integer rounding occurs. NULL stays null. VARCHAR/VAR_STRING/
STRING and the TEXT-family (blob wire type with a text charset) support only explicitly allowed UTF-8 collations (33,45,46,83,255), with
BINARY_FLAG and ENUM/SET flags rejected and strict UTF-8 decoding. Temporal, JSON, BLOB/binary,
geometry, enum/set and unknown types remain unsupported, even for NULL cells.

## Bounds and failure behavior

At most 16 columns, 100 rows, 96 KiB received across all exchanges, 4096 reads,
8192 encoded SQL bytes and 8192 bytes/2048 characters per cell. The packet decoder
also bounds sequences, packets and payload sizes. Empty chunks are rejected;
monotonic deadline checks complement the timer so immediate microtask reads
cannot evade timeout. Cancellation, timeout, malformed data, LOCAL INFILE,
multiresults, unexpected/trailing packets, metadata mismatch and server errors
close the connection with fixed diagnostics, not raw server error messages.

Owned write/read/packet buffers are cleared on completion/failure. Strings cannot
be guaranteed erasable. A failed connection cannot be reused by this module.
Closing on failure is not proof of server-side query cancellation or completed
ROLLBACK. READ ONLY is not a sandbox for untrusted views, UDFs or extensions:
use a trusted fixture/table and least-privilege account. The timeout closes the
client stream; it does not install a server-wide query timeout.

## Qualification

Eight offline tests exercise generated wire commands, sequence reset, fragmented
results, exact bigint/NULL, malformed types/charset/lengths, error redaction,
row/byte budgets, status/multiresult rejection, cancellation, hanging writes,
concurrent calls and monotonic deadlines. **No real MySQL query has yet been run
through this module.** Previous real CLI queries do not qualify this slice.
Existing MySQL authentication real-server acceptance remains a separate result;
main's missing SSLRequest-to-TLS API and production plugin connectivity remain
unresolved. A later manually authorized Node integration can test this module
without changing those production boundaries.

## Real MySQL 8.4.7 acceptance

On 2026-11-07, the actual Netcatty native SSH terminal ran
`node --import tsx scripts/mysql-local-protocol.ts --read` against the authorized
local TLS fixture. The actual auth + `executeMysqlRead` modules performed two
consecutive read-only SELECT/ROLLBACK cycles on the same verified TLS 1.3 stream.
Exact integer text `1`, label `real-tls-mysql`, NULL, and connection reuse passed.
This is independent Node transport qualification, not main plugin connectivity.
Screenshot: `database-parity-evidence/full-main-round1/netcatty-mysql-read-pass.jpg`.

The first real run exposed status 8227 at SELECT EOF (sequence 5). Oracle MySQL
8.4.7's distributed `include/mysql_com.h` defines NO_GOOD_INDEX=16 and
NO_INDEX_USED=32. Only these informational hints are masked at SELECT EOF;
transaction/autocommit/read-only status still must match. BEGIN/ROLLBACK are not
relaxed. MORE_RESULTS=8, cursor and unknown bits remain rejected. Regression
covers the informational combinations and forbidden flags. Failure and diagnostic
screenshots are retained as `netcatty-mysql-read-first.jpg` and
`netcatty-mysql-read-diagnostic.jpg`.

The earlier 120-second authentication recording does not include these later
query runs. Query qualification has a separate screenshot, not an invented video.
