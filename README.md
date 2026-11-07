# Netcatty Database

An independent, GPL-3.0-or-later, host-rendered Netcatty database workbench.
Version 0.1.0-alpha.1 is an experimental source snapshot with host-owned SQLite
fixtures and optional read-only PostgreSQL/MySQL TCP sessions. Domestic profiles
select explicit product variants; all domestic vendors are NOT_VENDOR_QUALIFIED.
This is not a general-purpose database client or vendor-driver parity release.

## Reproduce locally

Node >=24.19 and npm are required. From an independent checkout of this repository,
run the commands below. Internal Netcatty SDK, contract and CLI packages are pinned
local tarballs containing source, build files and preserved GPL-3.0-or-later
licenses; ordinary builds need no sibling checkout or SDK refresh. Public npm
dependencies require network access or a populated cache. A prior empty-cache
offline install returned ENOTCACHED; a clean offline install is not established.
`npm test` runs plugin unit tests only; `npm run pack` includes `npm run build`.

```sh
npm ci --ignore-scripts
npm run lint
npm test
npm run pack
npm run validate
```

The build produces `dist/netcatty-database-0.1.0-alpha.1.ncpkg` and `SHA256SUMS`.
Installation and database runtime require the matching development host on
`feat/plugin-database-foundation`, recorded by T314 at commit
`1cfa14b808bcff813676c0e41c8ea522149b76dd`. Those host changes remain local and
are not supplied by this repository. No compatible released Netcatty version has
been established. The manifest requires API `>=0.1.0-internal.1 <0.2.0` and
`views.host-drawn`, `views.vault-pages`, `views.modals`, `metadata.brand-icon`;
its Netcatty `>=0.0.0` field alone does not establish runtime compatibility.
Older hosts may reject this package or extended domestic-variant requests.

In that paired host, import the built file using Settings > Plugins. Database
features are negotiated separately and default off; enable
`NETCATTY_EXPERIMENTAL_DATABASE=1` only for deliberate development acceptance.
Without the experiment, database controls remain unavailable.

Open the Database Vault page and choose **New Connection > SQLite > Next**.
The connection flow uses the host's app-wide contributed modal (`views.modals`),
with a full-window dimmer, Escape/close, focus restoration and retained work on
backdrop clicks. It requires the paired host supporting this feature. Engine
marks use bounded static PNGs through `metadata.brand-icon`. PostgreSQL/MySQL
TCP sessions additionally require negotiated `database.tcp.v1` and permissions.
The modal is opened from its workbench so the existing owner retains
connection/draft lifecycle; it is hidden from unrelated palette contexts.
Use the synthetic memory database or **File Path > Host-selected SQLite file**.
The M2 Linux chooser still accepts only regular rollback-mode `.sqlite`/`.db`
fixtures with an ordinary `notes` table under its fixed M2 allowlist; no links
or sidecars. The paired M3b host additionally admits synthetic multi-table files
under its fixed M3b allowlist with the same identity and readonly gates. Its
`commerce.sqlite` fixture has four tables and `order_totals`. These allowlists
are host development fixtures, not configurable general user-file setup. Later
optional WAL gates are described below; the baseline chooser still rejects WAL.
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

## AI SQL assistance (unexecuted drafts)

The secondary **AI SQL assistant** uses the existing host-selected model through
optional `ai.model-invocation` / `ai.invoke`. Hosts without that feature show
**Unavailable**; permission denial, missing model and provider failures show a
localized unavailable message. No mock button or fallback provider is shipped.
Configure/select the model in Netcatty itself; the plugin has no provider settings
and receives only opaque chat/turn handles, a model display label and text events.
The paired host must include the Gate D validator update for optional AI features;
older validators may reject this package. A negotiated feature is not a guarantee that a model is configured: availability
and permission are checked when you click **Run assistance**.

