# Architecture and authority

The plugin publishes React UI through Netcatty SDK `registerHostReactView`.
React executes in the offline plugin sandbox and host code validates and renders
the remote DOM. No iframe, Vue, Tauri, raw IPC, Node builtins or direct network
is present in plugin source. Host theme tokens and package SVG resources drive
the UI. The plain textarea/table are intentionally bounded fixture controls, not a
rich SQL editor or virtual result grid.

The SDK database interface is generated from the host contract and exposed by
the runtime peer. `database.sqlite-fixture.v1` is optional so a default host can
show an honest unavailable state. The optional
`database.saved-connections.v1` adds a host JSON store of source-owned metadata.
Saving derives the target from a live handle; no plugin-supplied path is accepted.
`PluginSecretStore` holds ciphertext separately using Electron safeStorage and
rejects unavailable/basic-text backends. Only opaque references reach results.
The UI state/lifecycle lives in `useWorkbench`; components render the shell.
Gate D adds optional `ai.model-invocation` and `ai.invoke`, independent of database permissions.

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

Gate D uses `useSqlAssistant` for UI lifecycle and `DraftStream` for host RPC
orchestration. Components receive no database execution API for AI actions;
insertion calls only the editor state updater. The mounted panel is keyed by
connection handle and query tab, so switch/hide/disconnect releases AI handles.
Generations are reserved before any await and late open/start/read results are
cleaned or discarded. Each run opens a fresh chat and always releases it.

`buildPrompt` projects connected schema tables/columns plus task, SQLite dialect,
display label, bounded editor SQL and user request into an untrusted JSON envelope.
No rows, parameters, errors, host/session/connection objects or secret references
are serialized. Prompt cap is 12,000 UTF-8 bytes, output cap 8,192 UTF-8 bytes.
Host model selection, credentials, permissions and network transport remain in
the existing AI service; tools are disabled and unknown events fail closed.
Optional feature absence and host invocation failures are localized unavailable
states, with no simulated fallback. Only explicit editor actions execute SQL.
Real-provider acceptance remains SKIPPED_NO_PROVIDER in this environment.

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

## M3 saved connections

The host stores version-1 JSON at `userData/plugins/database-connections.json`.
Entries carry the host's source owner, non-secret metadata, and for files the
original canonical identity tuple. Listing strips private target/owner fields;
reopen repeats feature, owner, read permission and file checks. New runtime
handles and revisions are issued. Memory contents and active sessions are not
persisted. Metadata writes use an exclusive staging file and atomic rename.
Credentials use a host-generated `database-connection:<id>` secret key and are
never decrypted by this service. Delete removes the associated credential.

The host metadata adapter reuses the existing authenticated renderer vault
bridge for `host.list`, then allowlists only id/label/hostname/port/username.
It gates disclosure and save-time host binding with `vault.metadata` and repeats
runtime/source checks after awaited work. No script execution, tunnel, network
connection or host credential resolution is part of this path.

UI results and choice lists are bounded for the host's 1024-node remote DOM
limit. Notes-only schema is unchanged; Views explicitly reports zero exposed
views. Advanced settings, history, structure and ER are unavailable. Stale labels
after a host timeout still require Close/reopen; host authority is already gone.
