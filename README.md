# Netcatty Database

An independent, GPL-3.0-or-later, host-rendered Netcatty database workbench.
Version 0.1.0-alpha.1 is an experimental SQLite fixture slice, not a general
purpose database client or DBX parity release.

## Reproduce locally

Node 24.19+ and npm are required. All private Netcatty packages are pinned local
tarballs with source; no sibling checkout or public SDK publication is assumed.

```sh
npm ci --ignore-scripts
npm run lint
npm test
npm run pack
npm run validate
```

The build produces `dist/netcatty-database-0.1.0-alpha.1.ncpkg` and `SHA256SUMS`.
Import that local file using Netcatty Settings > Plugins. No URL installer or
advanced plugin mode is needed. This milestone requires the host changes on
`feat/plugin-database-foundation`. The host feature is off by default; for an
explicitly synthetic test launch set `NETCATTY_EXPERIMENTAL_DATABASE=1`.
A normal host keeps the console visible but its database controls unavailable.

Open the Database Vault page, select **Open synthetic SQLite**, and approve the
read permission. The host creates three clearly synthetic notes in memory.
Run uses bound parameters and returns actual SQLite results. **Review write**
requires a separate native review of exact SQL and parameter values on every
call, even if the generic write permission is Allow. Cancellation closes the
worker and discards the fixture. No file chooser, arbitrary paths, credentials,
network connections, transactions, DDL, import/export or production data access
are implemented.

AI generate/explain/optimize/fix uses Netcatty's existing bounded host streaming.
Connect first, inspect schema, and explicitly choose to share schema/SQL/request.
No result rows are sent. A configured host model and AI permission are required.
Output remains labeled **Unexecuted AI draft** and never runs automatically.

PostgreSQL and MySQL are named roadmap targets with icons, not active drivers.
See docs/architecture.md, docs/qualification.md and docs/provenance.md.
