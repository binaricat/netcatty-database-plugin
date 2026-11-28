# Source and licensing provenance

All plugin workbench, domain, wire-protocol driver, and service code is authored
for Netcatty Database under GPL-3.0-or-later.

The three `vendor/*.tgz` packages are built from the paired Netcatty host plugin
packages (`@netcatty/plugin-contract`, `@netcatty/plugin-sdk`, `@netcatty/plugin-cli`).
They include `src`, generated contract schemas, build configuration, distributed
JS/types, and GPL-3.0-or-later license. `package-lock.json` pins every tarball's
integrity and `vendor/SHA256SUMS` records reviewable archive hashes.

## Engine icons and brand marks

- **Simple Icons (CC0-1.0)**: SQLite, PostgreSQL, MySQL, MariaDB, ClickHouse,
  Redis, MongoDB, TiDB, Oracle, SQL Server, DuckDB, and OceanBase derive from
  Simple Icons SVGs with fixed light/dark theme fills and transparent 128×128
  PNG rasters. `assets/icon-ledger.json` and `assets/brand-icon-ledger.json`
  record source URLs, upstream hashes, transformed hashes, and license metadata.
  CC0 applies to Simple Icons contributions; underlying brand and trademark rights
  remain with their owners.
- **Open-Source Database Icon Repositories**:
  - Firebird, Vastbase (isolated 6-petal starburst), GBase, and KingbaseES (vector
    `K` emblem) derive from `Syngnat/GoNavi` (Apache-2.0, `licenses/Apache-2.0.txt`).
  - Dameng and GaussDB derive from `dataease/dataease` (GPL-3.0-or-later, `LICENSE`).
- **Official Vendor Portal Vectorizations**: UXDB (`uxdb.net.cn`), HighGo
  (`highgo.com`), and GoldenDB (`goldendb.com`) are cleanly vectorized from the
  vendors' official website marks for product identification.
- **Original Netcatty Database Geometric Emblems (CC0-1.0)**: Neo4j, Elasticsearch,
  Qdrant, InfluxDB, TDengine, Trino, CockroachDB, Apache Doris, etcd, and Consul
  use original geometric SVG emblems authored for Netcatty Database and rasterized
  offline via `rsvg-convert` into 128×128 transparent PNGs.
- **openGauss Official Graphic**: `assets/domestic-icon-ledger.json` tracks the
  official `opengauss.org` graphic mark under its conditional noncommercial brand
  policy (`licenses/openGauss-brand-policy.txt`, `NOT_CLEARED_FOR_GENERAL_DISTRIBUTION`).
- **UI Icons**: 27 static UI icons under `assets/ui/` are generated from
  `lucide-react@0.560.0` (ISC) and verified via `assets/ui-icon-ledger.json`.

All asset hashes and contract dimensions are verified by `scripts/check-assets.mjs`.

## Host policy and vendored snapshots

`vendor/host-policy/pluginViewStylePolicy.cjs` is a GPL copy of the host's
stylesheet validator used by `npm run lint` (`scripts/check-host-policy.mjs`) to
verify stylesheet safety before packaging. It is not bundled into the plugin.

Independent checkout builds use the vendored archives in `vendor/` and require no
external host refresh. Maintainer refresh procedure: build the host's plugin
packages, run `node scripts/vendor-sdk.mjs /absolute/host`, update `package-lock.json`
tarball integrity, and rerun `npm run lint`, `npm test`, `npm run pack`, and
`npm run validate`.
