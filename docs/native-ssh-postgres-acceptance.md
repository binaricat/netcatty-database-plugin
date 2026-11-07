# Real PostgreSQL through native SSH: scoped acceptance

2026-11-07. The coordinating worker verified these flows in Netcatty's actual
native SSH terminal against a real PostgreSQL **17.6** service. This is the
user-authorized non-Docker local-host lane, not a simulated database or plugin
connection UI.

## Verified

- `psql` connects with `sslmode=verify-full`, the test certificate trust anchor and
  exact `127.0.0.1` identity, using a runtime-only password file.
- Real `public.netcatty_smoke` CREATE TABLE and UPSERT succeed; label
  `real-ssh-real-postgres` and a NULL value are read back.
- A prepared parameter query returns the expected label.
- Non-TLS access is refused.
- The independent Node harness `scripts/postgres-local-protocol.ts` passes its
  normal read, invalid-password and untrusted-certificate modes. Its normal lane
  uses the plugin's actual SCRAM startup and bounded read modules, verifies
  TLS **1.3**, and checks the expected label and NULL. Negative tests do not
  qualify successful database access.

## What this does not establish

The Node harness implements standard PostgreSQL SSLRequest-to-TLS upgrade using
Node's socket APIs. Current main public plugin `network.connect` cannot perform
that upgrade. The harness is not shipped as a native helper, invoked by the plugin
or used to bypass endpoint policy. Its success is **independent protocol-module
integration evidence**, not proof that the database plugin connects to PostgreSQL.

Native SSH terminal commands likewise do not establish automatic host database
discovery, a plugin database tunnel, arbitrary plugin SQL, query cancellation,
Docker acceptance or near-complete DBX parity. Both lanes must remain separate
from future main-broker and installed-plugin acceptance.

## Evidence

Evidence is outside the repository under `database-parity-evidence/full-main-round1/`:

- `full-app-real-ssh-postgres.mp4`
- `netcatty-real-ssh-postgres-success.jpg`
- `netcatty-postgres-plaintext-rejected.jpg`

The recording documents the real terminal PostgreSQL flow. Do not assume it also
contains every later Node harness mode without checking the captured frames.
Runtime password, private keys and TLS key material are not report artifacts.
