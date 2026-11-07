# Redis browser integration and qualification

The plugin now routes Host connections → Redis workbench, or an explicitly selected host → Inspect Redis. Host metadata is display context, not a tunnel, database discovery or network grant. TLS endpoints are extracted from actual package `network.stream` resource declarations; an optional `network.byte-streams` feature does not itself grant a destination. The production package deliberately declares no destination until a real authorized fixture is supplied.

Implemented: explicit AUTH/PING connection, INFO server, SCAN, TYPE/TTL/PTTL, GET, bounded LRANGE/HSCAN/SSCAN/ZSCAN; binary-preserving key/value data and hex fallback; 20-item local display pages and 4000-character fragments; cancellation, late-connect disposal, stale-result rejection and closed-session status. Password state is cleared on connect, no automatic network requests or secret storage. No redirect, cluster following, writes, retries or implicit reconnect.

COUNT remains a hint. The latest service accepts the entire returned scan page up to 1000 logical members and 96 KiB serialized browser state, rather than incorrectly rejecting common compact collections merely because they exceed COUNT. Beyond the budget, it refuses the page without dropping keys or advancing the last successful cursor. A 120-key injected page is exercised through all six local 20-key pages; model checks also cover 512 short keys/members. A real Redis service must still validate this behavior.

## Actual application evidence

Installed alpha.11 in full unmodified main `4a55492c17c3c792fbda4afc08d993f4165ca930`, package SHA256 `04eae8b4228913e4a03abf3082721b9f6d2c050fe294bdf1638860007829ddc3`. Independent screenshots in `database-parity-evidence/full-main-round1`:
- `redis-host-entry.jpg`: real host-connections page with Redis entry.
- `redis-unconfigured-final.jpg`: real Redis page, truthful Not connected / no declared endpoint. No credentials form or connection attempt is presented in this state.

These are **not Redis connection, Docker, SSH or database probing success evidence**. No new Redis-specific video was recorded at this checkpoint. Alpha.11 preceded the latest complete-scan-page improvement, which is separately covered by deterministic tests pending a new package run.

## Deterministic evidence

`scripts/redis-ui-regression.mjs` uses main's real SDK remote-DOM policy/replay and the plugin's actual Redis codec/session/browser, but injects network byte transport. It validates connection/credential clearing, INFO, scan/selection, local paging, oversized-page retention and disconnect. It is not native connected-state, TLS certificate, host permission or real-server acceptance.

The standard main UI regression also exercises the Chinese unconfigured route. Unit tests cover configuration, protocol, session, browser and controller boundaries. Do not include these as completed DBX connectivity.

## Still required

Supported local Docker in this dot environment; an authorized, production-permitted reachable TLS endpoint with valid trust/hostname and safe test credentials; exact endpoint declaration and normal host permission; actual host selection, real service response, schema/key reads, cancellation/expiry/reconnect and failure cases recorded in full Netcatty. No localhost alias, proxy or host policy override may be used to manufacture acceptance.
