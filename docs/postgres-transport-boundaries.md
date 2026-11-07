# PostgreSQL protocol slice and independent real-server validation

`postgresProtocol.ts` encodes PostgreSQL v3 StartupMessage and extended-query Parse/Bind/Describe(portal)/Execute/Sync. It incrementally decodes selected authentication, ParameterStatus, ReadyForQuery, RowDescription, DataRow and ErrorResponse frames. Error output retains only SQLSTATE, not potentially sensitive server messages. Text fields use fatal UTF-8 decoding; DataRow cells remain bytes because formats/OIDs determine whether they represent text or binary. `pgTextValue` is explicit text decoding, not general typed conversion.

This is not a connection driver. The codec itself does not compute SCRAM or MD5 and does not implement TLS, certificate checking, server query cancellation, CommandComplete/BackendKeyData/notice handling or complete session state. Unsupported message types fail closed. A fresh decoder is intended per bounded exchange, with 256 KiB frame/pending-buffer ceiling, 96 KiB cumulative exchange bytes, 1000 frames, 64 columns, 32 bound parameters and Execute rows 1–100. These limits deliberately cannot read arbitrary bulk results.

Tests use standard protocol byte layouts and adversarial fragments/budgets. They are not a simulated-server claim or real PostgreSQL compatibility evidence. No network or real credentials are involved. SASLInitialResponse/SASLResponse encoding and strict AuthenticationSASL mechanism-list parsing are implemented; list parsing performs no automatic mechanism selection or downgrade.

Current main public network.connect accepts only an exact endpoint. TCP cannot be upgraded to TLS after PostgreSQL SSLRequest; direct TLS has certificate verification but no exposed ALPN option. PG17 direct TLS must not be claimed compatible without verified `postgresql` ALPN support and actual service tests. PostgreSQL 15 in the proposed Docker fixture is not a direct-TLS substitute. Generic host STARTTLS or a validated ALPN path would require a separately authorized host change, not insecure fallback, proxy, hostname alias or policy bypass.

The separate SCRAM module now supplies offline vectors, server-signature checks and bounded iterations/cancellation; native plugin integration still needs a compatible host-verified TLS transport. A separate Node integration lane now validates the modules against a real fixture; it does not resolve main's transport gap. Byte-stream AUTH cannot use the separate HTTP credential-lease substitution automatically. Secrets must remain explicitly supplied session memory, without logging or automatic persistence. Closing a connection is not proof that server-side CancelRequest succeeded. No manifest permissions or host capabilities were changed for this codec.

## SCRAM-SHA-256 foundation

`postgresScram.ts` implements a bounded authentication state machine without opening a connection. Five tests include the RFC 7677 client proof/server verifier transcript, malicious nonce/salt/iteration inputs, invalid ordering, concurrency/cancellation and server signature rejection. Credentials are ASCII-only until SASLprep is implemented. SCRAM-PLUS/channel binding is not available. This module alone is not usable native-plugin PostgreSQL connectivity: the main transport limitations above remain unresolved.

## Browser WebCrypto source audit

Main `electron/main.cjs:159–166` registers the plugin scheme as standard and secure. `browserPluginRuntime.cjs:137–145` uses a sandboxed, context-isolated browser with Node disabled and web security enabled. `runtime/browserRuntime.mjs:16–35` disables direct network/worker browser capabilities but does not remove `crypto`, `getRandomValues` or `subtle`; `pluginProtocol.cjs:134` CSP does not disable WebCrypto. Thus browser WebCrypto is expected to support the SCRAM module without Node imports or permission weakening. This is a source audit, not an installed-runtime crypto test. Run the offline RFC vector inside the actual installed sandbox before claiming runtime qualification; Node unit success alone does not establish it.

## Startup protocol state machine

