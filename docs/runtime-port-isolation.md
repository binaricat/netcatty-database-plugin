# Native runtime port-closure investigation

Host baseline: unchanged Netcatty main `4a55492`.
Plugin: alpha.18, full native Electron application, 2026-11-07 UTC.

## Observed

- At 17:11:44.861 the runtime reported `Plugin message port closed`.
- After preserving state and toggling the plugin off/on, activation at
  17:21:14.541 failed again at 17:22:40.036 (approximately 86 seconds).
  Only the plugin home page had been opened; no database was connected.
- The plugin remained enabled. The runtime renderer disappeared after failure.
  This does not prove that renderer termination came first: the host's
  `#handleExit` itself destroys the runtime window.
- Same-desktop 5-second process/memory sampling showed the runtime at about
  100–105 MiB RSS and 3–5 GiB system memory available. This is not an Electron
  working-set measurement and does not establish an OOM cause.
- Console also contains icon-rasterization queue failures. Their timestamps
  were unavailable. Correlation is not causation.

## Source checks

`browserPluginRuntime.cjs` maps several first events to a shared exit path;
subsequent more-specific exit events can be lost after router teardown.
Normal explicit stop sets stopping state before closing the router. The
resource quota path disables the plugin and records a specific CPU/memory
error, unlike the observed still-enabled generic error. Request timeout only
rejects/cancels the request; it does not close the entire channel. Ordinary
listener exceptions are caught. Browser-side protocol/notification errors can
close the transport, but the present error does not identify one.

Main already retains the runtime/window/port; the browser module and transport
closure also retain the port. No proven garbage-collection defect has been
found. A heartbeat is not an acceptable substitute for diagnosis.

## Controls in progress

A minimal separately packaged diagnostic plugin displays one paragraph using
the same host React SDK, with no database, images, network or timers. The
actual database plugin was disabled, and the probe was enabled in the real
application at 17:28:29.741. It stayed running for 371 seconds with no last error. This weakens a generic fixed-idle failure hypothesis but does not identify the real plugin trigger. The diagnostic is not a
replacement database build or functional acceptance evidence.

No host main patch has been applied. An independently developed icon-queue
patch may subsequently be tested on a separate local host branch, with the
original baseline retained. It is not yet a demonstrated port-closure fix.

The unchanged host was then stopped normally and restarted with Electron logging
to a file. Alpha.20 remained running through over six minutes of native grid
delete/readback and CSV import/readback. No icon patch was applied. This single
recovery does not establish a fix; preserve the earlier reproducible failure.
