# Source and licensing provenance

All new plugin/domain/host SQLite code was authored for this milestone. No DBX
code, fonts, styles or assets were copied; no DBX Apache NOTICE is implied.

The three `vendor/*.tgz` packages were built from Netcatty base
`7949242765a07bc2e766cd04e69eff32cf666699` plus this milestone's canonical database
schema and SDK interface. They include `src`, generated contract, build config,
distributed JS/types, and GPL-3.0-or-later license. The local host implementation
commit is recorded in the final worklog/report; these packages are not published
to npm. `package-lock.json` pins every tarball's integrity. See
`vendor/SHA256SUMS` for reviewable archive hashes.

SVG geometry is taken from Simple Icons 16.23.0, whose metadata points to the
official SQLite artwork repository, PostgreSQL logo page, and MySQL logo page.
These are sanitized monochrome derivatives, not a claim that vendor-supplied
full-color SVG files were downloaded. The ledger preserves source URLs,
upstream hashes, transformed hashes, license metadata and fixed contrast fills.
CC0 applies to Simple Icons contributions; brand/trademark rights remain with
their owners. Release review must retain those distinctions.

Bundled dependency licenses are in `licenses/`; the GPL license is at root and
inside the staged package. All package contents are local, and no remote
repository, push, release or publication is part of this implementation.

`vendor/host-policy/pluginViewStylePolicy.cjs` is an unmodified GPL copy of the
host's stylesheet validator at the base revision, used by independent lint.
This catches unsupported host token references before packaging. It is not
bundled into the plugin or used to relax the actual host policy.

Final host implementation commit: `e1e25ded99a758cc96f466656b1b04c8559ef7eb`
on `feat/plugin-database-foundation`. Refresh procedure (maintainer only): build
that host's plugin packages, run `node scripts/vendor-sdk.mjs /absolute/host`,
update npm lockfile file-tarball integrity, then rerun lint/tests/pack/validation.

## Gate D optional host AI

The CLI snapshot is refreshed from the paired Gate D host to accept optional
`ai.model-invocation` alongside optional `ai.invoke`. Permission enforcement and
wire shapes are unchanged; contract and SDK tarballs retain their prior hashes.
The exact host/plugin commits and archive digest are recorded in
`/workspace/agent-tools/database/gate-d-live-ai/final-status.json`.

## Gate J explicit refresh SDK

Only the SDK tarball changed for the additive typed `refreshSqliteFile` method;
request/result shapes reuse the canonical contract. Contract/CLI tarballs retain
their previous hashes. Archive integrity is pinned in package-lock.json and
vendor/SHA256SUMS. The paired local host commit is recorded in the Gate J report.

## T305 app-wide modal and static engine marks

Contract and SDK snapshots are refreshed from the paired local host's T305
implementation (starting b4712f13ae46668a4d5dbf5430e44b5ddbd34e0d), including
TypeScript sources, generated schema, build configuration and license. CLI is
unchanged. `vendor/SHA256SUMS` and lockfile pin the refreshed archives; the exact
final paired host commit is in the T305 REPORT. These remain private local
internal API snapshots, gated by `views.modals` and `metadata.brand-icon`.

The six engine PNGs were rasterized offline from the existing reviewed SVGs
using Chromium canvas, preserving geometry and fixed theme fill. The source and
output hashes, original licensing and trademarks are in
`assets/brand-icon-ledger.json`. Only bounded static PNGs are sent through the
host brand-icon resource contract. No DBX assets or code were copied.

T314 domestic driver profiles extend the public schema and registry from host
67c989c92dc231535091772f397444bc05131517 with explicit variants and schema-derived
profile types. The contract snapshot includes corresponding generated and source
TypeScript/schema plus build files/license. SDK API remains openTcp with the public
schema-derived request type. Vendor tarball hashes and lockfile integrity are
updated; no proprietary JDBC driver or copied vendor implementation is bundled.
See docs/t314-release-notes.md for the exact unsupported product/authentication
boundaries. Brand provenance is separate in assets/domestic-icon-ledger.json.
