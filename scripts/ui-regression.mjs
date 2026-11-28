// Real Netcatty main host remote-DOM validator + real plugin-owned SQLite (sql.js) regression test.
// Exercises the v0.3.0 DatabaseWorkbench through the host's actual `validatePluginRemoteTree` and
// `validatePluginMutationBatch` policies (plus 128 KiB JSON frame cap) using injected storage/view transports.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const hostRoot = process.env.NETCATTY_HOST_ROOT;
if (!hostRoot || !path.isAbsolute(hostRoot)) {
  throw new Error('Set NETCATTY_HOST_ROOT to the current Netcatty main checkout.');
}

const host = createRequire(path.join(hostRoot, 'package.json'));
const plugin = createRequire(path.join(root, 'package.json'));
const { JSDOM } = host('jsdom');
const { build } = host('esbuild');
const { validatePluginRemoteTree, validatePluginMutationBatch } = host('./domain/pluginRemoteTreePolicy.cjs');

const evidence = path.resolve(process.env.NETCATTY_REACT_EVIDENCE || 'dist/react-main');
await mkdir(evidence, { recursive: true });

const dom = new JSDOM('<!doctype html><body></body>', {
  url: 'https://synthetic.invalid',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLFormElement',
  'Node',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'FocusEvent',
  'CompositionEvent',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? dom.window : dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = plugin('react');
const bundle = path.join(evidence, 'plugin.cjs');
await build({
  entryPoints: ['src/index.tsx'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  loader: { '.css': 'text' },
  plugins: [
    {
      name: 'shared-react',
      setup(b) {
        b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
          path: plugin.resolve(args.path),
          external: true,
        }));
      },
    },
  ],
});

const VIEW = 'com.binaricat.netcatty-database.workbench';
const instanceId = 'main-regression';
const receivers = new Map();
const storage = new Map();
const secrets = new Map();
const disposables = [];
const environmentListeners = new Set();
const registeredTools = [];

let tree = { children: [] };
let maxNodes = 0;
let maxBatchBytes = 0;
let batches = 0;
const errors = [];

const nodes = (rootNode = tree) => {
  const all = [];
  function visit(node) {
    all.push(node);
    node.children?.forEach(visit);
  }
  rootNode.children.forEach(visit);
  return all;
};
const text = (node) => (node.type === 3 ? node.data : (node.children ?? []).map(text).join(''));
const find = (fn) => nodes().find(fn);
const findAll = (fn) => nodes().filter(fn);
const buttonContaining = (substr) => find((n) => n.element === 'button' && text(n).includes(substr));
const buttonExact = (label) => find((n) => n.element === 'button' && text(n).trim() === label);
const receive = (message) => receivers.get(VIEW)?.({ instanceId, ...message });

