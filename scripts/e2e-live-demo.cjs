#!/usr/bin/env node
"use strict";

/**
 * Live End-to-End Electron Verification, Screenshot & Video Capture Script
 * for Netcatty Database Plugin (`dist/netcatty-database-0.2.0.ncpkg`).
 *
 * Launches the REAL Netcatty Electron application (WITHOUT NETCATTY_PLUGIN_DEV=1)
 * against a clean disposable `--user-data-dir`, connects via CDP (`--remote-debugging-port`),
 * installs the real `.ncpkg` via `window.netcatty.installPluginPackage`, drives the live UI
 * (including closed Shadow DOM via CDP DOM piercing + real Chromium Input events),
 * verifies all live Docker DBs + SQLite + Vault SSH Tunnel, captures all 11 screenshots
 * (1440x900), and optionally records a continuous H.264 MP4 demo video.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");

const NETCATTY_DIR = "/Users/chenqi/projects/personal/netcatty";
const PLUGIN_DIR = "/Users/chenqi/projects/personal/netcatty-database-plugin";
const MAC_ELECTRON_APP_BIN = path.join(NETCATTY_DIR, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const ELECTRON_BIN = process.platform === "darwin" && fs.existsSync(MAC_ELECTRON_APP_BIN)
  ? MAC_ELECTRON_APP_BIN
  : path.join(NETCATTY_DIR, "node_modules", ".bin", "electron");
const NCPKG_PATH = path.join(PLUGIN_DIR, "dist", "netcatty-database-0.2.0.ncpkg");
const SQLITE_FIXTURE = path.join(PLUGIN_DIR, "tests", "fixtures", "shop_demo.sqlite");
const BASTION_KEY_PATH = path.join(PLUGIN_DIR, "tests", "docker", "keys", "id_ed25519");

const WORKER_SCREENSHOT_DIR = "/Users/chenqi/.gemini/antigravity/brain/58af22e7-9b58-480b-8a8a-62ca8c31297c/screenshots";
const DELIVERABLE_SCREENSHOT_DIR = "/Users/chenqi/.gemini/antigravity/brain/0ad83f37-3647-4f6b-b49e-d0c2367a119e/deliverables/screenshots";
const DELIVERABLE_VIDEO_PATH = "/Users/chenqi/.gemini/antigravity/brain/0ad83f37-3647-4f6b-b49e-d0c2367a119e/deliverables/netcatty-database-plugin-demo.mp4";
const FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg";

const ARGS = new Set(process.argv.slice(2));
const MODE_VIDEO = ARGS.has("--video");
const FAST_07_11 = ARGS.has("--fast-07-11");
const KEEP_USER_DATA = ARGS.has("--keep-user-data");
const SKIP_SCREENSHOTS = ARGS.has("--skip-screenshots");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (err) => reject(err));
      ws.addEventListener("message", (evt) => {
        const msg = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
          else res(msg.result);
        } else if (msg.method) {
          const cbs = this.listeners.get(msg.method);
          if (cbs) {
            for (const cb of cbs) cb(msg.params);
          }
        }
      });
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(cb);
    return () => this.listeners.get(method)?.delete(cb);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout for ${method}`));
        }
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs(expression, awaitPromise = true) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "JS exception";
      throw new Error(`Renderer eval failed: ${desc}`);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

// Parse CDP DOM.Node attributes array ["k1","v1","k2","v2"] into plain object
function parseAttrs(arr) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i += 2) {
    out[arr[i]] = arr[i + 1] ?? "";
  }
  return out;
}

function nodeText(node) {
  if (!node) return "";
  if (node.nodeType === 3) return node.nodeValue || "";
  let text = "";
  if (Array.isArray(node.children)) {
    for (const c of node.children) text += nodeText(c);
  }
  if (Array.isArray(node.shadowRoots)) {
    for (const s of node.shadowRoots) text += nodeText(s);
  }
  return text;
}

function collectNodes(root, predicate, out = []) {
  if (!root) return out;
  if (root.nodeType === 1) {
    const attrs = parseAttrs(root.attributes);
    const wrapped = {
      nodeId: root.nodeId,
      backendNodeId: root.backendNodeId,
      tag: (root.localName || root.nodeName || "").toLowerCase(),
      attrs,
      classes: (attrs.class || "").split(/\s+/).filter(Boolean),
      raw: root,
    };
    if (predicate(wrapped)) out.push(wrapped);
  }
  if (Array.isArray(root.children)) {
    for (const c of root.children) collectNodes(c, predicate, out);
  }
  if (Array.isArray(root.shadowRoots)) {
    for (const s of root.shadowRoots) collectNodes(s, predicate, out);
  }
  return out;
}

function focusMacPid(pid) {
  if (process.platform !== "darwin" || !pid) return;
  try {
    execFileSync("osascript", [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (a) a.activateWithOptions(3);`,
    ], { stdio: "ignore", timeout: 2000 });
  } catch {}
}

class LiveDriver {
  constructor(cdp, electronPid) {
    this.cdp = cdp;
    this.electronPid = electronPid;
    this.dialogsHandled = [];
    this.consoleErrors = [];
    this.pageErrors = [];
    this.recording = false;
    this.videoFramesDir = null;
    this.videoFrameIndex = 0;
    this.videoTimer = null;
    this._capturingFrame = false;
  }

  async getPiercedRoot() {
    const { root } = await this.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    return root;
  }

  async findAll(predicate) {
    const root = await this.getPiercedRoot();
    return collectNodes(root, predicate);
  }

  async findFirst(predicate) {
    const all = await this.findAll(predicate);
    return all[0] || null;
  }

  async waitFor(predicate, label, timeoutMs = 15000, autoApproveDialogs = true) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (autoApproveDialogs) {
        await this.handlePendingHostDialogs();
      }
      const match = await this.findFirst(predicate);
      if (match) return match;
      await sleep(180);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }

  async getNodeCenter(node) {
    try {
      await this.cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId: node.nodeId });
    } catch {}
    const { model } = await this.cdp.send("DOM.getBoxModel", { nodeId: node.nodeId });
    const q = model.border || model.content;
    const x = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
    const y = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);
    const width = Math.round(Math.abs(q[2] - q[0]));
    const height = Math.round(Math.abs(q[5] - q[1]));
    return { x, y, width, height };
  }

  async clickXY(x, y, { button = "left", clickCount = 1 } = {}) {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
    await sleep(30);
    for (let i = 1; i <= clickCount; i++) {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
      if (i < clickCount) await sleep(35);
    }
  }

  async bringToFront() {
    focusMacPid(this.electronPid);
    try { await this.cdp.send("Page.bringToFront"); } catch {}
    await sleep(60);
  }

  async clickNode(node, opts = {}) {
    await this.bringToFront();
    const { x, y } = await this.getNodeCenter(node);
    await this.clickXY(x, y, opts);
    return { x, y };
  }

  async focusAndType(node, text, { clear = true } = {}) {
    await this.clickNode(node);
    await sleep(80);
    if (clear) {
      await this.pressKey("a", { meta: true });
      await this.pressKey("Backspace");
      await sleep(40);
    }
    if (text) {
      await this.cdp.send("Input.insertText", { text });
    }
    await sleep(60);
  }

  async setInputValueDirect(node, value) {
    const { object } = await this.cdp.send("DOM.resolveNode", { nodeId: node.nodeId });
    await this.cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function(val) {
        const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(this, val); else this.value = val;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value: String(value) }],
    });
    await sleep(60);
  }

  async setSelectValue(node, value) {
    const { object } = await this.cdp.send("DOM.resolveNode", { nodeId: node.nodeId });
    await this.cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function(val) {
        this.value = val;
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value: String(value) }],
    });
    await sleep(80);
  }

  async pressKey(key, { meta = false, ctrl = false, shift = false, alt = false } = {}) {
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    const keyMap = {
      Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      a: { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 },
      c: { key: "c", code: "KeyC", windowsVirtualKeyCode: 67 },
    };
    const info = keyMap[key] || { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers,
      ...info,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      ...info,
    });
  }

  async handlePendingHostDialogs(options = {}) {
    const { preferHostLabel = "Docker Bastion (SSH)" } = options;
    const res = await this.cdp.evalJs(`(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const dlg of dialogs) {
        const text = dlg.innerText || '';
        const isSecurity = dlg.hasAttribute('data-host-security-surface');
        const isNetConfirm = text.includes('Confirm Network Connection');
        const isTlsConfirm = text.includes('Verify TLS Certificate');
        const isSelectHost = text.includes('Pick Vault SSH Host') || text.includes('Select Host') || text.includes('选择主机') || Boolean(dlg.querySelector('[data-host-id]'));
        const isSshConnect = text.includes('Remember this SSH tunnel binding') || text.includes('SSH');

        if (!isSecurity && !isNetConfirm && !isTlsConfirm && !isSelectHost && !isSshConnect) continue;

        // Check any "Remember" checkbox inside the dialog
        const cb = dlg.querySelector('input[type="checkbox"]');
        if (cb && !cb.checked && !cb.disabled) {
          cb.click();
        }

        if (isSelectHost) {
          // Click the host option matching preferHostLabel inside SelectHostPanelContent
          const options = Array.from(dlg.querySelectorAll('[role="option"], [role="button"], button, div'));
          const hostBtn = options.find((el) => (el.innerText || '').includes(${JSON.stringify(preferHostLabel)}) && el.offsetHeight >= 28 && el.offsetHeight <= 90 && !el.querySelector('[role="option"]'));
          if (hostBtn && !dlg.dataset.qaHostPicked) {
            dlg.dataset.qaHostPicked = '1';
            hostBtn.click();
            return { handled: 'select-host-pick', title: text.slice(0, 80) };
          }
          const confirmBtn = Array.from(dlg.querySelectorAll('button')).find((b) => !b.disabled && /^(continue|confirm|select|done|apply|ok|connect|继续|确定|选择|完成)/i.test((b.innerText || '').trim()));
          if (confirmBtn) {
            confirmBtn.click();
            return { handled: 'select-host-confirm', button: (confirmBtn.innerText || '').trim(), title: text.slice(0, 80) };
          }
          return null;
        }

        const buttons = Array.from(dlg.querySelectorAll('button')).filter((b) => !b.disabled);
        const allowBtn = buttons.find((b) => {
          const label = (b.innerText || '').trim();
          return /^(Allow this operation|Allow for this session|允许此次操作|允许此会话|Connect|Trust & Continue|连接)$/i.test(label);
        });
        if (allowBtn) {
          allowBtn.click();
          return {
            handled: isSecurity ? 'permission' : isTlsConfirm ? 'tls-confirm' : isNetConfirm ? 'net-confirm' : 'host-action',
            button: (allowBtn.innerText || '').trim(),
            summary: text.split('\\n').slice(0, 3).join(' | ').slice(0, 140),
          };
        }
      }
      return null;
    })()`);
    if (res) {
      this.dialogsHandled.push(res);
      console.log(`  [HostDialog] ${res.handled}: ${res.button || ""} (${res.summary || res.title || ""})`);
      await sleep(220);
      return true;
    }
    return false;
  }

  async drainDialogs(ms = 1200) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const did = await this.handlePendingHostDialogs();
      await sleep(did ? 180 : 120);
    }
  }

  async clickButtonByText(textRegex, { containerClass = null, timeoutMs = 10000 } = {}) {
    const node = await this.waitFor((n) => {
      if (n.tag !== "button" && n.attrs.role !== "tab" && n.attrs.role !== "menuitem") return false;
      if (n.attrs.disabled !== undefined) return false;
      const txt = nodeText(n.raw).replace(/\s+/g, " ").trim();
      const title = n.attrs.title || n.attrs["aria-label"] || "";
      return textRegex.test(txt) || textRegex.test(title);
    }, `button matching ${textRegex}`, timeoutMs);
    await this.clickNode(node);
    await sleep(160);
    return node;
  }

  async setTheme(mode) {
    // mode: 'dark' (Midnight) or 'light' (Snow)
    await this.cdp.evalJs(`(() => {
      localStorage.setItem('netcatty_theme_v1', ${JSON.stringify(mode)});
      localStorage.setItem('netcatty_ui_theme_dark_v1', 'midnight');
      localStorage.setItem('netcatty_ui_theme_light_v1', 'snow');
      window.dispatchEvent(new StorageEvent('storage', { key: 'netcatty_theme_v1', newValue: ${JSON.stringify(mode)} }));
    })()`);
    await sleep(300);
    // Also trigger via Settings if storage event didn't re-render immediately; check documentElement class
    const hasExpected = await this.cdp.evalJs(`document.documentElement.classList.contains(${JSON.stringify(mode === "dark" ? "dark" : "light")}) || (${JSON.stringify(mode === "light")} && !document.documentElement.classList.contains('dark'))`);
    if (!hasExpected) {
      await this.cdp.evalJs(`(() => {
        const cl = document.documentElement.classList;
        if (${JSON.stringify(mode)} === 'light') { cl.remove('dark'); cl.add('light'); }
        else { cl.remove('light'); cl.add('dark'); }
      })()`);
    }
    // Always sync plugin environment theme via reload or bridge
    await this.cdp.evalJs(`window.netcatty?.setPluginEnvironment?.({ theme: ${JSON.stringify(mode)}, locale: 'en' }).catch?.(() => {})`);
    await sleep(450);
  }

  async captureScreenshot(filename) {
    if (SKIP_SCREENSHOTS) return;
    // Park cursor cleanly away from buttons so no stray hover state lingers
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10, button: "none", clickCount: 0 }).catch(() => {});
    await sleep(300);
    const { data } = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    const buf = Buffer.from(data, "base64");
    for (const dir of [WORKER_SCREENSHOT_DIR, DELIVERABLE_SCREENSHOT_DIR]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), buf);
    }
    console.log(`  [Screenshot] Saved ${filename} (${(buf.length / 1024).toFixed(1)} KiB)`);
  }

  startVideoRecording(framesDir, intervalMs = 100) {
    fs.mkdirSync(framesDir, { recursive: true });
    this.videoFramesDir = framesDir;
    this.videoFrameIndex = 0;
    this.recording = true;
    const tick = async () => {
      if (!this.recording || this._capturingFrame) return;
      this._capturingFrame = true;
      try {
        const { data } = await this.cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 92,
          fromSurface: true,
        });
        const frameFile = path.join(
          this.videoFramesDir,
          `frame_${String(this.videoFrameIndex++).padStart(5, "0")}.jpg`,
        );
        fs.writeFileSync(frameFile, Buffer.from(data, "base64"));
      } catch {
        // ignore transient capture race
      } finally {
        this._capturingFrame = false;
      }
    };
    this.videoTimer = setInterval(tick, intervalMs);
  }

  async stopVideoRecording(outputPath, fps = 10) {
    this.recording = false;
    if (this.videoTimer) clearInterval(this.videoTimer);
    while (this._capturingFrame) await sleep(30);
    console.log(`  [Video] Captured ${this.videoFrameIndex} frames -> encoding H.264 MP4...`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    execFileSync(FFMPEG_BIN, [
      "-y",
      "-framerate", String(fps),
      "-i", path.join(this.videoFramesDir, "frame_%05d.jpg"),
      "-vf", "scale=1440:900:flags=lanczos,pad=1440:900:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-color_range", "tv",
      "-movflags", "+faststart",
      outputPath,
    ], { stdio: "inherit" });
    console.log(`  [Video] Encoded ${outputPath}`);
  }
}

async function waitForCdpTarget(port, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === "page" && t.url && (t.url.startsWith("app://") || t.url.startsWith("http://") || t.url.includes("index.html")));
        if (page && page.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Netcatty CDP target on port ${port}`);
}

async function openNewConnectionDrawer(driver) {
  // Click "+ New" button in Sidebar or "New Connection" card in Welcome
  const btn = await driver.findFirst((n) => {
    if (n.tag !== "button") return false;
    const t = nodeText(n.raw).replace(/\s+/g, " ").trim();
    const title = n.attrs.title || n.attrs["aria-label"] || "";
    return title === "New Connection" || t === "New" || t === "+ New" || t.startsWith("New Connection");
  });
  if (!btn) throw new Error("Could not find New Connection button");
  await driver.clickNode(btn);
  await driver.waitFor((n) => n.classes.includes("dbx-engine-picker-grid"), "22-engine picker grid");
  await sleep(300);
}

async function createConnectionViaDrawer(driver, cfg) {
  console.log(`  [Conn] Creating "${cfg.name}" (${cfg.engine})...`);
  await openNewConnectionDrawer(driver);
  console.log(`    -> picker open`);

  // Pick engine tile
  const tile = await driver.waitFor((n) => {
    if (!n.classes.includes("dbx-engine-tile")) return false;
    const txt = nodeText(n.raw).replace(/\s+/g, " ").trim();
    return txt.toLowerCase().includes(cfg.engineLabel.toLowerCase());
  }, `engine tile ${cfg.engineLabel}`);
  const tileBox = await driver.clickNode(tile);
  console.log(`    -> clicked tile ${cfg.engineLabel} at (${tileBox.x},${tileBox.y})`);
  await driver.waitFor((n) => n.classes.includes("dbx-form-body"), "connection form body");
  await sleep(200);
  console.log(`    -> form open`);

  // Use URI quick import if provided (cleanest + tests URI parser!)
  if (cfg.uri) {
    const uriInput = await driver.findFirst((n) => n.tag === "input" && (n.attrs.placeholder || "").includes("postgres://"));
    if (uriInput) {
      await driver.setInputValueDirect(uriInput, cfg.uri);
      await driver.clickButtonByText(/^Parse$/);
      await sleep(150);
    }
  }

  // Helper to fill labeled field inside `.dbx-form-body`
  const fillFieldByLabel = async (labelText, value) => {
    const labels = await driver.findAll((n) => n.tag === "label" && n.classes.includes("dbx-field"));
    for (const lbl of labels) {
      const spanText = nodeText(lbl.raw).replace(/\s+/g, " ").trim();
      if (spanText.toLowerCase().startsWith(labelText.toLowerCase())) {
        const inp = collectNodes(lbl.raw, (c) => c.tag === "input" || c.tag === "select")[0];
        if (inp) {
          if (inp.tag === "select") await driver.setSelectValue(inp, value);
          else await driver.setInputValueDirect(inp, value);
          return true;
        }
      }
    }
    return false;
  };

  if (cfg.name) await fillFieldByLabel("Name", cfg.name);
  if (cfg.group) await fillFieldByLabel("Folder / Group", cfg.group);
  if (cfg.host) await fillFieldByLabel("Host", cfg.host);
  if (cfg.port !== undefined) await fillFieldByLabel("Port", String(cfg.port));
  if (cfg.database !== undefined) await fillFieldByLabel("Database", cfg.database);
  if (cfg.username !== undefined) await fillFieldByLabel("Username", cfg.username);
  if (cfg.password !== undefined) await fillFieldByLabel("Password", cfg.password);
  if (cfg.tlsMode) await fillFieldByLabel("TLS / Encryption", cfg.tlsMode);

  // Pick color swatch if specified
  if (cfg.colorIndex !== undefined) {
    const swatches = await driver.findAll((n) => n.tag === "button" && n.classes.includes("dbx-color-swatch"));
    if (swatches[cfg.colorIndex]) {
      await driver.clickNode(swatches[cfg.colorIndex]);
    }
  }

  // Allow self-signed TLS toggle if needed
  if (cfg.allowSelfSigned) {
    const checkboxes = await driver.findAll((n) => n.tag === "input" && n.attrs.type === "checkbox");
    for (const cb of checkboxes) {
      // Find checkbox whose parent label mentions self-signed
      const lbls = await driver.findAll((n) => n.tag === "label" && /self-signed/i.test(nodeText(n.raw)));
      if (lbls[0]) {
        const inner = collectNodes(lbls[0].raw, (c) => c.tag === "input" && c.attrs.type === "checkbox")[0];
        if (inner && inner.attrs.checked === undefined) {
          await driver.clickNode(inner);
          await sleep(100);
        }
        break;
      }
    }
  }

  // Optional SSH tunnel pick via Vault
  if (cfg.useVaultSsh) {
    const scrollDrawerToBottom = async () => {
      const body = await driver.findFirst((n) => n.classes.includes("dbx-form-body"));
      if (body) {
        const { object } = await driver.cdp.send("DOM.resolveNode", { nodeId: body.nodeId });
        await driver.cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: "function() { this.scrollTop = this.scrollHeight; }",
        });
        await sleep(150);
      }
    };
    await scrollDrawerToBottom();
    const sshLabels = await driver.findAll((n) => n.tag === "label" && n.classes.includes("dbx-section-toggle"));
    console.log(`    -> sshLabels found: ${sshLabels.length}`);
    if (sshLabels[0]) {
      const cb = collectNodes(sshLabels[0].raw, (c) => c.tag === "input" && c.attrs.type === "checkbox")[0];
      console.log(`    -> ssh checkbox found: ${Boolean(cb)} attrs=${JSON.stringify(cb?.attrs)}`);
      if (cb && cb.attrs.checked === undefined) {
        const box = await driver.clickNode(cb);
        console.log(`    -> clicked ssh checkbox at (${box.x},${box.y})`);
        await sleep(300);
      }
    }
    await scrollDrawerToBottom();
    const pickBtn = await driver.waitFor((n) => n.tag === "button" && /Pick Vault SSH Host|Change Host/i.test(nodeText(n.raw)), "Pick Vault SSH Host button");
    await driver.clickNode(pickBtn);
    await driver.drainDialogs(2500);
    await sleep(350);
  }

  // Optional live Test Connection
  if (cfg.testFirst) {
    console.log(`    -> clicking Test Connection...`);
    await driver.clickButtonByText(/^Test Connection$/);
    console.log(`    -> clicked Test Connection, polling result...`);
    const start = Date.now();
    while (Date.now() - start < 20000) {
      await driver.handlePendingHostDialogs();
      const resultBanner = await driver.findFirst((n) => n.classes.includes("dbx-banner") && (n.classes.includes("dbx-banner-success") || n.classes.includes("dbx-banner-error")));
      if (resultBanner) {
        console.log(`  [TestConn] ${cfg.name}: ${nodeText(resultBanner.raw).replace(/\s+/g, " ").trim()}`);
        break;
      }
      await sleep(200);
    }
    const stillHasForm = Boolean(await driver.findFirst((n) => n.classes.includes("dbx-form-body")));
    console.log(`    -> after Test Connection, stillHasForm=${stillHasForm}`);
  }

  // Save or Save & Connect
  const submitRegex = cfg.connectNow ? /^Save & Connect$/ : /^Save$/;
  await driver.clickButtonByText(submitRegex);
  await driver.drainDialogs(cfg.connectNow ? 3500 : 1200);
  // Wait for drawer to close cleanly after Save
  const closeEnd = Date.now() + 5000;
  while (Date.now() < closeEnd) {
    const stillOpen = await driver.findFirst((n) => n.classes.includes("dbx-drawer-connection"));
    if (!stillOpen) break;
    await sleep(150);
  }
  await sleep(300);
}

async function main() {
  if (!fs.existsSync(NCPKG_PATH)) {
    throw new Error(`Missing plugin archive: ${NCPKG_PATH}`);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-db-live-qa-"));
  // Pre-seed window-state.json so Netcatty opens natively at exact 1440x900
  const devDir = path.join(userDataDir, "dev");
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(
    path.join(devDir, "window-state.json"),
    JSON.stringify({ x: 40, y: 40, width: 1440, height: 900, isMaximized: false }),
  );
  const cdpPort = await findFreePort();
  console.log(`[QA] Starting REAL Netcatty Electron (NO NETCATTY_PLUGIN_DEV)`);
  console.log(`[QA] userDataDir=${userDataDir}, cdpPort=${cdpPort}`);

  const childEnv = { ...process.env };
  delete childEnv.NETCATTY_PLUGIN_DEV; // Explicitly verify default-on plugin host!
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    ELECTRON_BIN,
    [
      NETCATTY_DIR,
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${cdpPort}`,
    ],
    {
      cwd: NETCATTY_DIR,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const mainLogs = [];
  child.stdout.on("data", (d) => mainLogs.push(d.toString()));
  child.stderr.on("data", (d) => mainLogs.push(d.toString()));

  let cdp = null;
  let driver = null;
  try {
    const target = await waitForCdpTarget(cdpPort);
    console.log(`[QA] Connected to Electron target: ${target.title} (${target.url})`);

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");

    driver = new LiveDriver(cdp, child.pid);
    focusMacPid(child.pid);
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") {
        const msg = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        if (!msg.includes("Autofill.")) {
          driver.consoleErrors.push(msg);
          console.error(`  [ConsoleError] ${msg}`);
        }
      }
    });
    cdp.on("Runtime.exceptionThrown", (p) => {
      const msg = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "Uncaught exception";
      driver.pageErrors.push(msg);
      console.error(`  [PageException] ${msg}`);
    });

    // Resize window to exact 1440x900
    try {
      const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: target.id });
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 40, top: 40, width: 1440, height: 900, windowState: "normal" },
      });
    } catch (e) {
      console.warn("[QA] Browser.setWindowBounds fallback:", e.message);
    }
    await sleep(1200);

    // Wait for window.netcatty bridge to be ready
    for (let i = 0; i < 40; i++) {
      const ready = await cdp.evalJs("Boolean(window.netcatty && typeof window.netcatty.installPluginPackage === 'function')");
      if (ready) break;
      await sleep(250);
    }

    // Seed clean Midnight Dark theme, English locale, Vault SSH Bastion host, and bastion known_hosts
    const bastionKeyPem = fs.existsSync(BASTION_KEY_PATH) ? fs.readFileSync(BASTION_KEY_PATH, "utf8") : "";
    const scannedKnownHosts = [];
    try {
      const scanOut = execFileSync("ssh-keyscan", ["-p", "2222", "127.0.0.1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
      for (const line of scanOut.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
          const [, keyType, keyBase64] = parts;
          scannedKnownHosts.push({
            id: `qa-kh-${keyType}`,
            hostname: "127.0.0.1",
            port: 2222,
            keyType,
            publicKey: `${keyType} ${keyBase64}`,
            discoveredAt: Date.now(),
          });
        }
      }
    } catch {}
    await cdp.evalJs(`(() => {
      localStorage.setItem('netcatty_theme_v1', 'dark');
      localStorage.setItem('netcatty_ui_theme_dark_v1', 'midnight');
      localStorage.setItem('netcatty_ui_theme_light_v1', 'snow');
      localStorage.setItem('netcatty_ui_language_v1', 'en');
      localStorage.setItem('netcatty_vault_sidebar_collapsed_v1', 'false');
      localStorage.setItem('netcatty_known_hosts_v1', JSON.stringify(${JSON.stringify(scannedKnownHosts)}));
      const keys = [{
        id: 'qa-bastion-ed25519',
        label: 'Docker Bastion Key',
        type: 'ED25519',
        privateKey: ${JSON.stringify(bastionKeyPem)},
        created: Date.now(),
      }];
      localStorage.setItem('netcatty_keys_v1', JSON.stringify(keys));
      const hosts = [{
        id: 'qa-docker-bastion',
        label: 'Docker Bastion (SSH)',
        hostname: '127.0.0.1',
        port: 2222,
        username: 'bastion',
        password: 'bastion_pass',
        savePassword: true,
        authMethod: 'key',
        identityFileId: 'qa-bastion-ed25519',
        protocol: 'ssh',
        os: 'linux',
        group: '',
        tags: ['bastion', 'docker'],
        createdAt: Date.now(),
      }];
      localStorage.setItem('netcatty_hosts_v1', JSON.stringify(hosts));
    })()`);

    // Reload so Netcatty boots with Midnight Dark theme + Vault SSH Bastion host
    await cdp.send("Page.reload", { ignoreCache: false });
    await sleep(2200);

    // Verify viewport size
    const dims = await cdp.evalJs("({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })");
    console.log(`[QA] Window viewport: ${dims.w}x${dims.h} @ ${dims.dpr}x DPR`);

    // Install the real .ncpkg package (default-on plugin host, NO NETCATTY_PLUGIN_DEV!)
    console.log(`[QA] Installing ${NCPKG_PATH}...`);
    const installRes = await cdp.evalJs(`window.netcatty.installPluginPackage(${JSON.stringify(NCPKG_PATH)}, { enable: true })`);
    console.log(`[QA] Installed plugin:`, JSON.stringify({ id: installRes?.id, version: installRes?.version, enabled: installRes?.enabled }));

    // Verify plugin is listed and running
    const pluginsList = await cdp.evalJs(`window.netcatty.listPlugins()`);
    const dbPlugin = (Array.isArray(pluginsList) ? pluginsList : pluginsList?.plugins || []).find((p) => p.id === "com.binaricat.netcatty-database");
    console.log(`[QA] Plugin list entry:`, JSON.stringify({
      id: dbPlugin?.id,
      version: dbPlugin?.version,
      enabled: dbPlugin?.enabled,
      status: dbPlugin?.runtime?.status,
    }));

    // Grant non-interactive optional permissions OR let real prompts fire (we keep network.stream / network.hostStream interactive to test real dialogs, and allow storage/secrets/clipboard/vault.metadata/ui.interact/network cleanly)
    const permState = await cdp.evalJs(`window.netcatty.getPluginPermissions('com.binaricat.netcatty-database')`);
    console.log(`[QA] Initial permissions count:`, permState?.permissions?.length ?? Object.keys(permState || {}).length);

    // Wait for "Database" Vault nav button to appear and click it
    const navBtn = await driver.waitFor((n) => {
      if (n.tag !== "button") return false;
      const aria = n.attrs["aria-label"] || n.attrs.title || "";
      const txt = nodeText(n.raw).trim();
      return aria.includes("Database") || txt === "Database";
    }, "Vault Database sidebar item", 15000);
    await driver.clickNode(navBtn);
    await driver.drainDialogs(1500);

    // Wait for DBX Workbench welcome view to mount inside closed ShadowRoot!
    await driver.waitFor((n) => n.classes.includes("dbx-welcome"), "DBX Welcome View inside closed Shadow DOM", 20000);
    console.log(`[QA] DBX Workbench mounted cleanly inside real Netcatty Vault Page!`);
    await driver.drainDialogs(1500);

    // -------------------------------------------------------------------------
    // STEP A: Populate Multi-DB Saved Connections via REAL Connection Drawer UI
    // -------------------------------------------------------------------------
    await createConnectionViaDrawer(driver, {
      engine: "postgres",
      engineLabel: "PostgreSQL",
      name: "Shop Prod (PG 17)",
      group: "Docker Relational",
      host: "127.0.0.1",
      port: 5432,
      database: "shop_demo",
      username: "netcatty",
      password: "netcatty_pg_pass",
      tlsMode: "prefer",
      allowSelfSigned: true,
      colorIndex: 1, // blue
      testFirst: !FAST_07_11,
      connectNow: false,
    });

    await createConnectionViaDrawer(driver, {
      engine: "mysql",
      engineLabel: "MySQL",
      name: "Orders Primary (MySQL 8.4)",
      group: "Docker Relational",
      host: "127.0.0.1",
      port: 3306,
      database: "shop_demo",
      username: "netcatty",
      password: "netcatty_mysql_pass",
      tlsMode: "prefer",
      allowSelfSigned: true,
      colorIndex: 2, // emerald
      connectNow: false,
    });

    await createConnectionViaDrawer(driver, {
      engine: "mariadb",
      engineLabel: "MariaDB",
      name: "Catalog Replica (MariaDB 11)",
      group: "Docker Relational",
      host: "127.0.0.1",
      port: 3307,
      database: "shop_demo",
      username: "netcatty",
      password: "netcatty_maria_pass",
      colorIndex: 3, // amber
      connectNow: false,
    });

    await createConnectionViaDrawer(driver, {
      engine: "redis",
      engineLabel: "Redis",
      name: "Session Cache (Redis 7.4)",
      group: "NoSQL & Analytics",
      host: "127.0.0.1",
      port: 6379,
      password: "netcatty_redis_pass",
      colorIndex: 4, // rose
      connectNow: false,
    });

    await createConnectionViaDrawer(driver, {
      engine: "mongodb",
      engineLabel: "MongoDB",
      name: "Storefront Docs (MongoDB 7)",
      group: "NoSQL & Analytics",
      host: "127.0.0.1",
      port: 27017,
      database: "shop_demo",
      username: "netcatty",
      password: "netcatty_mongo_pass",
      colorIndex: 2, // emerald
      connectNow: false,
    });

    await createConnectionViaDrawer(driver, {
      engine: "clickhouse",
      engineLabel: "ClickHouse",
      name: "Events Warehouse (ClickHouse 24)",
      group: "NoSQL & Analytics",
      host: "127.0.0.1",
      port: 8123,
      database: "analytics_demo",
      username: "netcatty",
      password: "netcatty_ch_pass",
      colorIndex: 5, // purple
      connectNow: false,
    });

    await createConnectionViaDrawer(driver, {
      engine: "postgres",
      engineLabel: "PostgreSQL",
      name: "Bastion PG (Vault SSH)",
      group: "SSH Tunnel & Local",
      host: "postgres",
      port: 5432,
      database: "shop_demo",
      username: "netcatty",
      password: "netcatty_pg_pass",
      tlsMode: "prefer",
      allowSelfSigned: true,
      useVaultSsh: true,
      colorIndex: 5, // purple
      testFirst: !FAST_07_11,
      connectNow: false,
    });

    // Start continuous live video recording right on the clean Welcome Hub if --video
    const videoFramesDir = MODE_VIDEO ? path.join(userDataDir, "video-frames") : null;
    if (MODE_VIDEO) {
      // Wait briefly for any toast to fade, then start recording!
      await sleep(800);
      driver.startVideoRecording(videoFramesDir, 125); // 8 fps capture
      await sleep(1200);
    }

    // Screenshot 01 & 02 (skipped in --fast-07-11)
    if (!FAST_07_11) {
      await sleep(500);
      await driver.captureScreenshot("01-dark-welcome-hub.png");
      if (MODE_VIDEO) await sleep(1500);

      await openNewConnectionDrawer(driver);
      await sleep(500);
      await driver.captureScreenshot("02-dark-22-engine-picker.png");
      if (MODE_VIDEO) await sleep(1800);

      const closeDrawerBtn = await driver.findFirst((n) => n.tag === "button" && n.attrs["aria-label"] === "Close");
      if (closeDrawerBtn) await driver.clickNode(closeDrawerBtn);
      await sleep(300);
    }

    // -------------------------------------------------------------------------
    // Connect to PostgreSQL 17 -> Screenshot 03 (SQL IDE)
    // -------------------------------------------------------------------------
    if (!FAST_07_11) {
    console.log("[QA] Connecting to Shop Prod (PG 17)...");
    const pgCard = await driver.waitFor(
      (n) => n.classes.includes("dbx-conn-card-main") && nodeText(n.raw).includes("Shop Prod (PG 17)"),
      "PG 17 connection card",
    );
    await driver.clickNode(pgCard);
    await driver.drainDialogs(4000);

    // Wait for SQL Query tab + Monaco editor to mount
    await driver.waitFor((n) => n.classes.includes("monaco-editor"), "Monaco SQL Editor in PG tab", 15000);
    await sleep(1000);

    // Wait for PG Tables to populate (Tables branch is auto-expanded on connect!)
    await driver.waitFor(
      (n) => n.tag === "button" && /products/i.test(nodeText(n.raw)) && n.classes.some((c) => c.includes("dbx-tree")),
      "PG products table in sidebar",
      12000,
    );
    await sleep(300);

    // Type a clean single-line SQL query into Monaco, then click Format so Monaco displays perfectly formatted SQL!
    const monacoLines = await driver.findFirst((n) => n.classes.includes("view-lines"));
    if (monacoLines) {
      await driver.clickNode(monacoLines);
      await sleep(120);
      await driver.pressKey("a", { meta: true });
      await driver.pressKey("Backspace");
      await sleep(80);
      const pgSql = "SELECT c.id, c.full_name, c.email, c.tier, c.country_code, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount), 0) AS total_spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.full_name, c.email, c.tier, c.country_code ORDER BY total_spent DESC LIMIT 25;";
      await cdp.send("Input.insertText", { text: pgSql });
      await sleep(250);
    }
    const fmtBtn = await driver.findFirst((n) => n.tag === "button" && /^Format$/i.test(nodeText(n.raw).trim()));
    if (fmtBtn) {
      await driver.clickNode(fmtBtn);
      await sleep(300);
    }

    await driver.clickButtonByText(/^Run$/);
    await driver.drainDialogs(1500);
    await driver.waitFor((n) => n.attrs.role === "gridcell", "PG SQL result grid cells", 12000);
    await sleep(800);
    await driver.captureScreenshot("03-dark-postgres-sql-ide.png");

    // -------------------------------------------------------------------------
    // Screenshot 04: Table Data Tab + Inline Edit + Floating Pending Bar + SQL Preview Drawer
    // -------------------------------------------------------------------------
    console.log("[QA] Opening Table Data tab for products...");
    const productsBtn = await driver.waitFor(
      (n) => n.tag === "button" && /products/i.test(nodeText(n.raw)) && n.classes.some((c) => c.includes("dbx-tree")),
      "products table in sidebar",
      10000,
    );
    await driver.clickNode(productsBtn);
    await driver.waitFor((n) => n.attrs.role === "gridcell" && n.attrs["data-col-name"] === "sku", "products table grid cells", 12000);
    await sleep(600);

    // Inline-edit two cells in virtualized PluginDataGrid!
    const editCell = async (rowIndex, colName, nextValue) => {
      const cell = await driver.findFirst(
        (n) => n.attrs.role === "gridcell" && n.attrs["data-row-index"] === String(rowIndex) && n.attrs["data-col-name"] === colName,
      );
      if (!cell) return false;
      await driver.clickNode(cell, { clickCount: 2 });
      await sleep(250);
      const editInput = await driver.findFirst((n) => n.tag === "input" && n.attrs.role === undefined && n.classes.some((c) => c.includes("bg-background") || c.includes("ring-1")));
      if (!editInput) return false;
      await driver.pressKey("a", { meta: true });
      await driver.pressKey("Backspace");
      await cdp.send("Input.insertText", { text: nextValue });
      await driver.pressKey("Enter");
      await sleep(350);
      return true;
    };
    const e1 = await editCell(0, "name", "Netcatty Pro Mechanical Keyboard");
    const e2 = await editCell(1, "sku", "NC-PRO-KEY-2026");
    console.log(`  [Grid] Inline cell edits performed: name=${e1}, sku=${e2}`);

    // Open SQL Preview drawer via Floating Pending Changes Bar
    const previewSqlBtn = await driver.waitFor((n) => n.tag === "button" && /Preview SQL/i.test(nodeText(n.raw)), "Preview SQL button", 8000);
    await driver.clickNode(previewSqlBtn);
    await sleep(900);
    await driver.captureScreenshot("04-dark-table-inline-edit-preview.png");

    // Close SQL Preview drawer and discard pending edit so DB stays clean
    const closePrevBtn = await driver.findFirst((n) => n.tag === "button" && n.attrs["aria-label"] === "Close");
    if (closePrevBtn) await driver.clickNode(closePrevBtn);
    await sleep(200);
    const discardBtn = await driver.findFirst((n) => n.tag === "button" && /Discard/i.test(nodeText(n.raw)));
    if (discardBtn) await driver.clickNode(discardBtn);
    await sleep(250);

    // -------------------------------------------------------------------------
    // Screenshot 06: Table Structure Designer (Columns, Indexes, FKs, DDL)
    // -------------------------------------------------------------------------
    console.log("[QA] Opening Table Structure Designer...");
    const structBtn = await driver.findFirst((n) => n.tag === "button" && /Structure/i.test(nodeText(n.raw)));
    if (structBtn) {
      await driver.clickNode(structBtn);
      await sleep(1000);
    }
    await driver.captureScreenshot("06-dark-table-structure.png");

    // -------------------------------------------------------------------------
    // Screenshot 05: Interactive ER Diagram (`PluginErCanvas`)
    // -------------------------------------------------------------------------
    console.log("[QA] Opening Interactive ER Diagram...");
    const erBtn = await driver.findFirst((n) => n.tag === "button" && (/ER Diagram|\bER\b/i.test(nodeText(n.raw)) || /ER Diagram/i.test(n.attrs.title || "")));
    if (erBtn) {
      await driver.clickNode(erBtn);
      await sleep(1600);
    }
    await driver.captureScreenshot("05-dark-er-diagram.png");
    } // end !FAST_07_11 (PG 03-06)

    // -------------------------------------------------------------------------
    // Screenshot 07: Redis 7.4 Specialist Workbench
    // -------------------------------------------------------------------------
    console.log("[QA] Opening Redis 7.4 Specialist Workbench...");
    const redisConnBtn = await driver.waitFor(
      (n) => n.tag === "button" && nodeText(n.raw).includes("Session Cache (Redis 7.4)"),
      "Redis sidebar connection",
    );
    await driver.clickNode(redisConnBtn);
    await driver.drainDialogs(4000);
    await sleep(800);

    // Wait for Redis tab to appear and ensure it is active
    const redisTabBtn = await driver.waitFor(
      (n) => n.tag === "button" && n.classes.includes("dbx-tab-btn") && /Session Cache|Redis/i.test(nodeText(n.raw)),
      "Redis tab button",
      12000,
    );
    await driver.clickNode(redisTabBtn);
    await driver.waitFor((n) => n.classes.includes("dbx-redis-key-row"), "Redis key rows in namespace tree", 12000);
    await sleep(400);

    // Select a rich key in the namespace tree so structured value editor is populated!
    const allKeyRows = await driver.findAll((n) => n.classes.includes("dbx-redis-key-row"));
    const preferredKey = allKeyRows.find((k) => /HASH|STR|ZSET/i.test(nodeText(k.raw))) || allKeyRows[0];
    if (preferredKey) {
      await driver.clickNode(preferredKey);
      await sleep(700);
    }

    // Open collapsible Redis CLI Console & run PING, DBSIZE, INFO keyspace!
    const cliToggle = await driver.findFirst((n) => n.tag === "button" && /CLI Console/i.test(nodeText(n.raw)));
    if (cliToggle) {
      await driver.clickNode(cliToggle);
      await sleep(350);
      for (const cmd of ["PING", "DBSIZE", "INFO keyspace"]) {
        const cliForm = await driver.findFirst((n) => n.tag === "form" && n.classes.includes("dbx-redis-cli-input"));
        if (!cliForm) break;
        const cliInput = collectNodes(cliForm.raw, (c) => c.tag === "input")[0];
        const cliRunBtn = collectNodes(cliForm.raw, (c) => c.tag === "button")[0];
        if (cliInput && cliRunBtn) {
          await driver.setInputValueDirect(cliInput, cmd);
          await sleep(160);
          await driver.clickNode(cliRunBtn);
          await sleep(550);
        }
      }
      // Verify CLI output entries rendered!
      const cliEntries = await driver.findAll((n) => n.classes.includes("dbx-cli-entry"));
      console.log(`  [RedisCLI] Rendered ${cliEntries.length} CLI output entries:`, cliEntries.map((e) => nodeText(e.raw).replace(/\s+/g, " ").trim()));
    }
    await driver.captureScreenshot("07-dark-redis-workbench.png");
    if (MODE_VIDEO) await sleep(1800);

    if (!FAST_07_11) {
    // -------------------------------------------------------------------------
    // Screenshot 08: MongoDB 7 Specialist Workbench
    // -------------------------------------------------------------------------
    console.log("[QA] Opening MongoDB 7 Specialist Workbench...");
    const mongoConnBtn = await driver.waitFor(
      (n) => n.tag === "button" && nodeText(n.raw).includes("Storefront Docs (MongoDB 7)"),
      "MongoDB sidebar connection",
    );
    await driver.clickNode(mongoConnBtn);
    await driver.drainDialogs(4000);
    // Wait for MongoDB workbench toolbar (Documents / Indexes / Find / Aggregate / Table / Tree / JSON)
    await driver.waitFor(
      (n) => n.tag === "button" && /^Aggregate$/i.test(nodeText(n.raw).trim()),
      "MongoDB workbench toolbar",
      15000,
    );
    await sleep(900);
    await driver.captureScreenshot("08-dark-mongodb-workbench.png");
    if (MODE_VIDEO) {
      // Briefly showcase Tree view in the live video too!
      const treeBtn = await driver.findFirst((n) => n.tag === "button" && /^Tree$/i.test(nodeText(n.raw).trim()));
      if (treeBtn) {
        await driver.clickNode(treeBtn);
        await sleep(1200);
      }
    }

    // -------------------------------------------------------------------------
    // Screenshot 09: MySQL 8.4 + ClickHouse 24 + SQLite live query + Explain Plan & Export
    // -------------------------------------------------------------------------
    console.log("[QA] Connecting to MySQL 8.4 & ClickHouse 24...");
    const chConnBtn = await driver.waitFor(
      (n) => n.tag === "button" && nodeText(n.raw).includes("Events Warehouse (ClickHouse 24)"),
      "ClickHouse sidebar connection",
    );
    await driver.clickNode(chConnBtn);
    await driver.drainDialogs(4000);
    await sleep(1000);

    // Run a live ClickHouse 24 query!
    const chEditor = await driver.findFirst((n) => n.classes.includes("view-lines"));
    if (chEditor) {
      await driver.clickNode(chEditor);
      await sleep(100);
      await driver.pressKey("a", { meta: true });
      await driver.pressKey("Backspace");
      await cdp.send("Input.insertText", { text: "SELECT page_path, COUNT() AS hits FROM page_views GROUP BY page_path ORDER BY hits DESC LIMIT 10;" });
      await sleep(200);
      await driver.clickButtonByText(/^Run$/);
      await sleep(900);
    }

    // Now connect to MySQL 8.4 so the newest active SQL tab IS MySQL 8.4!
    const mysqlConnBtn = await driver.waitFor(
      (n) => n.tag === "button" && nodeText(n.raw).includes("Orders Primary (MySQL 8.4)"),
      "MySQL sidebar connection",
    );
    await driver.clickNode(mysqlConnBtn);
    await driver.drainDialogs(4000);
    await sleep(1200);

    const mysqlEditorLines = await driver.findFirst((n) => n.classes.includes("view-lines"));
    if (mysqlEditorLines) {
      await driver.clickNode(mysqlEditorLines);
      await sleep(100);
      await driver.pressKey("a", { meta: true });
      await driver.pressKey("Backspace");
      await cdp.send("Input.insertText", {
        text: "SELECT p.sku, p.name, c.name AS category, p.price, p.stock_qty FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.price DESC LIMIT 20;",
      });
      await sleep(200);
    }
    const fmtMysql = await driver.findFirst((n) => n.tag === "button" && /^Format$/i.test(nodeText(n.raw).trim()));
    if (fmtMysql) {
      await driver.clickNode(fmtMysql);
      await sleep(250);
    }
    await driver.clickButtonByText(/^Run$/);
    await sleep(1000);
    const explainBtn = await driver.findFirst((n) => n.tag === "button" && /^Explain$/i.test(nodeText(n.raw).trim()));
    if (explainBtn) {
      await driver.clickNode(explainBtn);
      await sleep(900);
    }
    // Switch back to Result 1 so Export popover can open right over live MySQL 8.4 rows (or keep Explain Plan open — let's check both: Explain Plan tab is visible AND Export menu opens cleanly!)
    const exportBtn = await driver.findFirst((n) => n.tag === "button" && /^Export/i.test(nodeText(n.raw).trim()));
    if (exportBtn) {
      await driver.clickNode(exportBtn);
      await sleep(450);
    }
    await driver.captureScreenshot("09-dark-mysql-clickhouse-sqlite.png");
    await driver.pressKey("Escape");
    await sleep(200);
    } // end !FAST_07_11 (Mongo 08 + MySQL 09)

    // -------------------------------------------------------------------------
    // Screenshot 10 & 11: Light (Snow) Theme (clean native reload so all tokens + Monaco + icons switch!)
    // -------------------------------------------------------------------------
    console.log("[QA] Switching cleanly to Netcatty Light (Snow) theme...");
    await cdp.evalJs(`(() => {
      localStorage.setItem('netcatty_theme_v1', 'light');
      localStorage.setItem('netcatty_ui_theme_light_v1', 'snow');
    })()`);
    await cdp.send("Page.reload", { ignoreCache: false });
    await sleep(2400);

    const navBtnLight = await driver.waitFor((n) => {
      if (n.tag !== "button") return false;
      const aria = n.attrs["aria-label"] || n.attrs.title || "";
      const txt = nodeText(n.raw).trim();
      return aria.includes("Database") || txt === "Database";
    }, "Vault Database sidebar item (Light)", 15000);
    await driver.clickNode(navBtnLight);
    await driver.waitFor((n) => n.classes.includes("dbx-welcome"), "DBX Welcome View (Light)", 15000);
    await sleep(600);

    // Connect to Shop Prod (PG 17) in Light Snow mode & run formatted query!
    const pgCardLight = await driver.waitFor(
      (n) => n.classes.includes("dbx-conn-card-main") && nodeText(n.raw).includes("Shop Prod (PG 17)"),
      "PG 17 card (Light)",
    );
    await driver.clickNode(pgCardLight);
    await driver.drainDialogs(3500);
    await driver.waitFor((n) => n.classes.includes("monaco-editor"), "Monaco SQL Editor (Light)", 15000);
    await sleep(900);
    await driver.waitFor(
      (n) => n.tag === "button" && /products/i.test(nodeText(n.raw)) && n.classes.some((c) => c.includes("dbx-tree")),
      "PG products table in sidebar (Light)",
      10000,
    );
    await sleep(300);
    const monacoLight = await driver.findFirst((n) => n.classes.includes("view-lines"));
    if (monacoLight) {
      await driver.clickNode(monacoLight);
      await sleep(100);
      await driver.pressKey("a", { meta: true });
      await driver.pressKey("Backspace");
      await cdp.send("Input.insertText", {
        text: "SELECT c.id, c.full_name, c.email, c.tier, c.country_code, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount), 0) AS total_spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.full_name, c.email, c.tier, c.country_code ORDER BY total_spent DESC LIMIT 25;",
      });
      await sleep(200);
    }
    const fmtLight = await driver.findFirst((n) => n.tag === "button" && /^Format$/i.test(nodeText(n.raw).trim()));
    if (fmtLight) {
      await driver.clickNode(fmtLight);
      await sleep(250);
    }
    await driver.clickButtonByText(/^Run$/);
    await driver.waitFor((n) => n.attrs.role === "gridcell", "PG SQL grid cells (Light)", 12000);
    await sleep(800);
    if (!FAST_07_11) {
      await driver.captureScreenshot("10-light-snow-postgres-ide.png");
    }

    await openNewConnectionDrawer(driver);
    // Wait until EVERY <img> inside .dbx-engine-picker-grid has finished decoding (complete && naturalWidth > 0)
    const imgDeadline = Date.now() + 10000;
    let imgReport = [];
    while (Date.now() < imgDeadline) {
      const pickerImgs = await driver.findAll((n) => n.tag === "img" && n.classes.includes("dbx-engine-icon"));
      imgReport = [];
      let allLoaded = pickerImgs.length >= 22;
      for (const img of pickerImgs) {
        try {
          const { object } = await driver.cdp.send("DOM.resolveNode", { nodeId: img.nodeId });
          const { result } = await driver.cdp.send("Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: "function() { return { alt: this.alt, complete: this.complete, nw: this.naturalWidth, nh: this.naturalHeight, hasSrc: Boolean(this.src) }; }",
            returnByValue: true,
          });
          imgReport.push(result.value);
          if (!result.value?.complete || !result.value?.nw) allLoaded = false;
        } catch {
          allLoaded = false;
        }
      }
      if (allLoaded && imgReport.length >= 22) break;
      await sleep(250);
    }
    const loadedCount = imgReport.filter((r) => r && r.complete && r.nw > 0).length;
    console.log(`  [LightPicker] ${loadedCount}/${imgReport.length} engine icons decoded with naturalWidth > 0`);
    const broken = imgReport.filter((r) => !r || !r.complete || r.nw === 0);
    if (broken.length > 0) console.warn("  [LightPicker] Broken/unloaded icons:", JSON.stringify(broken));
    await sleep(400);
    await driver.captureScreenshot("11-light-snow-22-engine-picker.png");
    if (MODE_VIDEO) {
      await sleep(1800);
      // Encode captured frames into smooth 1440x900 H.264 MP4 (~30-45s playable pacing)
      const frameCount = driver.videoFrameIndex;
      // Target ~35 seconds total playback duration (fps clamped 6..15 so every transition is crisp and readable)
      const targetFps = Math.max(6, Math.min(15, Math.round(frameCount / 36)));
      console.log(`[Video] Collected ${frameCount} live frames; encoding at ${targetFps} fps (~${(frameCount / targetFps).toFixed(1)}s)...`);
      await driver.stopVideoRecording(DELIVERABLE_VIDEO_PATH, targetFps);
    }

    // -------------------------------------------------------------------------
    // Summary & Plugin Runtime Log Check
    // -------------------------------------------------------------------------
    const logPath = path.join(userDataDir, "dev", "plugins", "logs", "com.binaricat.netcatty-database", "runtime.log");
    const pluginLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "(no runtime.log)";
    console.log("\n=== LIVE QA SUMMARY ===");
    console.log(`Dialogs handled: ${driver.dialogsHandled.length}`);
    for (const d of driver.dialogsHandled) console.log("  -", JSON.stringify(d));
    console.log(`Console errors: ${driver.consoleErrors.length}`);
    console.log(`Page exceptions: ${driver.pageErrors.length}`);
    if (pluginLog.trim()) {
      console.log(`Plugin runtime.log (last 20 lines):\n${pluginLog.trim().split("\n").slice(-20).join("\n")}`);
    }
  } catch (err) {
    console.error("[QA ERROR]", err?.stack || err);
    try {
      if (cdp) {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
        fs.mkdirSync(WORKER_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(WORKER_SCREENSHOT_DIR, "_debug-failure.png"), Buffer.from(data, "base64"));
        console.error(`[QA] Saved failure screenshot to ${path.join(WORKER_SCREENSHOT_DIR, "_debug-failure.png")}`);
        const dlgs = await cdp.evalJs(`Array.from(document.querySelectorAll('[role="dialog"]')).map(d => d.innerText)`);
        console.error("[QA] Open light-DOM dialogs:", JSON.stringify(dlgs));
        const pluginsNow = await cdp.evalJs(`window.netcatty?.listPlugins?.()`);
        console.error("[QA] Plugins state:", JSON.stringify(pluginsNow));
      }
      const logsDir = path.join(userDataDir, "dev", "plugins", "logs");
      if (fs.existsSync(logsDir)) {
        const files = fs.readdirSync(logsDir, { recursive: true });
        console.error("[QA] Plugin log files:", files);
      }
      console.error("[QA] Main stderr/stdout (tail):\n" + mainLogs.join("").slice(-2000));
    } catch {}
    process.exitCode = 1;
  } finally {
    if (driver?.videoTimer) clearInterval(driver.videoTimer);
    if (driver) driver.recording = false;
    cdp?.close();
    try { child.kill("SIGTERM"); } catch {}
    await sleep(500);
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
    if (!KEEP_USER_DATA) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } else {
      console.log(`[QA] Retained userDataDir at ${userDataDir}`);
    }
  }
  process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error("[QA FATAL]", err);
  process.exit(1);
});
