# Real Redis TLS codec/browser acceptance

2026-11-07. The coordinating worker ran the manual Node test in the **actual
Netcatty native SSH terminal** against official Redis **7.4.2**, built with TLS,
at the authorized loopback fixture `127.0.0.1:16479`. This is the approved
non-Docker test-host lane, not a production plugin connection.

## Verified real-service flows

`node --import tsx scripts/redis-local-protocol.ts` passed:

- CA-chain and exact IP identity verification, TLS **1.3**.
- Harness AUTH and PING; actual `redisProtocol` command encoding/RESP decoding.
- Actual `redisBrowser` INFO, SCAN, TYPE, GET, TTL and PTTL; proof string
  `netcatty:tls:proof = real-tls-redis`, with no expiry.
- `--bad-password`: exact WRONGPASS rejection, not generic network failure.
- `--reject-cert`: certificate-chain rejection, not connection refusal/timeout.

After the separately reviewed fixture seeding script ran, `--types` passed all
five data types (the original string plus the following browser reads):

| Type | Verified contents | Actual read pages |
| --- | --- | --- |
| Hash | `name=Netcatty TLS`, `status=verified`, `count=2` | 1 |
| List | `alpha`, `beta`, `gamma` in that order | 2, page size 2 |
| Set | `alpha`, `beta`, `gamma`, order independent | 1 |
| Sorted set | `alpha=1`, `beta=2.5`, `gamma=10` | 1 |

All four keys had TTL/PTTL `-1`. Hash/set/sorted-set reads used COUNT 1 but retained
complete server pages: Redis COUNT is a work hint, not a strict row limit. Cursor
termination and exact field/value/member/score contents were checked. Both
negative modes were rerun successfully after the multi-type test.

## Evidence and scope

Under `database-parity-evidence/full-main-round1/`:

- `netcatty-redis-types-live.jpg`
- `netcatty-redis-types-negatives.jpg`
- `full-app-redis-protocol.mp4`: 120 seconds, **3,308,913 bytes**; coordinating
  worker verified ffprobe metadata, full decode and the 105-second frame. It
  covers fixture seeding, five-type reads and negative checks.

The tested production modules are **redisProtocol and redisBrowser**. TLS sockets
and AUTH orchestration belong to the independent Node harness. **redisSession,
connectRedis, main's broker/permission flow and the installed Redis connection UI
are not covered.** In particular, connectRedis's loopback gate was neither
removed nor bypassed through a fake hostname. The output explicitly states
`redisSessionCovered:false` and `nativePluginConnected:false`.

The harness does not write test data; a separate, reviewed seed script only resets
its four named fixture keys. No production command allowlist was broadened, no
credential was embedded in reports, and no host TLS/endpoint policy was weakened.
This is real module integration evidence, not Docker qualification, native plugin
Redis connectivity, write CRUD/cluster support or completion of DBX parity.
