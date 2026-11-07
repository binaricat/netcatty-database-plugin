# MySQL / MariaDB classic protocol foundation

`mysqlProtocol.ts` implements bounded 3-byte-length / sequence packet framing,
modern V10 greeting parsing, and redacted Protocol41 ERR parsing. It neither
opens sockets nor sends authentication. Unknown auth plugin names are data, not
permission to select weaker authentication. `tlsAdvertised` is only the server's
SSL capability bit, not evidence of a TLS session.

The decoder checks fragments, sequence wraparound and exchange budgets, refuses
16 MiB continuation/compression, and clears internal owned bytes when consumed or
failed. Returned packets and challenge bytes are independent caller-owned copies;
caller input is not mutated. ERR server text is never returned or decoded.

Nine unit tests use fabricated protocol data. There is no real MySQL/MariaDB
compatibility or authentication evidence. Main's stream transport starts TCP or
TLS immediately; it does not expose MySQL's greeting → SSLRequest → TLS upgrade.
This implementation does not weaken that policy, send credentials over plaintext,
or claim a production driver. The historical plugin used an experimental host's
`context.database.openTcp`; that RPC is absent in the requested main SDK. DBX uses
`mysql_async`, which is not available in the plugin's browser runtime.

A subsequent pure TLS-preconditioned fast-auth slice exists in `mysqlAuth.ts`; see `mysql-auth-boundaries.md`. Its five offline tests do not change the absence of real server, full-auth, TLS upgrade or query qualification.
