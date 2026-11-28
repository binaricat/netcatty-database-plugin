# T303 isolated native UI smoke

Run from this plugin repository on the provisioned Linux box. All dependencies
are already local. No install/fetch, production profile, provider, real account,
shared browser or existing 5173/4224 service is used. `capture.mjs` refines the
known t302 native install/permission/chooser/closed-shadow capture flow; the
Playwright helper imports come from the pre-existing local smoke harness.

## Setup / reset

`python3 tests/native/seed.py` is idempotent. `python3 tests/native/seed.py --reset`
resets only `t303-commerce.sqlite` in the host's existing m3b allowlist. It never
changes the allowlist or old commerce files. `--wal` keeps a committed synthetic
WAL connection idle until SIGTERM. `--reset --wal` resets that dedicated WAL
fixture. Advisory locks reject reset while this harness owns the fixture.
Data includes customers/orders/products, a view, long Chinese object names,
NULL, empty strings, 150 rows and long text. There are no user credentials.

## Build current sources offline

```sh
# Run in ../netcatty-database-host
npm run build
unshare -Urn node node_modules/electron-builder/cli.js \
  --config electron-builder.config.cjs --dir --publish=never \
  --config.npmRebuild=false --config.electronDist=node_modules/electron/dist \
  --config.directories.output=/workspace/agent-tools/database/t303-native-ui-polish/after-package
# Back in this plugin repository
npm run lint
npm test
npm run pack
NETCATTY_REACT_EVIDENCE=/workspace/agent-tools/database/t303-native-ui-polish/react-final node scripts/ui-regression.mjs
```

## Native run

```sh
node tests/native/prepare.mjs \
  /workspace/agent-tools/database/t303-native-ui-polish/after-final \
  /workspace/agent-tools/database/t303-native-ui-polish/after-package/linux-unpacked
unshare -Urn xvfb-run -a -s '-screen 0 1600x1100x24' bash tests/native/run.sh \
  /workspace/agent-tools/database/t303-native-ui-polish/after-final \
  /workspace/agent-tools/database/t303-native-ui-polish/after-package/linux-unpacked/netcatty
```

Preparation compares the packaged renderer and included main/domain sources
against current files, rebuilds the plugin independently and compares its bundle,
and validates package content against staging. No stale renderer is accepted.
Each run uses a new profile and fresh home/config/cache directories scoped to the
evidence directory; restart reuses only that run's profile. Electron receives a
small explicit environment, no inherited credentials or session bus. The network
namespace has only its own loopback. No web port is opened. Native file dialogs
are driven on this run's Xvfb display. Main-window identity and actual viewport
size are asserted (1440×1000, 1280×800, supported minimum-width 1100×760).

Missing feature UI is a failure. The runner covers native import/enable and
permission decisions, file chooser, Test/save, schema/query, stable WAL,
NULL/empty values, truncation, errors/recovery, English/light and Chinese/dark,
modal keyboard focus/Escape, close/reopen and full application restart. It never
calls a provider: actual AI is `SKIPPED_NO_PROVIDER`. Synthetic secret-store
failure and AI insert-only regressions are covered by the separate React lane.
The host's unavailable-credential-protection toast is captured before dismissing
it with its native close button; no secret-store success is claimed.

Generated PNGs, layout measurements, manifests and hashes live in the supplied
output directory. Inspect the PNGs; a green driver is insufficient visual review.
The shell trap stops only its own WM and idle WAL process; Electron closes in
`finally`. No shared service is killed. Reset only after closing all smoke apps.
