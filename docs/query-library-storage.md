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
records still count toward the eight-library budget. Connection deletion
integration now coordinates lifecycle locking but does not reclaim tombstones;
this module does not silently delete whole libraries. The host does not provide
cross-runtime CAS, so these guarantees require one owner/shared storage object,
not independently running plugin runtimes.

## Integrated candidate, native acceptance pending

PersistentQueryLibrary explicitly loads storage before mutation, captures SQL and
parameters at the save click, confirms same-name replacement and permanent removal,
and ignores late UI results after disposal/connection changes. Loading into the
editor clears results and pending write reviews without execution. Six entries per
page, compact rows and bounded highlighted replacement previews limit remote DOM.
The parent presents persistent named SQL first; session-only favorites/history and
workspace drafts remain in secondary disclosure sections.

The local SQLite adapter exposes queryLibraryStore bound to actual saved SQLite
connections. All load/save/remove operations share the saved-ID lock with snapshot,
open and connection-delete operations. Nonempty or corrupt SQL libraries prevent
connection deletion. Empty revision tombstones remain and count toward the budget.
Real SQL.js adapter tests cover save/delete races in both directions, snapshot-lock
conflicts and refusal to create orphan libraries after deletion.

The main SDK remote-DOM regression covers save, remount/read, editor-only load,
replace review/cancel and delete review/cancel. These remain injected view/storage
transport evidence, not actual native app restart durability acceptance.

This implements named SQL persistence, not DBX snippet prefix expansion, template
placeholders, cloud synchronization or external SQL file management. Tests use
injected local storage, not native application persistence acceptance.
