# Architecture and authority

The plugin publishes React UI through Netcatty SDK `registerHostReactView`.
React executes in the offline plugin sandbox and host code validates and renders
the remote DOM. No iframe, Vue, Tauri, raw IPC, Node builtins or direct network
is present in plugin source. Host theme tokens and package SVG resources drive
the UI. The plain textarea/table are intentionally bounded M0 controls, not a
rich SQL editor or virtual result grid.

The SDK database interface is generated from the host contract and exposed by
the runtime peer. `database.sqlite-fixture.v1` is optional so a default host can
show an honest unavailable state. Host AI invocation is required because the
current package validator requires its feature whenever `ai.invoke` is declared;
provider availability remains a runtime condition and no provider is fabricated.

The host alone starts a fixed SQLite subprocess with an in-memory fixture or
an M2 host-chosen disposable file. It
owns opaque session handles, active source/runtime binding, permission policy,
exact-write review, SQLite authorizer, budgets, deadlines and process shutdown.
A parameter array is bound to anonymous `?` placeholders; SQL string interpolation
is never used. Read and write APIs use the same request type with explicit mode,
but separate permission names. Writes with RETURNING, DDL and transactions are
unavailable. Schema comes from actual host SQLite introspection, not the UI.

The worker has no plugin-defined module, executable, args, environment, paths supplied by plugins,
network destinations or credentials. Cancel/close/timeout discards the entire
memory fixture; closing a file session leaves the read-only file in place. The 32 MiB V8 heap setting does not bound SQLite native
memory. OS-level memory confinement and file/driver qualification are required
before broadening the target surface.

## AI boundary

Schema sharing is off until a connected schema is explicitly selected. Prompts
include task, SQLite dialect, actual schema, selected SQL and user request as
bounded untrusted JSON. Row values and credentials are excluded. Generate,
explain, optimize and fix share the existing host openChat/startTurn/readTurn/
stopTurn/closeChat transport. Streams are bounded, sequence checked, cancellable
and invalidated after close. Output stays in a separate unexecuted draft panel.
There is no automatic insertion or execution, and no hidden EXPLAIN ANALYZE.

## Extension path

Keep the view/domain independent of transport. Introduce future host engine
capabilities with explicit supported-operation flags, target revisions, prepared
plan hashes, scoped credential leases and reviewed driver artifacts. A user
SQLite target must originate in a host chooser, with canonical file identity,
read-only open, stale-handle/symlink defenses and WAL/locking tests. PostgreSQL
and MySQL require host-owned TLS connections, exact destination policy, server
cancellation and transaction outcome semantics. Merely adding icons or engine
names never enables a driver. Advanced editing, ER diagrams, import/export,
backup, transfer, admin and native driver packs need separately qualified host
UI/service primitives; DBX parity is an ongoing product roadmap.

## M2 Linux disposable file gate

The optional `database.sqlite-file-fixture.v1` capability adds
`database.openSqliteFile({}) -> DatabaseFileOpenResult | null`. The host native
chooser is the only path input. Its fixed allowlist directory is
`/workspace/agent-tools/database/m2-chooser/fixtures/`; this does not enable
arbitrary user databases. The result exposes a handle/revision and constant
non-secret metadata. Every file operation echoes the revision. Memory sessions
keep the original contract and reviewed write path.

Host checks bind canonical path, device/inode, size and modification/change time
around approval, worker open and reads. The worker uses SQLite readOnly,
query_only, defensive mode, trusted_schema off and a 100 ms busy timeout. Only
an ordinary notes table is exposed. File writes, links, WAL headers and
WAL/SHM/journal sidecars fail closed. Stable replacement and stale-handle tests
pass; the native open pathname race/ABA window against a hostile local writer
is not solved. Concurrent sidecars, WAL readers/writers, hostile/corrupt files,
resource quotas and general schemas remain production gates. The M2 tests use
only generated disposable files and mock AI; no user files or live AI are used.