Choose **generate / explain / optimize / fix**, enter a request, then click
**Run assistance**. The prompt shares connected SQLite schema metadata (all exposed
tables/views and columns), the connection display label, up to 4,000 characters of
current editor SQL and 1,500 characters of your request. It never includes result
rows, parameters, errors, saved connection objects, secretRefs or credentials.
Do not put secrets in free-form labels, SQL or requests. The JSON envelope is
marked untrusted and limited to 12,000 UTF-8 bytes; an oversized schema is rejected.

Text streams into **Unexecuted AI draft**, capped at 8 KiB to fit the host UI.
**Stop**, closing the panel, changing query tabs, disconnecting and unmounting
cancel/release the chat and discard late replies. Tool events are rejected.
**Insert draft into editor** is an explicit replacement of editor text, clears
parameters and old results, and does not execute SQL. It is disabled for partial
stopped/failed output. Output may contain explanations or Markdown; review/edit it
and supply any needed parameters before the existing **Run read query** or
**Review write** actions. Those actions submit only the current editor SQL.
File writes remain unavailable. No autonomous tools or SQL execution are added.

Gate D verifies deterministic streaming, cancellation, errors, insertion without
execution, English/zh-CN labels and real host boundaries. Real inference acceptance
is `SKIPPED_NO_PROVIDER`: no configured host model was available in the task's
native profiles. This ships the wired live-or-unavailable path with documented
residuals, not a claim of successful real-provider or native-provider QA.

For current TCP/profile limits see the catalog below and
[profile notes](docs/t314-release-notes.md). Earlier gate acceptance and residuals
are recorded in [qualification](docs/qualification.md); asset and SDK origins are
in [provenance](docs/provenance.md).

## Host language

Current workbench controls follow `context.environment.locale` at mount and on
host environment changes: `zh-CN` selects Simplified Chinese; English and other
host locales use English. Change language in Netcatty Settings; the plugin has no
separate switch and does not use the OS input method or browser language.
Connection names, schema identifiers, SQL, parameters and result values remain
unchanged. Switching language preserves the active session, tabs and edits.
The string map in `src/i18n.ts` is original plugin-owned copy.

Host diagnostics are retained verbatim beneath a localized error introduction.
The manifest's permission reasons are bilingual because the current contract
accepts only plain strings there. Host security dialogs and native file chooser
text belong to the host. This covers current controls, not full product i18n or
OS IME candidate windows.

Additional React/remote-DOM regressions require the paired host checkout and its
installed test dependencies. They run the existing English scenarios, Chinese
controls and live language switching, plus the real allowlisted commerce fixture
with injected chooser/approval (not native GUI):

```sh
NETCATTY_HOST_ROOT=/path/to/matching-host npm run test:react
```

The harness also requires `commerce.sqlite` and the other disposable fixtures at
the paired host's fixed development allowlist paths. Setting NETCATTY_HOST_ROOT
does not relocate those fixtures. This is a maintainer acceptance lane, not a
portable checkout-only test command. Native harnesses likewise require the paired
host, prepared fixtures and platform tools; they are outside `npm test`. Output
defaults to `dist/react-regression/`; `NETCATTY_REACT_EVIDENCE` overrides it.

### Synthetic tunnel probe (historical synthetic lane)

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

At the synthetic-probe milestone, live qualification was **BLOCKED** by missing
Docker/server fixtures; no disposable SSH credentials were looked up or used in
that lane. The later prepared live SSH-to-PostgreSQL fixture lane is described
below. Synthetic React and host tests alone are not live or native SSH evidence.

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

### Gate C fixture file identity

Paired Linux hosts can advertise `database.sqlite-fd-identity.fixture.v1` under
the existing default-off database experiment. The host holds and verifies file
descriptors and fingerprints for the same allowlisted disposable M2/M3b files;
the plugin still supplies no paths. File databases remain read-only and WAL is
rejected, including WAL/SHM/journal sidecars. This does not add a live WAL reader,
checkpoint/recovery, general user-file admission or real AI. Native-call content
races and SHM side-effect exclusion require further host qualification.

