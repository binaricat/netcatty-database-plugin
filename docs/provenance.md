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