`postgresSession.ts` now consumes an injected, already host-verified TLS
`PluginByteConnection`. It does not open a socket or resolve the STARTTLS/ALPN
boundary above. Strict progression is SASL mechanisms → server first → verified
server final → AuthenticationOk → idle ReadyForQuery. Parameters are bounded;
BackendKeyData is checked for exact length and discarded, not used as a claimed
CancelRequest capability. Success transfers the original connection back to the
caller; further asynchronous frames still need decoding by a future query layer.

Thirteen offline session tests cover fragmented bytes, wrong server signatures,
ordering, PLUS-only refusal, malformed input, abort, timeout, read/frame/metadata
budgets, coalesced trailing frames and late writes. A review found that empty
immediate reads could starve timer callbacks. The implementation now rejects
empty reads, limits reads to 4096, and independently checks a monotonic deadline
around reads/writes, frame processing and asynchronous SCRAM work. Failure and
cancellation close the connection and zero the in-flight write buffer even if
the write remains pending. WebCrypto cancellation is best effort: closing does
not abort already-issued cryptographic computation, but prevents later success
or additional writes.

The session unit tests use fabricated bytes and credentials. Separately, the real-server integration lane below has now passed. No native PostgreSQL connection UI or usable production plugin driver is claimed.

## Bounded authenticated table reads

`postgresQuery.ts` executes a generated, fixed Simple Query sequence on an
exclusively owned authenticated TLS stream: BEGIN READ ONLY, bounded local
statement timeout, quoted SELECT of explicit columns and LIMIT, then ROLLBACK.
It accepts no arbitrary SQL. Strict response order, known text-format OIDs,
100-row/16-column/96-KiB limits, monotonic timeout and abort protections apply.
int8 and numeric remain exact strings. Unexpected, binary or extension types are
rejected, even when all values are NULL. Failure closes the stream; if PostgreSQL
skips later statements after an error, no claim that ROLLBACK executed is made.
Read-only transactions do not eliminate side effects of untrusted views or
extensions; a trusted schema and least-privilege account remain required.

Owned read/write/frame/cell buffers are cleared on consumption and failure,
including late reads after cancellation. Decoder output cell buffers are copies
owned by the receiver. JavaScript strings, engine internals and cryptographic
implementation copies cannot be guaranteed erasable. Eleven fabricated-stream
query tests cover successful fragmented reads, strict command sequencing,
conversion, error-message redaction, cancellation, budgets and byte cleanup.
Those unit tests are not real-server evidence. The separate real-server lane below qualifies only its tested protocol subset, not plugin connectivity or a production driver.

## Real PostgreSQL 17.6: independent Node integration lane

On 2026-11-07, the coordinating worker executed all three modes of
`scripts/postgres-local-protocol.ts` inside the actual Netcatty native SSH terminal.
The existing `authenticatePostgresTls` and `executePostgresRead` modules passed
against PostgreSQL 17.6 at the explicitly authorized local test service:

- Standard SSLRequest followed by verified TLS 1.3, using the fixture certificate
  as trust anchor and exact `127.0.0.1` certificate identity verification.
- SCRAM authentication with the runtime-only password file, then generated
  read-only query of `public.netcatty_smoke`; expected label and NULL verified.
- Invalid-password startup rejected; untrusted-certificate mode rejected by
  certificate verification, not counted successful on connection refusal/timeout.

The password is not embedded in source, command arguments or report output. The
script opens Node sockets only when manually executed; it is not imported into the
plugin or ordinary unit tests. **Node supplies the SSLRequest-to-TLS upgrade that
main's public plugin API currently lacks.** Therefore these results are real
server protocol-integration evidence, not a main-broker workaround, native plugin
database connection, Docker run, arbitrary-SQL acceptance or full DBX parity.

Separately, native SSH `psql` tests covered table creation/UPSERT, NULL, prepared
parameters and refusal of non-TLS access. See
[native SSH PostgreSQL acceptance](native-ssh-postgres-acceptance.md) for evidence
and the distinction between terminal, independent protocol and plugin lanes.