Linux 宿主可在默认关闭的数据库实验下公布
`database.sqlite-fd-identity.fixture.v1`。宿主持有并验证限定测试目录中的文件描述符
和内容指纹，插件仍不提供路径。文件连接仍为只读，WAL 及其附属文件仍被拒绝。
本阶段不支持实时 WAL 读取、检查点、恢复、任意用户文件；AI 辅助参见上文 Gate D。原生调用内部的
内容竞争及 SHM 无副作用保证仍待后续验证。

## Database catalog and TCP sessions

The picker uses the reviewed DBX-inspired registry in `src/driverRegistry.ts`, checked against the host contract registry. Search and categories include SQLite, PostgreSQL, MySQL, MariaDB, GoldenDB and domestic profiles. Protocol aliases are distinct from vendor-qualified drivers. Unpackaged engines collect settings but Test/Connect fail closed with “Driver not packaged”.

New hosts can negotiate `database.tcp.v1` for temporary, read-only host-owned PostgreSQL/MySQL TCP sessions. Non-loopback requires verified TLS; passwords are session-only and TCP settings are not persisted. Queries use anonymous `?` bindings. SQLite saved-connection and B–J fixture safeguards are retained. PostgreSQL is tested against a disposable loopback fixture; MySQL's real fixture qualification remains skipped in the recorded acceptance because local server binaries and offline packages were absent. See the host's `docs/plugin-platform/database-tcp.md` for supported authentication, SQL limits and lifecycle.

All domestic profiles, including protocol aliases, are NOT_VENDOR_QUALIFIED;
base PostgreSQL/MySQL fixture results do not qualify vendor servers. GoldenDB
uses a MySQL endpoint. openGauss and Vastbase G100 accept only PG-compatible mode;
GaussDB DWS uses port 8000 and GaussDB for MySQL uses its separate MySQL route.
Kingbase PG uses sys_catalog metadata. Gauss native SHA256/SM3 authentication is
unsupported; do not downgrade server authentication. GaussDB native/M, Kingbase
Oracle, HighGo secure/national-crypto, Vastbase non-PG/E100 and GBase 8a/8s/8c
vendor drivers are unpackaged and refuse before networking. See
[profile notes](docs/t314-release-notes.md).

## Brand sources and publication scope

Engine marks are transparent, bare, brand-colored PNGs decoded through
`metadata.brand-icon`. Source/raster hashes, licenses and transformations are in
`assets/icon-ledger.json`, `assets/brand-icon-ledger.json` and
`assets/domestic-icon-ledger.json`. Simple Icons contributions are CC0; brand
rights remain with their owners. Firebird retains its explicit Apache-2.0
JetBrains header. UXDB, Dameng and Oracle use a host glyph.

The current publication scope explicitly includes plugin source, all existing
icons, original/intermediate brand sources and their repository history, with
all source and restriction notices retained. Seven domestic marks include nine
original/intermediate files and fourteen light/dark PNG paths; the build copies
all of them into the ncpkg. Six marks (GoldenDB, GaussDB, KingbaseES, HighGo,
Vastbase, GBase) originate from DBX; its root Apache-2.0 license covers only
contributions its contributors may license and grants no trademark rights.
Individual third-party artwork clearance is not established by that root license.
openGauss uses official artwork under the saved conditional personal, educational
and noncommercial brand policy, not an open license; artwork, color, proportion
and protection-space conditions apply.

The ledger's LOCAL_NONCOMMERCIAL_IDENTIFICATION_AUTHORIZED status records T314's
historical local noncommercial acceptance. The current explicit public-source
decision changes publication intent, not third-party permission:
NOT_CLEARED_FOR_GENERAL_DISTRIBUTION remains accurate. No blanket GPL, Apache,
commercial or unrestricted brand redistribution permission is claimed, and no
vendor endorsement is implied. See NOTICE, `licenses/domestic-brands.txt` and the
full ledger for sources, transformations and restrictions.
