# Redis TLS transport: capability and acceptance boundaries

Read-only audit of Netcatty main `4a55492`. This document does not add permissions, endpoints, host configuration or a network connection. The independently developed RESP2 codec/session mock tests are not evidence of a real Redis service connection.

## What main can support

`context.network.connect({endpoint}, cancellationToken?)` yields a `PluginByteConnection`: endpoint, readable/writable byte streams, `close()` and disposal. A plugin-owned RESP2 driver can use a **verified TLS connection from its first byte** for Redis AUTH, PING, SELECT and bounded read commands (for example SCAN, TYPE, GET and TTL). Redis supports direct TLS, so no STARTTLS upgrade is needed. Command availability is additionally constrained by Redis ACLs; PING denial does not prove every authorized database command is unavailable. Redis cluster MOVED/ASK redirection, Sentinel discovery and reconnection must not silently change endpoints: every destination needs its own declaration, authorization and TLS validation. Neither this audit nor existing codec tests implement or qualify those features.

Sources: `packages/plugin-sdk/src/index.ts:671–674,702–709,757–773`; generated `ByteStreamConnectRequest` at contract lines 88–100; `electron/plugins/byteStreamBroker.cjs:93–184`.

## Package declaration and user permission

A transport-enabled package must require feature `network.byte-streams` and declare resource-scoped `network.stream` permission with each complete exact endpoint. Recommended optional permission shape (illustrative only, **not an approved or working endpoint**):

```json
{
  "features": {"required": ["network.byte-streams"]},
  "permissions": {"optional": [{
    "permission": "network.stream",
    "resources": ["tls://redis-test.example.invalid:6380"],
    "reason": "Connect to the explicitly prepared Redis TLS test service."
  }]}
}
```

This is added alongside existing plugin features/permissions, not a replacement manifest. Bare `network.stream`, wildcards, wildcard hosts, paths, userinfo, query strings and unspecified ports are invalid. The package declaration is not itself a user grant; actual connection invokes the host permission engine for the canonical exact endpoint. Endpoint choice cannot be expanded by a form field or discovery result.

Sources: `packages/plugin-cli/src/manifest.ts:372–374`; `packages/plugin-cli/src/byteStreams.test.ts`; `examples/plugins/database-minimal/netcatty.plugin.json`; `electron/plugins/permissionResources.cjs:66,91,118`; `byteStreamEndpoint.cjs:7–34`.

## Hosts, DNS and local targets

Selecting a Netcatty saved host or reading hostname metadata does **not** grant a database socket or establish Redis availability. A saved SSH port is not a Redis port; a requested SSH connection is not a database tunnel. A metadata hostname can be a proposed target only after explicit database endpoint selection, package declaration, host authorization and TLS validation. It must not trigger arbitrary port scans.

The broker validates **all** DNS answers and pins one literal address. It does not re-resolve, follow redirects, discover proxies or reconnect automatically. Production rejects loopback, link-local, multicast/unspecified and obscuring tunnel/compatible address ranges identified by `isLocalControlAddress`, plus application control endpoints. Ordinary private LAN addresses are not categorically rejected by this helper, but are still subject to exact permissions, reachability and application-control checks.

A host test harness has a narrowly scoped `testLocalEndpoints` option. It is not a plugin setting or an authorized production bypass. Do not modify host security, add an unauthenticated listener, expose a service publicly or enable that exception to get a green screenshot.

Sources: `byteStreamBroker.cjs:24–25,127–146`; `byteStreamEndpoint.cjs:36–57`; broker tests for mixed DNS answers/local/control peers.

## TLS and authentication

The broker uses `rejectUnauthorized: true`, minimum TLS 1.2, DNS SNI and hostname/IP certificate checking against the original requested target. It also checks `socket.authorized`. The public connect request accepts only `endpoint`: no plugin CA override, client certificate, `rejectUnauthorized:false`, proxy or STARTTLS option is exposed here. A server requiring client-certificate authentication cannot be treated as supported by this request shape without a separate supported host capability. A valid certificate trusted by the running host with a matching target name/IP is needed for the present path.

