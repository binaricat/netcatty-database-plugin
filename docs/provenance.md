# Source and licensing provenance

Plugin workbench/domain/service code was newly authored. Later milestones added
explicitly identified DBX-derived brand assets, including Firebird and six
domestic marks. Their source notices, transformations and licensing boundaries
are retained in NOTICE and the asset ledgers; DBX root licensing does not itself
establish third-party artwork ownership or trademark permission.

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
inside the staged package. The current publication decision includes plugin
source, existing assets and source history, retaining all notices and licenses.
T314 local noncommercial acceptance was a historical scope, not the current
source delivery limit. The unchanged domestic ledger records that historical
usage authorization; NOT_CLEARED_FOR_GENERAL_DISTRIBUTION still applies. Public
source intent does not establish general third-party redistribution permission.
Six domestic marks are DBX-derived without individual asset clearance; openGauss
uses its official conditional noncommercial brand policy, not an open license.
See `licenses/domestic-brands.txt` and the full domestic ledger for conditions.

`vendor/host-policy/pluginViewStylePolicy.cjs` is an unmodified GPL copy of the
host's stylesheet validator at the base revision, used by independent lint.
This catches unsupported host token references before packaging. It is not
bundled into the plugin or used to relax the actual host policy.

Earlier SQLite host implementation milestone: `e1e25ded99a758cc96f466656b1b04c8559ef7eb`
on `feat/plugin-database-foundation`. The matching T314 development host is
`1cfa14b808bcff813676c0e41c8ea522149b76dd` on that branch; host changes remain
local and are not delivered by this repository. No generally released host
compatibility is established. Its default-off database experiment, negotiated
features, permissions and updated schema/validators are required; the broad
manifest version range is not a compatibility guarantee.

Independent checkout builds use the vendored internal source archives and need
no host refresh. Maintainer refresh procedure: build
that host's plugin packages, run `node scripts/vendor-sdk.mjs /absolute/host`,
update npm lockfile file-tarball integrity, then rerun lint/tests/pack/validation.

## Gate D optional host AI

The CLI snapshot is refreshed from the paired Gate D host to accept optional
`ai.model-invocation` alongside optional `ai.invoke`. Permission enforcement and
wire shapes are unchanged; contract and SDK tarballs retain their prior hashes.
This is a historical Gate D snapshot; current archive digests are recorded in
`vendor/SHA256SUMS` and the lockfile. Real-provider acceptance remains
SKIPPED_NO_PROVIDER, not a real inference qualification.

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
final paired host commit is in the T305 REPORT. These are vendored internal API
snapshots with source and GPL notices, gated by `views.modals` and
`metadata.brand-icon`.

The six engine PNGs were rasterized offline from the existing reviewed SVGs
using Chromium canvas, preserving geometry and fixed theme fill. The source and
output hashes, original licensing and trademarks are in
`assets/brand-icon-ledger.json`. Only bounded static PNGs are sent through the
host brand-icon resource contract. At T305, no DBX assets or code had been copied;
later DBX-derived artwork is identified above and in NOTICE.

T314 domestic driver profiles extend the public schema and registry from host
67c989c92dc231535091772f397444bc05131517 with explicit variants and schema-derived
profile types. The contract snapshot includes corresponding generated and source
TypeScript/schema plus build files/license. SDK API remains openTcp with the public
schema-derived request type. Vendor tarball hashes and lockfile integrity are
updated; no proprietary JDBC driver or copied vendor implementation is bundled.
See docs/t314-release-notes.md for the exact unsupported product/authentication
boundaries. Brand provenance is separate in assets/domestic-icon-ledger.json.
