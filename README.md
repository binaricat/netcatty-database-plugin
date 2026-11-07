# Netcatty Database

Experimental database workbench for the current Netcatty `main` plugin platform.
The compatibility baseline is host commit
`4a55492c17c3c792fbda4afc08d993f4165ca930` and plugin API
`0.1.0-internal.1`. No host source changes or old development branch are needed.

The first main-compatible slice includes an actual, plugin-owned SQLite engine,
a disposable memory dataset with tables and a view, schema inspection, parameterized
read queries, query tabs, English/Chinese labels and host model SQL drafting.
Connection metadata uses the host's permission-controlled plugin storage. Reopening
creates a fresh sample database; database contents are not persisted.

The database catalog carries forward 21 entries. **Only SQLite memory is available
in this main-compatible slice.** PostgreSQL/MySQL and the other drivers have not
yet been ported to the generic `network.byte-streams` API. Catalog entries and
icons are not successful driver tests. This is not DBX parity.

## Build and check

Node >=24.19 and npm are required. SDK/contract/CLI source snapshots are vendored
from the host commit above, with their original licenses.

```sh
npm ci --ignore-scripts
npm run lint
npm test
npm run pack
npm run validate
```

The resulting package is `dist/netcatty-database-0.1.0-alpha.4.ncpkg`. Import it in
Settings > Plugins on Netcatty main, enable it and open Database. Choose
New Connection > SQLite > Next > Test or Save & Connect. Storage is an optional
permission requested when metadata is read or saved. The package requires main's AI API feature; actual AI invocation remains optional
and requires a configured host model and permission.

Validate installation with a disposable profile using an unmodified host checkout:

```sh
# In the host checkout
npm ci --ignore-scripts
npm run build:plugin-runtime-deps
# In this plugin checkout, after pack
NETCATTY_HOST_ROOT=/absolute/path/to/netcatty-main node scripts/check-main-host.mjs
```

This invokes main's actual PackageStore/PluginManager. It does not start the
native app or substitute for GUI/database acceptance.

## Runtime boundaries

The browser bundle uses the locked SQL.js **asm.js** build, with no WebAssembly,
dynamic code evaluation, worker, native library or database-specific host RPC.
Its Node-only filesystem/randomness fallbacks are replaced with throwing modules
by the browser build; browser Web Crypto supplies randomness. It executes real
SQLite against owned in-memory sample data.

Read mode accepts one SELECT/WITH/EXPLAIN statement. SQLite `query_only` also
rejects writes; PRAGMA/ATTACH and scripts are unavailable. Native SQLite allocations
have an 8 MiB hard heap limit; results are bounded to 100 rows, 64 columns and
96 KiB, with a smaller rendered preview. Closing/disabling releases sessions.
**There is no hard CPU deadline or interruptible worker.** This is not suitable
for untrusted SQL or arbitrary user databases. File access, WAL, writes, production
SSH tunnels, persistent credentials and native/JDBC drivers remain unavailable.

main's React adapter has no cross-view modal controller. The connection dialog is
contained within this contributed workbench. The plugin uses only main's allowed
CSS tokens and renders through the host's validated remote DOM.

## Comparison and evidence

See [the DBX capability matrix](docs/dbx-parity.md) for source pins, remaining work
and platform limitations. Local/CI checks and actual native/Docker evidence must
be reported separately. Unit tests are not a multi-database or GUI qualification.

The previous experimental host documentation is retained in
[the historical snapshot](docs/experimental-host-snapshot.md). Other older gate
notes in `docs/` and `tests/native/` describe that historical host and do not
establish compatibility or acceptance on main. The old commit
`1cfa14b808bcff813676c0e41c8ea522149b76dd` and branch
`feat/plugin-database-foundation` were not publicly resolvable during this audit.

## Licenses and assets

The plugin and host SDK snapshots are GPL-3.0-or-later. SQL.js is MIT and SQLite is
public domain. Retained brand assets keep the provenance and distribution limits
in NOTICE and the asset ledgers; catalog marks do not imply vendor endorsement.
