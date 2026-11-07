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

## Host language

Current workbench controls follow `context.environment.locale` at mount and on
host environment changes: `zh-CN` selects Simplified Chinese; English and other
host locales use English. Change language in Netcatty Settings; the plugin has no
separate switch and does not use the OS input method or browser language.
Connection names, schema identifiers, SQL, parameters and result values remain
unchanged. Switching language preserves the active session, tabs and edits.
The string map in `src/i18n.ts` is original plugin-owned copy.

Host diagnostics are retained verbatim beneath a localized error introduction.
The manifest's two permission reasons are bilingual because the current contract
accepts only plain strings there. Host security dialogs and native file chooser
text belong to the host. This covers current controls, not full product i18n or
OS IME candidate windows.

Additional React/remote-DOM regressions require the paired host checkout and its
installed test dependencies. They run the existing English scenarios, Chinese
controls and live language switching, plus the real allowlisted commerce fixture
with injected chooser/approval (not native GUI):

```sh
NETCATTY_HOST_ROOT=/workspace/netcatty-database-host npm run test:react
```

The commerce fixture must exist at the host's already allowed
`/workspace/agent-tools/database/m3b-multitable/fixtures/commerce.sqlite` path.
Output defaults to `dist/react-regression/`; `NETCATTY_REACT_EVIDENCE` overrides it.

### Synthetic tunnel probe (live SSH + PostgreSQL blocked)

The optional `database.tunnel-test.synthetic.v1` capability adds **Test tunnel
(synthetic)** in Advanced. The host needs both `NETCATTY_EXPERIMENTAL_DATABASE=1`
and `NETCATTY_DATABASE_TUNNEL_SYNTHETIC=1`. Only a clearly labeled host-owned
synthetic row can run the recorded adapter. Ordinary existing hosts stay metadata
only, with the test button disabled. Selecting a row never connects.

A passing probe means an in-process fixture passed and closed. It opens no SSH or
PostgreSQL connection and cannot enable the PG/MySQL workbench. The host owns a
random disposable adapter credential in SecretStore; repeat requests contain
only host ID, revision and test ID, and results never include secret bytes. The
optional SQLite saved password remains a separate storage test, not SSH auth.

Live qualification is **BLOCKED**: Docker is unavailable, PostgreSQL server is
not installed (client only), and installation is not authorized. No disposable
SSH credentials were looked up or used. Next requires approval for a disposable
local PostgreSQL package or provision of a pre-seeded local fixture with a server
and task-owned SSH credentials. Synthetic React and host tests are not live or
native SSH evidence.

### Probe an existing host's database ports

With the host database experiment enabled, open New Connection > Next > Advanced,
then Load permitted hosts and select an already saved Netcatty host. If the host
negotiates `database.host-port-probe.v1`, **Probe common database ports** checks
5432 (PostgreSQL), 3306 (MySQL / MariaDB), 1433 (Microsoft SQL Server), 27017
(MongoDB), and 6379 (Redis). The host owns the hostname and port list; the plugin
sends only host ID, metadata revision and probe ID. Results show open, closed or
timeout with elapsed milliseconds. Cancel, changing selection, reload and close
invalidate pending results. English and zh-CN follow the Netcatty language.

These are direct TCP checks from Netcatty, without SSH. An open port does not
identify/authenticate a database, create a database session or establish a tunnel.
Ordinary saved hosts remain `metadata-only` with `tunnelAvailable: false`.
The synthetic tunnel test is separate. SQLite fixture-only file policy is unchanged.

`NETCATTY_TEST_PREPARED_DB_PROBE=1 npm run test:react` additionally checks a prepared
loopback PostgreSQL listener through real host RPC/TCP and writes English/Chinese
HTML evidence. Permission decisions and vault metadata are fixture seams; this
lane does not automate the native vault or permission windows. Without that flag,
the deterministic React lane uses explicitly mocked port statuses.


### Live SSH to PostgreSQL fixture test

With both host gates `NETCATTY_EXPERIMENTAL_DATABASE=1` and
`NETCATTY_DATABASE_LIVE_SSH_PG_FIXTURE=1`, Advanced can test the separate host-owned
loopback fixture when `database.host-live-ssh-pg.fixture.v1` is negotiated.
The host pins SSH `127.0.0.1:2222`, forwards only to PostgreSQL `127.0.0.1:5432`,
and requires authenticated `SELECT 1 = 1`. Credentials remain in host SecretStore;
a secure OS backend is required. The prepared fixture paths and pin are fixed in
the host adapter. This is a development fixture, not a production database driver.

The test closes its session before showing success. Selecting a host and probing
an open TCP port still do not connect a database; ordinary vault hosts and the
SQLite workbench retain their existing behavior. English and zh-CN status copy
identify the fixture-only result. To exercise the real host API in React evidence:

```sh
NETCATTY_TEST_LIVE_SSH_PG=1 npm run test:react
```

That test lane uses an explicitly marked AES-GCM SecretStore backend and injected
permission decisions, with the actual prepared SSH and PostgreSQL services.
Native safeStorage and permission dialogs are separate integration checks.