`network.credential-lease` applies to the separately exposed HTTP authorization path; byte-stream connect has no credential-lease or AUTH substitution field. For a plugin-owned RESP2 AUTH, the explicitly supplied username/password therefore pass through plugin memory and encoded TLS bytes. Do not claim credentials never reach the plugin. Keep them session-only: no automatic storage, saved connection secret field, console output, transcript, screenshots, raw AUTH command or server-error echo. Best-effort clear owned byte arrays after writes; JavaScript strings cannot be guaranteed zeroized. A password redaction policy and conservative error messages are required. Never auto-retry credentials, fall back to cleartext, downgrade Redis authentication or persist secrets merely because a read failed. Future secret storage needs its own authorized broker design.

Sources: `byteStreamBroker.cjs:151–176`; generated `ByteStreamConnectRequest` versus `PluginNetworkRequest`; SDK `PluginCredentialBroker` and `PluginNetworkClient`.

## Stream lifecycle and budgets

Current host limits are 4 connections/runtime, 64 total, 64 KiB chunks and buffer/window, 8 MiB combined connection bytes, 10-second connect timeout, 30-second idle timeout and 120-second lifetime. These are not an unlimited persistent database connection. The session must surface expiry/EOF/errors honestly and require an explicit later reconnect rather than retrying after uncertain writes or credentials.

Process each read chunk before requesting another: the next read returns receive credit. EOF is `null`. Await writes, split frames into at most 64 KiB writes, and serialize pending reads/writes. Host ownership/revocation checks continue on operations; cancellation, runtime teardown and permission revocation close streams. Close/dispose on every success-abandonment, error, cancellation and late-connect path. Codec budgets (256 KiB frame, 96 KiB result, 10000 members, depth 16) are separate stricter parsing safeguards, not replacements for host byte/time quotas.

Sources: generated `ByteStreamLimits`; SDK `PluginReadableByteStream`/`PluginWritableByteStream`; `byteStreamBroker.cjs:190–285` and its revocation/cancellation tests.

## Real-service acceptance prerequisites and stages

1. Keep codec and injected transport tests labelled deterministic: fragmented RESP, bounded payloads, safe integer failures, AUTH redaction, serialization, denial, EOF, cancellation and disposal. No Docker or endpoint is needed for these tests.
2. Prepare an authorized disposable Redis TLS service, using the user-required local Docker fixture in this dot environment once supported Docker access exists (do not substitute a new remote task or environment without later user authorization). Need a real exact host:port, compatible trusted certificate, safe ACL credentials and sample data. Container existence alone is insufficient: verify TLS certificate/hostname, network route, firewall and allowed destination from the actual Netcatty host environment.
3. Include that endpoint in the package and obtain the required host permission without changing security settings. Production-loopback blocking means a locally published Docker port is not automatically usable by the installed plugin. A broker harness using an injected endpoint is separate component evidence, not full-App production acceptance.
4. Run real TLS AUTH/read flows, ACL denial/wrong password, certificate mismatch, disconnect, timeout, cancellation/reconnect and quota cases. Verify no credential/result leakage and accurate connected/authenticated status. Record screenshots/video from the actually installed plugin and label command/read scope.
5. Only then claim the specific Redis connection and tested read operations. Do not infer other drivers, cluster support, write CRUD, Docker multi-database qualification or DBX parity from one fixture.

An unavailable Docker daemon, missing approved routable endpoint or unconfigured trusted certificate is a **current test-environment prerequisite**, not proof that Redis transport is impossible in the plugin system. Exact static endpoint and stream lifetime restrictions are actual present host API boundaries. Neither category should be hidden by continued improvements to the unrelated SQLite workspace.
