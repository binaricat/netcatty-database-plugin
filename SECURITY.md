# Security scope

This experimental snapshot is not qualified for production databases. A matching
T314 development host (see README) may expose synthetic memory, allowlisted
read-only SQLite files and optional read-only PostgreSQL/MySQL TCP sessions.
Database features default off and require negotiation and permissions. Host
source ownership, TLS/authentication, lifecycle and query budgets remain
authoritative. Domestic vendors are NOT_VENDOR_QUALIFIED; native Gauss SHA256/SM3
authentication and unpackaged product variants remain unsupported.

Report issues in the host service, authorizer, owner binding, process lifecycle,
package validation or AI context boundary to the maintainers with synthetic
reproduction data. Do not include real credentials, query results or private data.
AI drafts require explicit insertion and query execution; real-provider acceptance
remains SKIPPED_NO_PROVIDER. Native OS keychain success is not established by
synthetic credential-store tests. No plugin should request advanced Node access
to work around an unavailable API.
