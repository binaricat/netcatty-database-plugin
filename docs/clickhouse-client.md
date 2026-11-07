# ClickHouse HTTPS read client: pre-UI qualification

`ClickHouseReadClient` is an independent public-SDK `network.request` adapter. It has no application route or enabled endpoint in the distributed package yet. Its tests inject HTTP responses; there is no actual ClickHouse, TLS, credential permission, Docker or native connected-state acceptance.

The client permits only fixed system metadata queries and bounded table reads with ClickHouse typed parameters. Each request obtains a fresh origin-bound secret lease and asks the host to apply Basic authorization; no raw password or hand-built Authorization header enters the adapter. Query settings request readonly mode, strict result overflow, 100 rows/64 columns and 96 KiB limits. It rejects malformed leases, base64/UTF-8, unsafe JSON integers, unsupported scalar types and oversized metadata.

Table reads allow only a conservative list of local storage engines. This is **not a server-side execution sandbox**: aliases/defaults/UDFs and concurrent schema changes still require a trusted fixture without external behavior. View, Distributed, URL and similar external engines are not read by this route. No arbitrary SQL, SQL scripts, writes, OUTFILE, table functions, retries or setting downgrade are exposed.

HTTPS endpoints must be explicit and match the provided package declaration list. All IP literals, localhost, .localhost/.local and single-label hosts are conservatively rejected. FQDN DNS behavior is owned by the host HTTP service and is not equivalent to the byte-stream broker's local/control-peer protection. This adapter must never be used to bypass a rejected loopback or control endpoint.

The host HTTP service can follow redirects. An exact final response URL mismatch is rejected here, but this cannot undo a redirect already followed by the host. Even equivalent query-parameter reordering is conservatively rejected. Future real testing therefore requires an explicitly authorized trusted direct HTTPS server with no redirects, valid TLS identity and normal origin permission. Cross-origin authorization/credential stripping remains host-owned; no private header or proxy workaround is added.

## Contract and response hardening

The client rejects trailing-dot hostnames as well as the documented local/IP forms; this closes a hostname-spelling gap but is not a DNS-address SSRF guarantee. Secret lease IDs follow main's 32–256 character contract. `scripts/check-clickhouse-host-contract.mjs` invokes the actual main SecretLeaseRef validator and network broker validate/describeAuthorization functions using synthetic leases only, with fetch disabled. It does not test lease issuance/consumption or credentials.

Decimal output must be quoted strings, requested through `output_format_json_quote_decimals=1`; 64-bit integer quoting is also requested. Numeric Decimal cells are refused before any rounded value can escape. HTTP-success responses containing ClickHouse exception headers or envelope fields are refused with a fixed error. There is no fallback when the server or readonly account rejects these settings. Real-server settings compatibility and late-error behavior remain unqualified.
