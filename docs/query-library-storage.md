# Explicit persistent named SQL library

`createQueryLibraryStorage(storage)` exposes only explicit operations:

- `load(savedConnectionId)` returns `{version:1,savedConnectionId,revision,saved}`.
  A missing key returns revision 0 and an empty array without writing anything.
- `save(id,{name,sql,parameters,time},expectedRevision)` creates or replaces an
  exact trimmed name, preserving its existing entry ID. It returns the new library.
- `remove(id,entryId,expectedRevision)` removes exactly that entry, or fails.

This stores **plaintext SQL and bound parameter text** in this plugin's local
storage. Either field can itself contain sensitive data or passwords. This is not
a credential vault: do not intentionally save credentials. No query history,
query results, authentication fields, runtime handles or execution state are
accepted. There is no SQL execution or automatic persistence in this module.

Limits: 30 entries per saved connection, SQL and parameter text each at most 8192
UTF-8 bytes (also subject to the existing model's character/parameter validation),
96 KiB per serialized library, eight connection libraries and 768 KiB total.
Connection IDs are restricted to 1–128 ASCII letters, digits, `_` or `-`.
Unknown fields, versions, malformed parameter JSON, duplicate identities/names and
oversized stored data fail explicitly. Corrupt content is never silently treated
as an empty library and overwritten.

Operations sharing the same storage object serialize across wrapper instances.
Expected revision rejects stale read/modify/write calls. Each successful mutation
uses one host storage UPSERT, never deletes the prior value first. Storage errors
have fixed messages without host diagnostics. Inputs are copied before awaiting,
and returned records do not alias stored objects.

Deleting the final entry retains an empty revisioned record. This prevents an old
revision-0 request from being accepted after deletion/recreation (ABA). Such empty
records still count toward the eight-library budget. Future connection deletion
integration must explicitly coordinate lifecycle locking and tombstone cleanup;
this module does not silently delete whole libraries. The host does not provide
cross-runtime CAS, so these guarantees require one owner/shared storage object,
not independently running plugin runtimes.

## Integration still required

No UI, adapter or connection-deletion lifecycle has changed in this slice.
Integration must bind IDs to actual saved connections, disclose plaintext storage,
make same-name overwrite and permanent deletion clear, and reject late UI results
after connection/handle/generation changes. Reading a named entry into the editor
must clear previous results and pending write reviews without running its SQL.
Saving must use a captured editor snapshot, never overwrite later edits on return.

This implements named SQL persistence, not DBX snippet prefix expansion, template
placeholders, cloud synchronization or external SQL file management. Tests use
injected local storage, not native application persistence acceptance.
