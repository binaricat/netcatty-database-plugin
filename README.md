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

Open the Database Vault page and choose **New Connection > SQLite > Next**.
Use the synthetic memory database or **File Path > Host-selected SQLite file**.
The M2 Linux chooser still accepts only regular rollback-mode `.sqlite`/`.db`
fixtures with an ordinary `notes` table under
`/workspace/agent-tools/database/m2-chooser/fixtures/`; no links or sidecars.
The paired M3b host additionally admits synthetic multi-table files under
`/workspace/agent-tools/database/m3b-multitable/fixtures/` with the same identity
and readonly gates. `commerce.sqlite` there has four tables and `order_totals`.
**Test** validates schema through the host. **Save & Connect** persists host-owned
metadata, then opens the schema tree and SQL editor/results workspace. Select a
table or view for readonly **Structure** (columns/type/nullable/primary key),
switch to **Data** to run its SELECT, or use **New Query**. The tree has separate
Tables/Views groups, expansion controls and object search. View nullability is
shown as Unknown; schema editing and DDL/index/default inspection are unavailable.
A saved connection can be reopened
from the sidebar after close or restart; memory data starts fresh each time.
Older hosts retain **Connect without saving** when persistence is unavailable.

The host rechecks source ownership, permission and recorded file identity on
reopen. Changed files require selecting and saving again. File writes are
unavailable. Memory **Review write** requires exact native SQL/parameter review
on every call. **Cancel / close** terminates the worker. Reads retain the
100-row / 96 KiB / 3-second host budgets; the rendered preview shows at most
20 rows, 8 columns and 256 characters per cell to fit host remote DOM limits.
Connections are filtered and paged in groups of 20; host filtering up to 40 matches.

**Advanced > Load permitted hosts** requests `vault.metadata` and exposes only labels,
SSH addresses/usernames and metadata capability flags. A selected `hostId` is
context metadata only; no tunnel, terminal or remote database opens. **Save
password** is a synthetic credential-storage test, not SQLite encryption. The
host requires `secrets` permission and an OS-backed keychain; it returns only a
`secretRef`. The input is cleared when save is attempted, including failures.
Connection metadata mutations require `storage` permission. No real credentials
or user databases are qualified by this release.

The secondary **AI SQL assistant / mock only** panel emits one local unexecuted
example. The manifest requests no AI feature or permission, and the workbench
never calls a model. The existing stream helper remains covered by mock tests.

PostgreSQL and MySQL are named roadmap targets with icons, not active drivers.
See docs/architecture.md, docs/qualification.md and docs/provenance.md.
