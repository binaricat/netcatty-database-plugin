# Full Netcatty main application validation

Local build 0.1.0-alpha.4, Netcatty main 4a55492c17c3c792fbda4afc08d993f4165ca930. This is not a release or a DBX parity completion claim.

The complete Electron application was started from its unchanged main checkout after rebuilding node-pty using the repository's installed electron-rebuild and a writable build HOME. A disposable XDG_CONFIG_HOME was used. Packages were imported through Settings > Plugins and enabled through the native UI. No fixture renderer, mock host, disabled sandbox, private view event, or additional X listener was used.

Verified in the full app:
- Redesigned home, sharp high-resolution SVG sources, semantic host/library/history icons.
- Top tab + > Database: New connection opens the real host-owned modal shell.
- Database catalog, SQLite details, Save & Connect, connected capsule, parameterized query returning two actual SQL.js rows.
- Plugin Host connections > Choose saved hosts invokes the real host-owned metadata picker. This isolated profile has no hosts, so the picker correctly reports No hosts found; cancel returns safely.

Native modal limitations: current public PluginViews SDK has no open/close-modal operation. Home and toolbar New Connection therefore retain their functional inline path, while the native route is exposed through Netcatty's own +/quick switcher. After connecting through the native route the user closes the outer modal using its X. The plugin does not forge host renderer events or change the host source. Native visibility prevents simultaneous inline overlays.

Evidence directory outside the repository: database-parity-evidence/full-main-round1. homepage-final.jpg, native-modal-final.jpg, native-details.jpg, full-query.jpg, host-selection.jpg. full-app-workbench.mp4 records the actual application workflow. full-app-flow.mp4 records installation/update debugging and is not a database acceptance recording.

Not verified: Docker SSH host, remote database discovery/authentication/query, real AI provider, or DBX feature parity. SQLite data is explicitly synthetic disposable in-memory data, not a Docker server. See local-docker-acceptance.md and ai-parity.md.
