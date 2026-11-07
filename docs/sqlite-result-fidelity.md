# SQLite result scalar fidelity

## Compatibility boundary

The adapter is pinned to sql.js **1.14.1**. `readSqliteResultRow` uses its documented
`get(undefined, {useBigInt:true})` option, which the installed TypeScript types
omit. Safe integers remain numbers; larger signed integers become exact decimal
strings. This does not claim typed SQL round-trip/export or exact integer binding.

For cells initially classified as TEXT, the adapter calls the named
`statement.getBlob(columnIndex)` on the **same live row**, without re-running SQL.
This is an explicitly accepted version-specific compatibility seam, **not a
stable public API guarantee**. Upstream [`src/api.js` lines 350–392](https://github.com/sql-js/sql.js/blob/v1.14.1/src/api.js#L350-L392)
labels the retrieval helpers internal; getBlob copies `sqlite3_column_bytes`
bytes obtained through `sqlite3_column_blob`. It is absent from the explicit
public-name preservation list at lines 1461–1475. No minified field, WASM heap,
private statement pointer or native ABI is accessed by this adapter.

SQLite's [column access conversion contract](https://www.sqlite.org/c3ref/column_blob.html)
specifies TEXT to BLOB as unchanged data. Callers must have stepped successfully
and must not advance/reset/free the statement during row decoding. Capturing the
initial values first avoids interpreting type information after conversions.
Runtime capability is checked for every TEXT cell. A missing method, wrong
return type or failed byte access produces a fixed error, never fallback to an
already-truncated JS string. The current package must be requalified on upgrades.

## Exactness and failures

- UTF-8 decoding uses `fatal:true, ignoreBOM:true`, preserving embedded NUL,
  multibyte characters and a leading U+FEFF BOM.
- Invalid UTF-8 rejects the row and propagates as a query failure. No replacement
  characters, prefix results or data-like error markers are returned.
- Non-finite REAL values reject explicitly instead of becoming JSON null.
- Empty TEXT, NULL and BLOB remain distinct. BLOB remains the existing disclosed
  `<BLOB N bytes>` placeholder, not lossless BLOB support.
- Copied text buffers are wiped in finally on success, decoding failure or limit
  refusal. JS strings cannot be reliably wiped; no zero-retention claim is made.
- This adapter preserves NUL in result data. Rendering/export/editing layers must
  separately handle it safely; display escaping must not be substituted for the
  original value. This change alone is not native DOM or clipboard qualification.

## Resource limitations

The accumulated TEXT byte budget is 96 KiB per row. It is checked **after**
getBlob copies the full cell and before decoding; ordinary get() has already
materialized its own strings/BLOBs. The existing query-level result budget remains
separate. Neither limit prevents SQLite evaluation from allocating a large value,
nor prevents peak allocation for the first copy or synchronous CPU stalls. This
is a fidelity and returned-data bound, not an execution sandbox or hard memory cap.

## Tests

Seven focused tests cover actual SQL.js int64 boundaries, NUL/multibyte/BOM,
invalid UTF-8 (including bytes after NUL), missing/broken byte access, exact and
over-limit byte budgets, buffer wiping, real oversized TEXT and ±Infinity.
These are local engine/adapter tests, not native App/provider/network acceptance.

Alpha34 integration uses this reader in the ordinary query facade. View/table UI
keeps original values, while controls and invisible/bidi markers display as explicitly
labelled reversible JSON escapes; cell inspector explains this is display-only.
A literal backslash-u sequence remains distinguishable from a real NUL. Wider
integers are decimal text, so typed SQL export/binding parity remains incomplete.
Real engine/facade tests cover NUL/BOM/multibyte, invalid UTF8 rejection and recovery,
wide integers and non-finite-number refusal. Native display verification is pending.