const context = {
  ui: {
    quickPick: async () => undefined,
    openFile: async () => ({ cancelled: true }),
    saveFile: async () => ({ cancelled: true }),
  },
  clipboard: {
    writeText: async () => true,
  },
  secrets: {
    get: async (k) => secrets.get(k),
    set: async (k, v) => {
      secrets.set(k, v);
    },
    delete: async (k) => {
      secrets.delete(k);
    },
  },
  enabledFeatures: new Set([
    'views.host-drawn',
    'views.vault-pages',
    'metadata.brand-icon',
    'ai.model-invocation',
    'ai.agent-sessions',
    'ai.sidebar-tools',
    'vault.host-actions',
    'host.interactions',
    'network.byte-streams',
    'network.host-byte-streams',
  ]),
  environment: {
    locale: 'en',
    theme: 'dark',
    onDidChange(fn) {
      environmentListeners.add(fn);
      return {
        dispose() {
          environmentListeners.delete(fn);
        },
      };
    },
  },
  subscriptions: {
    add(d) {
      disposables.push(d);
    },
  },
  storage: {
    keys: async () => [...storage.keys()],
    get: async (key) => structuredClone(storage.get(key)),
    set: async (key, value) => {
      storage.set(key, structuredClone(value));
    },
    delete: async (key) => {
      storage.delete(key);
    },
  },
  agent: {
    listBackends: async () => ({ items: [] }),
    closeChat: async () => {},
  },
  vault: {
    selectHosts: async () => ({ cancelled: true }),
    requestConnect: async () => ({ cancelled: false, status: 'requested' }),
  },
  ai: {
    openChat: async () => {
      throw new Error('No live model configured in this fixture');
    },
    registerTools: async (tools) => {
      registeredTools.push(...tools);
      return { dispose() {} };
    },
    setContext: async () => {},
    clearContext: async () => {},
    openSidebar: async () => {},
    closeSidebar: async () => {},
  },
  views: {
    onDidReceiveMessage(id, listener) {
      receivers.set(id, listener);
      return {
        dispose() {
          receivers.delete(id);
        },
      };
    },
    getState: async () => null,
    setState: async () => {},
    postMessage(id, message) {
      if (message.kind !== 'host-ui.update') return;
      try {
        assert.equal(id, VIEW);
        const batchBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
        maxBatchBytes = Math.max(maxBatchBytes, batchBytes);
        assert.ok(batchBytes <= 131072, `host-ui.update batch exceeded 128 KiB: ${batchBytes}`);
        validatePluginMutationBatch(message.mutations);
        batches++;
        for (const m of message.mutations) {
          const n = m[1] === '~' ? tree : nodes().find((node) => node.id === m[1]);
          assert.ok(n, 'mutation target exists: ' + JSON.stringify(m));
          if (m[0] === 0) n.children.splice(m[3], 0, structuredClone(m[2]));
          else if (m[0] === 1) n.children.splice(m[2], 1);
          else if (m[0] === 2) n.data = m[2];
          else if (m[3] === null) delete n.attributes[m[2]];
          else n.attributes[m[2]] = m[3];
        }
        validatePluginRemoteTree(tree);
        maxNodes = Math.max(maxNodes, nodes().length);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    },
  },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 35));
async function settle(predicate = () => true) {
  for (let i = 0; i < 120; i++) {
    await act(async () => {
      await tick();
    });
    assert.deepEqual(errors, []);
    if (predicate()) return;
  }
  throw new Error('UI did not settle: ' + text(tree).slice(0, 600));
}
async function fireEvent(node, props) {
  assert.ok(node, 'Missing target node for event ' + JSON.stringify(props));
  await act(async () => {
    receive({ kind: 'host-ui.event', event: { nodeId: node.id, ...props } });
    await tick();
  });
  assert.deepEqual(errors, []);
}
async function clickButton(label, exact = false) {
  const n = exact ? buttonExact(label) : buttonContaining(label);
  assert.ok(n, 'Missing button: ' + label);
  assert.ok(!Object.hasOwn(n.attributes ?? {}, 'disabled'), 'Disabled button: ' + label);
  await fireEvent(n, { type: 'click' });
}

const snapshotNames = new Set();
async function snapshot(name) {
  snapshotNames.add(name);
  await writeFile(path.join(evidence, name + '.json'), JSON.stringify(tree, null, 2));
}

