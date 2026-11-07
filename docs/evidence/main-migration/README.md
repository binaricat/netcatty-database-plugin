# Native main-component evidence

Host source: binaricat/netcatty `main` at
`4a55492c17c3c792fbda4afc08d993f4165ca930`, unmodified.
Plugin package SHA-256:
`fc7587884c78a8a4af336003be467766e4e0bf06d6a935f285e291a001b0faa5`.

The recording is 253.32 seconds, captured from the actual Electron BrowserWindow
at 1180 × 784 content pixels on the controlled Linux desktop. Actual frame
UTC timestamps span 2026-11-07 14:11:32.673 through 14:15:45.967. Four frames per
second were requested; the MP4 preserves actual intervals. No image generation,
mock screenshot or time compression is used.

The fixture installs the real package through main's actual PluginManager and
runs the real sandboxed browser plugin. The renderer uses main's actual
PluginHostDrawnPage and remote-DOM policies. Data comes from the actual SQL.js
SQLite engine in the plugin. The main service has a fixture permission-decision
callback limited to views/storage; no native authorization dialog is qualified.

Observed: new connection, SQLite Test, Save & Connect, schema, bound notes read,
orders structure/data, NULL versus empty string, rejected DELETE, successful
aggregate recovery with Unicode, Close connection, and reopening saved metadata.

This is **not** the full Netcatty shell/Settings installation flow, a real model
run, Docker/TCP database acceptance, arbitrary-file acceptance or cross-platform
native qualification. The initial development picker failure was fixed before
this successful recording. See `docs/dbx-parity.md` for remaining work.

The three PNGs are independent actual screenshots. The MP4 is an independent
recording, not an embedded presentation. A fuller local bundle also contains ten
named screenshots, recording timestamps, scope metadata and verification logs.
