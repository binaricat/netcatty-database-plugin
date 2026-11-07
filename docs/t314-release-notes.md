# T314 local noncommercial build

Seven real product marks replace generic glyphs in the database picker. The
borderless grid, input-contained search icon and native transparent scrollbar
remain. Original brand colors and aspect ratios are retained; HighGo's black/orange
source has limited dark-theme contrast and is not recolored. All sources and
usage boundaries are in assets/domestic-icon-ledger.json and NOTICE. This local
test ncpkg is NOT_CLEARED_FOR_GENERAL_DISTRIBUTION; it is not a release license.

Driver profiles require selecting the exact product variant. DWS uses its own
default port, GaussDB for MySQL routes separately, Kingbase PG metadata uses
sys_catalog, and Vastbase/openGauss PG mode is checked before publishing a session.
Unknown variants and unsupported product editions refuse before networking.
Gauss-family native SHA256/SM3 authentication remains unavailable; no server
authentication, TLS or read-only protections are reduced. Every vendor profile is
NOT_VENDOR_QUALIFIED until tested against that vendor's actual server. GBase
8a/8s/8c drivers, native GaussDB/M mode, HighGo secure, Kingbase Oracle and other
Vastbase editions/modes remain explicitly unavailable. Use the matching T314 host;
older hosts reject the extended request instead of silently ignoring the variant.