try {
  // 1. Activate & mount Welcome View; confirm all images use asset: URLs and zero inline <svg>/<canvas>
  await act(async () => {
    await plugin(bundle).default.activate(context);
    receive({ kind: 'host-ui.open', stateScope: VIEW });
    await tick();
  });
  await settle(() => Boolean(buttonContaining('Launch Sample SQLite')));
  assert.ok(buttonContaining('New Connection'));
  assert.ok(buttonContaining('Open Local SQLite File'));
  assert.equal(registeredTools.length, 7, 'All 7 Catty Database Agent tools must register');
  assert.ok(
    findAll((n) => n.element === 'img').every((n) => String(n.attributes?.src ?? '').startsWith('asset:')),
    'All images must use asset: URIs',
  );
  assert.equal(findAll((n) => n.element === 'svg' || n.element === 'canvas').length, 0);
  await snapshot('01-welcome');

  // 2. Open New Connection drawer -> verify bounded 24-tile pagination & <= 128 KiB mutation payload
  const isEngineTile = (n) =>
    n.element === 'button' && String(n.attributes?.class ?? '').split(/\s+/).includes('ndb-engine-tile');
  await clickButton('New Connection');
  await settle(() => findAll(isEngineTile).length === 24);
  assert.ok(text(tree).includes('PostgreSQL'));
  assert.ok(text(tree).includes('OceanBase'));
  assert.ok(text(tree).includes('113'));
  await snapshot('02-connection-picker');

  // Close drawer
  const closeDrawerBtn = find((n) => n.element === 'button' && String(n.attributes?.['aria-label'] ?? '').includes('Close'));
  assert.ok(closeDrawerBtn, 'Expected drawer close button');
  await fireEvent(closeDrawerBtn, { type: 'click' });
  await settle(() => findAll(isEngineTile).length === 0);

  // 3. Launch live Sample SQLite (sql.js) -> verify schema explorer + SQL Query tab + live execution
  await clickButton('Launch Sample SQLite');
  await settle(() => text(tree).includes('customers') && text(tree).includes('orders') && text(tree).includes('products'));
  const editorNode = find((n) => n.attributes?.['data-plugin-widget'] === 'code-editor');
  assert.ok(editorNode, 'Monaco code-editor widget mounted');
  await snapshot('03-sqlite-connected');

  // Enter a real analytical SQL query via PluginCodeEditor widget event & execute on live SQLite
  await fireEvent(editorNode, {
    type: 'widget',
    widgetEvent: 'change',
    detail: {
      value: 'SELECT c.tier, COUNT(*) AS cnt, SUM(o.total_amount) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY c.tier ORDER BY revenue DESC',
    },
  });
  await clickButton('Run');
  await settle(() => Boolean(find((n) => n.attributes?.['data-plugin-widget'] === 'data-grid')));
  await snapshot('04-sql-result-grid');

  // 4. Switch to inline SQL Chart subtab -> verify host bi-chart widget + bar-chart-2 icon + Pin CTA
  await clickButton('Chart', true);
  await settle(() => Boolean(find((n) => n.attributes?.['data-plugin-widget'] === 'bi-chart')));
  assert.ok(buttonContaining('Pin to BI Dashboard'), 'SQL Chart subtab must expose Pin to BI Dashboard');
  assert.equal(findAll((n) => n.element === 'svg' || n.element === 'canvas').length, 0);
  await snapshot('05-sql-chart');

  // 5. Pin to BI Dashboard -> verify BI Dashboard opens with pinned live chart card and Ask Catty Agent
  await clickButton('Pin to BI Dashboard');
  await settle(() => text(tree).includes('BI Dashboard') && Boolean(buttonContaining('Ask Catty Agent')));
  assert.ok(find((n) => n.attributes?.['data-plugin-widget'] === 'bi-chart'));
  assert.ok(find((n) => n.attributes?.['data-plugin-widget'] === 'data-grid'));
  assert.equal(findAll((n) => String(n.attributes?.class ?? '').includes('ndb-bi-ask-bar')).length, 0);
  await snapshot('06-bi-dashboard');

  // 6. Switch live locale to zh-CN -> verify bilingual UI update
  await act(async () => {
    context.environment.locale = 'zh-CN';
    environmentListeners.forEach((fn) => fn(context.environment));
    await tick();
  });
  await settle(() => text(tree).includes('BI 看板') && text(tree).includes('工具'));
  await snapshot('07-zh-cn');

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        scope: 'Real v0.3.0 DatabaseWorkbench + sql.js SQLite + Netcatty main remote-DOM & mutation validators',
        maxNodes,
        maxBatchBytes,
        batches,
        registeredTools: registeredTools.length,
        snapshots: snapshotNames.size,
      },
      null,
      2,
    ),
  );
} finally {
  await act(async () => {
    receive({ kind: 'host-ui.close' });
    disposables.forEach((d) => d.dispose());
    await tick();
  });
  dom.window.close();
}
