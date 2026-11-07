// Actual plugin registration + React + SDK remote DOM: mock regression lane,
// then real host service/workers on disposable commerce only. No native dialogs,
// real vault, user databases or model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const hostRoot = process.env.NETCATTY_HOST_ROOT || path.resolve(pluginRoot, '../netcatty-database-host');
const evidence = process.env.NETCATTY_REACT_EVIDENCE || path.join(pluginRoot, 'dist/react-regression');
await mkdir(`${evidence}/tmp`, { recursive: true });
const host = createRequire(path.join(hostRoot, 'package.json'));
const plugin = createRequire(path.join(pluginRoot, 'package.json'));
const { JSDOM } = host('jsdom'); const { build } = host('esbuild');
const { validatePluginRemoteTree, validatePluginMutationBatch } = host('./domain/pluginRemoteTreePolicy.cjs');
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://synthetic.invalid', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLFormElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'FocusEvent', 'CompositionEvent']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = plugin('react');
const output = `${evidence}/workbench-check-bundle.cjs`;
await build({ entryPoints: [path.join(pluginRoot, 'src/index.tsx')], outfile: output, bundle: true, format: 'cjs', platform: 'node', loader: { '.css': 'text' }, plugins: [{ name: 'shared-react', setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: plugin.resolve(args.path), external: true })); } }] });
let realPending = 0;
let receive; let tree = { children: [] }; let disposables = []; const policyErrors = [];
let maxNodes = 0; let maxBytes = 0; let batches = 0;
const allNodes = () => { const nodes = []; const visit = (n) => { nodes.push(n); n.children?.forEach(visit); }; tree.children.forEach(visit); return nodes; };
const textOf = (n) => n.type === 3 ? n.data : (n.children ?? []).map(textOf).join('');
const find = (predicate) => allNodes().find(predicate);
const button = (label) => { const dialog = find((n) => n.attributes?.role === 'dialog'); const nested = []; const visit = (n) => { nested.push(n); n.children?.forEach(visit); }; if (dialog) visit(dialog); return [...nested, ...allNodes()].find((n) => n.element === 'button' && textOf(n) === label); };
const byLabel = (label) => find((n) => n.attributes?.['aria-label'] === label);
let saved = []; let chosen = null; let opens = 0; let apiCalls = []; let hostCount = 2; let schemaColumns = 3; let schemaObjects = 1; let bigResult = false; let failSave = false;
const memory = () => ({ handleId: `memory-${++opens}`, engine: 'sqlite', label: 'Disposable synthetic notes', fixture: true });
const file = { handleId: 'file-one', revision: 'revision-one', engine: 'sqlite', label: 'Disposable SQLite file (read-only)', fixture: true, readOnly: true };
const features = new Set(['database.sqlite-fixture.v1', 'database.sqlite-file-fixture.v1', 'database.saved-connections.v1']);
const environmentListeners = new Set();
const context = { enabledFeatures: features, environment: { locale: 'en', theme: 'dark', onDidChange: (fn) => { environmentListeners.add(fn); return { dispose() { environmentListeners.delete(fn); } }; } },
  subscriptions: { add: (d) => disposables.push(d) },
  ai: new Proxy({}, { get() { throw new Error('Real AI access is forbidden'); } }),
  views: { onDidReceiveMessage: (_id, listener) => { receive = listener; return { dispose() {} }; }, getState: async () => null, setState: async () => {}, postMessage: (_id, message) => {
    try {
      validatePluginMutationBatch(message.mutations); batches++;
      for (const m of message.mutations) {
        const node = m[1] === '~' ? tree : allNodes().find((n) => n.id === m[1]); assert.ok(node);
        if (m[0] === 0) node.children.splice(m[3], 0, structuredClone(m[2]));
        else if (m[0] === 1) node.children.splice(m[2], 1);
        else if (m[0] === 2) node.data = m[2];
        else if (m[3] === null) delete node.attributes[m[2]]; else node.attributes[m[2]] = m[3];
      }
      validatePluginRemoteTree(tree); maxNodes = Math.max(maxNodes, allNodes().length); maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(tree)));
    } catch (e) { policyErrors.push(e.message); }
  } },
  database: {
    listSavedConnections: async () => structuredClone(saved),
    listHostsForDatabase: async () => Array.from({ length: hostCount }, (_, i) => i + 1).map((n) => ({ hostId: `host-${n}`, label: `Synthetic host ${n}`, hostname: `fixture-${n}.invalid`, username: 'test', port: 22, capability: 'metadata-only', tunnelAvailable: false })),
    openFixture: async () => memory(), openSqliteFile: async () => chosen,
    refreshSqliteFile: async (p) => ({ ...file, handleId: p.handleId, revision: `refresh-${++opens}` }),
    saveConnection: async (p) => { apiCalls.push({ operation: 'save', hasSecret: Boolean(p.secret), hostId: p.meta.hostId }); if (failSave) throw new Error('Synthetic keychain unavailable'); const c = { id: `saved-${saved.length + 1}`, ...p.meta, engine: 'sqlite', targetKind: p.revision ? 'file' : 'memory', readOnly: Boolean(p.revision), ...(p.secret ? { secretRef: 'opaque-synthetic-ref' } : {}) }; saved.push(c); return c; },
    openSavedConnection: async ({ id }) => { apiCalls.push({ operation: 'reopen', id }); return saved.find((c) => c.id === id).targetKind === 'file' ? { ...file, handleId: `file-${++opens}`, revision: `revision-${opens}` } : memory(); },
    deleteConnection: async ({ id }) => { saved = saved.filter((c) => c.id !== id); return null; },
    readSchema: async () => ({ tables: Array.from({ length: schemaObjects }, (_, objectIndex) => ({ name: objectIndex === 0 ? 'notes' : `object_${objectIndex}`, kind: objectIndex % 2 ? 'view' : 'table', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }, { name: 'title', type: 'TEXT', primaryKey: false }, { name: 'status', type: 'TEXT', primaryKey: false }, ...Array.from({ length: schemaColumns - 3 }, (_, i) => ({ name: `extra_${i}`, type: 'TEXT', primaryKey: false }))] })) }),
    query: async (p) => { apiCalls.push({ operation: 'query', ...p }); return bigResult ? { columns: Array.from({ length: 32 }, (_, n) => `column${n}`), rows: Array.from({ length: 100 }, () => Array(32).fill('x'.repeat(2048))), changes: 0, elapsedMs: 1, truncated: true } : { columns: ['id', 'title', 'status'], rows: [[1, 'Synthetic launch checklist', 'open'], [3, 'Parameter binding example', 'open']], changes: 0, elapsedMs: 2, truncated: false }; },
    close: async (p) => { apiCalls.push({ operation: 'close', ...p }); return null; }, cancel: async (p) => { apiCalls.push({ operation: 'cancel', ...p }); return null; },
  },
};
const initialMockDatabase = { ...context.database };
const tick = () => new Promise((r) => setTimeout(r, 25));
const event = async (node, props) => { assert.ok(node); await act(async () => { receive({ kind: 'host-ui.event', instanceId: 'm3', event: { nodeId: node.id, ...props } }); await tick(); }); for (let i = 0; realPending && i < 200; i++) await act(async () => { await tick(); }); assert.equal(realPending, 0, 'host operation settled'); assert.deepEqual(policyErrors, []); };
const click = async (label) => { const n = button(label); assert.ok(n, `missing ${label}`); assert.equal('disabled' in n.attributes, false, `disabled ${label}`); await event(n, { type: 'click' }); };
const change = async (label, value) => event(byLabel(label), { type: byLabel(label).element === 'select' ? 'change' : 'input', value });
const mount = async () => { tree = { children: [] }; plugin(output).default.activate(context); await act(async () => { receive({ kind: 'host-ui.open', instanceId: 'm3' }); await tick(); }); assert.deepEqual(policyErrors, []); };
const unmount = async () => { await act(async () => { receive({ kind: 'host-ui.close', instanceId: 'm3' }); disposables.forEach((d) => d.dispose()); disposables = []; await tick(); }); };
const snapshot = async (name) => {
  const copy = document.body.cloneNode(true);
  const controls = [...document.body.querySelectorAll('input,textarea,select')];
  [...copy.querySelectorAll('input,textarea,select')].forEach((node, i) => {
    const source = controls[i];
    if (node.tagName === 'SELECT') [...node.options].forEach((option, j) => option.toggleAttribute('selected', source.options[j].selected));
    else if (node.tagName === 'TEXTAREA') node.textContent = source.value;
    else { node.setAttribute('value', source.type === 'password' ? '' : source.value); node.toggleAttribute('checked', source.checked); }
  });
  await writeFile(`${evidence}/${name}.html`, copy.innerHTML);
};
const checks = [];
const language = async (locale) => { await act(async () => { context.environment.locale = locale; environmentListeners.forEach((fn) => fn(context.environment)); await tick(); }); assert.deepEqual(policyErrors, []); };

try {
  await mount(); assert.ok(document.body.textContent.includes('No connections yet')); await snapshot('01-home'); checks.push('home + counters + empty sidebar');
  await click('New Connection'); assert.ok(button('PostgreSQLDriver not implemented')); assert.ok('disabled' in button('MySQLDriver not implemented').attributes); await snapshot('02-picker'); await click('Next');
  await change('Connection name', 'Synthetic saved memory'); await click('Advanced'); await click('Load permitted hosts'); await change('Existing host', 'host-2'); await click('Connection');
  await click('Test'); assert.match(document.body.textContent, /Connection successful/); await snapshot('03-tested-modal');
  const checkbox = find((n) => n.element === 'input' && n.attributes.type === 'checkbox'); await event(checkbox, { type: 'click', checked: true });
  await change('Synthetic password', 'SYNTHETIC-ONLY-M3'); failSave = true; await click('Save & Connect');
  assert.equal(byLabel('Synthetic password').attributes.value, ''); assert.match(document.body.textContent, /Synthetic keychain unavailable/); checks.push('failed save clears synthetic password input and preserves actionable error');
  failSave = false; await change('Synthetic password', 'SYNTHETIC-ONLY-M3'); await click('Save & Connect');
  assert.equal(saved[0].hostId, 'host-2'); assert.equal(saved[0].secretRef, 'opaque-synthetic-ref'); assert.doesNotMatch(JSON.stringify(tree), /SYNTHETIC-ONLY-M3/); checks.push('test + host metadata binding + save returns only secretRef');
  await click('Run read query'); assert.match(document.body.textContent, /2 rows \/ 3 columns \/ 2 ms/); assert.equal(apiCalls.findLast((c) => c.operation === 'query').maxRows, 100); await snapshot('04-connected-query');
  await event(byLabel('Open table notes'), { type: 'click' }); assert.ok(byLabel('Structure of notes')); await click('Data'); assert.match(byLabel('SQL statement').attributes.value, /SELECT \* FROM "main"."notes"/); await click('Run read query'); await click('Query 1'); assert.match(byLabel('SQL statement').attributes.value, /status = \?/); checks.push('schema tree, independent table/query tabs, bounded query and results');
  const initialSql = byLabel('SQL statement').attributes.value;
  await change('SQL statement', "SELECT 'paid', 42\n-- comment\nFROM notes\n");
  assert.equal(document.querySelector('.editor-gutter').textContent, '1\n2\n3\n4');
  assert.equal(document.querySelector('.sql-keyword').textContent, 'SELECT');
  assert.equal(document.querySelector('.sql-string').textContent, "'paid'");
  assert.equal(document.querySelector('.sql-highlight code').textContent, byLabel('SQL statement').attributes.value + '\n');
  assert.ok(document.querySelector('.sql-scroll .editor-gutter'));
  assert.ok(document.querySelector('.sql-scroll textarea'));
  assert.equal(byLabel('SQL editor height').attributes.value, '52');
  await change('SQL editor height', '67');
  assert.match(document.querySelector('.query-split').getAttribute('style'), /67%/);
  await click('notes'); await click('Data'); assert.equal(byLabel('SQL editor height'), undefined);
  await click('Query 1'); assert.equal(byLabel('SQL editor height').attributes.value, '67');
  await language('zh-CN'); assert.equal(byLabel('SQL 编辑器高度').attributes['aria-valuetext'], '编辑器 67%');
  assert.match(byLabel('SQL 语句').attributes.value, /paid/);
  await language('en'); await change('SQL statement', initialSql);
  checks.push('SQL overlay/gutter share scroll parent, lexical colors preserve text, range persists across Data and locale changes');
  await click('AI SQL assistant'); assert.match(document.body.textContent, /Host AI is unavailable/); assert.equal(button('Run assistance'), undefined); assert.equal(button('Create mock draft'), undefined); assert.ok(find(n => n.element === 'aside' && n.attributes?.['aria-label'] === 'AI SQL assistant')); await event(byLabel('Close AI assistant'), { type: 'click' }); assert.equal(find(n => n.element === 'aside' && n.attributes?.['aria-label'] === 'AI SQL assistant'), undefined); await click('AI SQL assistant'); await snapshot('ai-unavailable-en'); checks.push('AI unavailable without negotiated feature; no provider or mock calls');
  await click('Close connection'); await unmount(); await mount(); await click('Synthetic saved memory'); await click('Run read query'); assert.ok(apiCalls.some((c) => c.operation === 'reopen')); checks.push('saved list restored on fresh React mount, reopen then query');
  await click('Close connection'); await click('New Connection'); await click('Next'); await change('SQLite source', 'file'); assert.ok('disabled' in button('Save & Connect').attributes); assert.match(document.body.textContent, /No file selected/); checks.push('cancelled native chooser never falls back to memory');
  assert.doesNotMatch(document.body.textContent, /Stable fixture WAL/);
  features.add('database.sqlite-wal-readonly.fixture.v1'); await language('zh-CN');
  assert.match(document.body.textContent, /稳定测试文件的 WAL/); await language('en');
  assert.match(document.body.textContent, /Stable fixture WAL: verified read-only snapshot/);
  checks.push('WAL capability notice is gated and honest in English and zh-CN');
  features.add('database.sqlite-wal-concurrent.fixture.v1'); await language('zh-CN');
  assert.match(document.body.textContent, /源文件变化会使快照失效/);
  assert.match(document.body.textContent, /不支持实时刷新、检查点或恢复/);
  await language('en'); assert.match(document.body.textContent, /source changes invalidate the snapshot/);
  assert.match(document.body.textContent, /No live refresh, checkpoint or recovery support/);
  features.delete('database.sqlite-wal-readonly.fixture.v1'); await language('zh-CN');
  assert.doesNotMatch(document.body.textContent, /源文件变化会使快照失效/);
  features.add('database.sqlite-wal-readonly.fixture.v1'); await language('en');
  checks.push('Concurrent qualification notice requires E and F; en/zh-CN states invalidation, reselection and non-claims');
  features.add('database.sqlite-wal-checkpoint.fixture.v1'); await language('zh-CN');
  assert.match(document.body.textContent, /PASSIVE\/FULL\/RESTART/);
  assert.match(document.body.textContent, /旧快照会失效/);
  assert.match(document.body.textContent, /空 WAL、中断或陈旧尾部均拒绝/);
  await language('en'); assert.match(document.body.textContent, /Old snapshots invalidate/);
  assert.match(document.body.textContent, /No live refresh or crash recovery/);
  for (const dependency of ['database.sqlite-wal-readonly.fixture.v1', 'database.sqlite-wal-concurrent.fixture.v1']) {
    features.delete(dependency); await language('zh-CN');
    assert.doesNotMatch(document.body.textContent, /PASSIVE\/FULL\/RESTART/);
    features.add(dependency); await language('en');
  }
  features.add('database.sqlite-wal-capture.fixture.v1'); await language('zh-CN');
  assert.match(document.body.textContent, /选择文件及读取期间需暂停所有写入/);
  assert.match(document.body.textContent, /已显示的行仅为历史数据/);
  assert.match(document.body.textContent, /不支持实时刷新或自动重试/);
  await language('en'); assert.match(document.body.textContent, /pause all writers through file selection and reads/);
  assert.match(document.body.textContent, /displayed rows are historical/);
  assert.match(document.body.textContent, /No live refresh or automatic retry/);
  for (const dependency of ['database.sqlite-file-fixture.v1', 'database.sqlite-wal-readonly.fixture.v1', 'database.sqlite-wal-concurrent.fixture.v1', 'database.sqlite-wal-checkpoint.fixture.v1']) {
    features.delete(dependency); await language('zh-CN');
    assert.doesNotMatch(document.body.textContent, /测试文件捕获/);
    features.add(dependency); await language('en');
  }
  assert.doesNotMatch(document.body.textContent, /fixed malformed test corpus/);
  features.add('database.sqlite-malformed-reject.fixture.v1'); await language('zh-CN');
  assert.doesNotMatch(document.body.textContent, /固定的损坏测试样本集/);
  features.add('database.sqlite-fd-identity.fixture.v1'); await language('en');
  assert.match(document.body.textContent, /fixed malformed test corpus before opening/);
  assert.match(document.body.textContent, /Broader corruption handling and recovery are unqualified/);
  await language('zh-CN'); assert.match(document.body.textContent, /固定的损坏测试样本集/);
  assert.match(document.body.textContent, /尚未验证更广泛的损坏处理或恢复能力/);
  for (const dependency of ['database.sqlite-fixture.v1', 'database.sqlite-file-fixture.v1', 'database.sqlite-fd-identity.fixture.v1', 'database.sqlite-wal-readonly.fixture.v1', 'database.sqlite-wal-concurrent.fixture.v1', 'database.sqlite-wal-checkpoint.fixture.v1', 'database.sqlite-wal-capture.fixture.v1']) {
    features.delete(dependency); await language('en');
    assert.doesNotMatch(document.body.textContent, /fixed malformed test corpus/);
    features.add(dependency); await language('zh-CN');
  }
  features.delete('database.sqlite-malformed-reject.fixture.v1'); await language('en');
  assert.doesNotMatch(document.body.textContent, /fixed malformed test corpus/);
  checks.push('Malformed reject notice requires file/C/E/F/G/H/I; en/zh-CN limits claim to fixed Linux corpus, with broader corruption and recovery unqualified');
  features.delete('database.sqlite-wal-capture.fixture.v1'); await language('zh-CN');
  assert.doesNotMatch(document.body.textContent, /测试文件捕获/);
  await language('en'); assert.match(document.body.textContent, /Old snapshots invalidate/);
  checks.push('Capture qualification requires file/E/F/G/H; en/zh-CN states pause through reads, fresh selection, historical rows and no live refresh');
  features.delete('database.sqlite-wal-checkpoint.fixture.v1'); await language('zh-CN');
  assert.doesNotMatch(document.body.textContent, /PASSIVE\/FULL\/RESTART/);
  await language('en');
  checks.push('Checkpoint qualification requires E/F/G; en/zh-CN describes fresh selection and strict tail rejects, never recovery');
  chosen = file; await click('Choose file...'); await change('Connection name', 'Synthetic saved file'); await click('Save & Connect');
  assert.ok('disabled' in button('Review write...').attributes); await click('Run read query'); assert.equal(apiCalls.findLast((c) => c.operation === 'query').revision, 'revision-one');
  await click('Cancel / close'); assert.equal(apiCalls.findLast((c) => c.operation === 'cancel').revision, 'revision-one'); checks.push('file read-only + query and cancel preserve revision');
  await click('Synthetic saved file'); bigResult = true; await click('Run read query'); assert.equal(document.querySelectorAll('tbody tr').length, 20); assert.equal(document.querySelectorAll('thead th').length, 9); assert.ok(document.querySelector('tbody td:nth-child(2)').textContent.length <= 259); checks.push('large host result stays inside remote DOM node and text budgets');
  await click('New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts'); assert.deepEqual(policyErrors, []); checks.push('modal over result grid validates against actual host remote-tree policy'); await click('Close');
  await click('Close connection'); await event(byLabel('Delete Synthetic saved file'), { type: 'click' }); assert.equal(saved.length, 1); checks.push('delete updates saved sidebar');
  await click('New Connection'); await click('Next'); let finish; chosen = new Promise((r) => { finish = r; });
  await change('SQLite source', 'file'); await unmount(); await act(async () => { finish(file); await tick(); }); assert.equal(apiCalls.findLast((c) => c.operation === 'close').revision, 'revision-one'); checks.push('late chooser result after unmount releases session');
  features.delete('database.saved-connections.v1'); features.delete('database.sqlite-file-fixture.v1'); await mount(); await click('New Connection'); await click('Next'); assert.ok(button('Connect without saving')); assert.ok('disabled' in find((n) => n.element === 'option' && n.attributes.value === 'file').attributes); await click('Connect without saving'); await click('Run read query'); checks.push('older host retains memory path; file and persistence gated independently');
  await unmount(); features.add('database.saved-connections.v1'); features.add('database.sqlite-file-fixture.v1');
  features.add('ai.model-invocation');
  saved = Array.from({ length: 100 }, (_, i) => ({ id: `stress-${i}`, name: `Stress ${i}`, color: 'default', engine: 'sqlite', targetKind: 'memory', readOnly: false }));
  hostCount = 500; schemaColumns = 32; schemaObjects = 32; await mount(); await event(byLabel('Next connections'), { type: 'click' }); assert.ok(button('Stress 10')); await event(byLabel('Previous connections'), { type: 'click' }); await click('Stress 0'); await event(byLabel('Open table notes'), { type: 'click' }); assert.equal(document.querySelectorAll('.structure tbody tr').length, 32); await event(byLabel('Close notes'), { type: 'click' });
  for (let i = 0; i < 7; i++) await click('New Query');
  await click('AI SQL assistant'); await click('Run assistance');
  assert.match(document.body.textContent, /Connected schema is missing or too large/);
  await event(byLabel('Next connections'), { type: 'click' });
  await change('SQL statement', "SELECT 'a', 1 FROM notes WHERE id = 2 ORDER BY title");
  await click('Run read query'); await click('New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts');
  assert.ok(document.querySelector('.sql-keyword'));
  await change('SQL statement', "1'a'".repeat(10));
  assert.equal(document.querySelectorAll('.sql-highlight span').length, 20);
  assert.equal(textOf(find(n => n.element === 'code')), "1'a'".repeat(10) + '\n');
  await change('SQL statement', 'SELECT 1, '.repeat(800).slice(0, 8192));
  assert.equal(document.querySelectorAll('.sql-highlight span').length, 0);
  await change('SQL statement', '\n'.repeat(8192));
  assert.ok(document.querySelector('.editor-gutter').textContent.endsWith('8193'));
  assert.equal(textOf(find(n => n.element === 'code')), '\n'.repeat(8193));
  await change('SQL statement', "SELECT 'restored'\nFROM notes");
  assert.equal(textOf(find(n => n.element === 'code')), "SELECT 'restored'\nFROM notes\n");
  assert.equal(textOf(find(n => n.attributes?.class === 'editor-gutter')), '1\n2');
  assert.deepEqual(policyErrors, []);
  checks.push('highlight and 8193-line fallback fit actual host policy with maximum schema, grid, tabs, connections and modal');
  assert.deepEqual(policyErrors, []); assert.ok(maxNodes <= 1024); checks.push('100 connections, 500 hosts, 32 schema objects/columns, 8 tabs and oversized mock result remain within host tree limits');
  features.add('database.host-port-probe.v1');
  const stressListHosts = context.database.listHostsForDatabase;
  context.database.listHostsForDatabase = async () => (await stressListHosts()).map((h) => ({ ...h, portProbe: { revision: 'stress-revision' } }));
  context.database.probeHostDatabasePorts = async ({ hostId }) => ({ hostId, hostname: '127.0.0.1', code: 'PROBE_OK', synthetic: false, connected: false, ports: [[5432, 'PostgreSQL'], [3306, 'MySQL / MariaDB'], [1433, 'Microsoft SQL Server'], [27017, 'MongoDB'], [6379, 'Redis']].map(([port, serviceLabel]) => ({ port, serviceLabel, status: 'closed', latencyMs: 1 })) });
  await click('Load permitted hosts'); await change('Existing host', 'host-1'); await click('Probe common database ports');
  assert.match(document.body.textContent, /6379 Redis: closed/); assert.deepEqual(policyErrors, []); assert.ok(maxNodes <= 1024);
  checks.push('all five port results fit host DOM budget over maximum connections, schema, grid, tabs and SQL editor');
  context.database.listHostsForDatabase = stressListHosts; features.delete('database.host-port-probe.v1');
  await unmount();
  features.delete('ai.model-invocation');
  // Chinese starts from the host environment, not navigator.language (JSDOM stays English).
  saved = []; bigResult = false; hostCount = 2; schemaObjects = 1; schemaColumns = 3; chosen = null;
  await language('zh-CN'); await mount();
  assert.equal(navigator.language, 'en-US');
  assert.match(document.body.textContent, /快速开始/); assert.match(document.body.textContent, /实验功能/);
  assert.ok(byLabel('筛选连接')); assert.ok(button('历史记录本阶段暂不可用'));
  await snapshot('zh-01-home');
  await click('新建连接'); assert.ok('disabled' in button('PostgreSQL尚未实现驱动').attributes);
  assert.ok('disabled' in button('MySQL尚未实现驱动').attributes); await snapshot('zh-02-picker');
  await click('下一步'); assert.equal(byLabel('连接名称').attributes.value, '模拟 SQLite');
  await language('en'); assert.equal(byLabel('Connection name').attributes.value, 'Synthetic SQLite');
  await change('Connection name', 'User 名称 {name}'); await language('zh-CN');
  assert.equal(byLabel('连接名称').attributes.value, 'User 名称 {name}'); assert.ok(byLabel('颜色：蓝色'));
  await click('高级'); await click('加载已获授权的主机'); assert.ok(byLabel('筛选主机'));
  await change('已有主机', 'host-2'); assert.match(document.body.textContent, /不会建立隧道/);
  await snapshot('zh-03-advanced'); await click('连接');
  await click('测试'); assert.match(document.body.textContent, /连接成功 - 宿主已验证数据库结构/);
  await snapshot('zh-04-tested-modal'); await click('保存并连接');
  assert.equal(saved[0].hostId, 'host-2'); assert.equal(saved[0].name, 'User 名称 {name}');
  checks.push('zh-CN home/picker/form/advanced/test and host metadata; live locale preserves edited names and localizes untouched defaults');
  await event(byLabel('打开表 notes'), { type: 'click' });
  assert.ok(byLabel('notes 的结构')); assert.match(document.body.textContent, /允许空值/);
  assert.match(document.body.textContent, /未知/); assert.ok(button('表 (1)')); assert.ok(button('视图 (0)'));
  await change('搜索数据库对象', 'missing'); assert.match(document.body.textContent, /没有匹配的对象/);
  await change('搜索数据库对象', ''); await snapshot('zh-05-structure');
  await click('数据'); await click('执行只读查询'); assert.match(document.body.textContent, /2 行 \/ 3 列 \/ 2 毫秒 \/ 0 处更改/);
  await click('查询 1'); const originalSql = byLabel('SQL 语句').attributes.value;
  await change('SQL 参数', '['); const queryCount = apiCalls.filter((c) => c.operation === 'query').length;
  await click('执行只读查询'); assert.match(document.body.textContent, /参数必须是有效的 JSON/);
  assert.equal(apiCalls.filter((c) => c.operation === 'query').length, queryCount);
  await language('en'); assert.match(document.body.textContent, /Parameters must be valid JSON/);
  assert.equal(byLabel('SQL statement').attributes.value, originalSql);
  assert.equal(byLabel('SQL parameters').attributes.value, '['); assert.ok(button('Query 1'));
  await language('zh-CN'); await change('SQL 参数', '[{}]'); await click('执行只读查询');
  assert.match(document.body.textContent, /最多包含 32 个标量参数/);
  await change('SQL 参数', '[]'); await click('执行只读查询'); await snapshot('zh-06-query');
  const callsBeforeSwitch = apiCalls.length;
  await language('en'); assert.match(document.body.textContent, /2 rows \/ 3 columns/);
  await language('zh-CN'); assert.equal(apiCalls.length, callsBeforeSwitch); assert.match(document.body.textContent, /2 行 \/ 3 列/);
  const originalQuery = context.database.query; let finishQuery;
  context.database.query = () => new Promise((resolve) => { finishQuery = resolve; });
  await click('执行只读查询'); assert.match(document.body.textContent, /正在等待宿主/);
  assert.ok('disabled' in button('执行只读查询').attributes);
  await language('en'); assert.match(document.body.textContent, /Waiting for host/);
  await language('zh-CN');
  await act(async () => { finishQuery({ columns: [], rows: [], changes: 1, elapsedMs: 3, truncated: true }); await tick(); });
  assert.match(document.body.textContent, /语句已执行，无结果行/);
  assert.match(document.body.textContent, /0 行 \/ 0 列 \/ 3 毫秒 \/ 1 处更改 \/ 已截断/);
  context.database.query = originalQuery;
  checks.push('pending host query localizes waiting state across language changes and displays empty/truncated completion');
  await click('AI SQL 助手'); assert.ok(byLabel('未执行的 AI 草稿')); assert.match(document.body.textContent, /此宿主不支持 AI 辅助/); await snapshot('ai-unavailable-zh-CN');
  checks.push('zh-CN schema/search/structure/data/query/status/unavailable AI UI; live locale preserves tabs, SQL, parameters, results and session without new host calls');
  await click('关闭连接'); await click('新建连接'); await click('下一步'); await change('SQLite 数据源', 'file');
  assert.match(document.body.textContent, /尚未选择文件/); chosen = file; await click('选择文件…');
  assert.match(document.body.textContent, /一次性 SQLite 文件（只读）/); failSave = true;
  await click('保存并连接'); assert.match(document.body.textContent, /宿主操作失败。宿主诊断：Synthetic keychain unavailable/);
  await language('en'); assert.match(document.body.textContent, /Synthetic keychain unavailable/);
  await language('zh-CN'); failSave = false; await click('保存并连接');
  assert.ok('disabled' in button('审查写入…').attributes); await click('取消 / 关闭');
  checks.push('zh-CN file chooser cancellation, readonly write control and translated host-error wrapper retain original diagnostics');
  await unmount(); saved = Array.from({ length: 21 }, (_, i) => ({ id: `zh-${i}`, name: `User ${i}`, color: 'default', engine: 'sqlite', targetKind: 'memory', readOnly: false }));
  await mount(); await event(byLabel('下一页连接'), { type: 'click' }); assert.ok(button('User 10')); await event(byLabel('上一页连接'), { type: 'click' }); assert.ok(button('User 0'));
  await unmount(); saved = []; features.delete('database.saved-connections.v1'); features.delete('database.sqlite-file-fixture.v1');
  await mount(); assert.match(document.body.textContent, /此宿主不支持保存连接/); await click('新建连接'); await click('下一步');
  await click('连接但不保存'); assert.match(document.body.textContent, /一次性 SQLite/); await language('en'); assert.match(document.body.textContent, /Disposable SQLite/);
  await unmount(); features.delete('database.sqlite-fixture.v1'); await language('zh-CN'); await mount();
  assert.match(document.body.textContent, /未启用或不可用/); assert.ok('disabled' in button('新建连接').attributes);
  await unmount(); features.add('database.sqlite-fixture.v1'); features.add('database.saved-connections.v1'); features.add('database.sqlite-file-fixture.v1');
  assert.equal(environmentListeners.size, 0); await language('en');
  checks.push('zh-CN connection pagination, old-host fallback, disabled experiment and environment subscription cleanup');
  const originalList = context.database.listSavedConnections;
  context.database.listSavedConnections = async () => { throw new Error('Synthetic denied'); };
  await language('zh-CN'); await mount();
  assert.match(document.body.textContent, /无法加载已保存的连接，请检查宿主权限/);
  await language('en'); assert.match(document.body.textContent, /Saved connections could not be loaded. Check host permission/);
  await unmount(); context.database.listSavedConnections = originalList;
  checks.push('saved-list permission failure localizes immediately and follows later host language changes');


  // AI is a host RPC client only. Fake events exercise the real React + remote DOM.
  features.add('ai.model-invocation'); saved = []; chosen = null;
  const aiCalls = []; let aiEvents = []; let aiRead; let aiMode = 'stream'; let aiNext = 0;
  const aiOk = async (method, params) => { aiCalls.push({ method, ...params }); return { ok: true }; };
  context.ai = {
    openChat: async (params) => { aiCalls.push({ method: 'open', ...params }); if (aiMode === 'denied' || aiMode === 'unconfigured') throw Error('PRIVATE_PROVIDER_DIAGNOSTIC'); return { chatHandle: `chat-${++aiNext}`, model: 'Synthetic stream fixture', expiresAt: 1 }; },
    startTurn: async (params) => { aiCalls.push({ method: 'start', ...params }); return { turnHandle: `turn-${aiNext}`, maxOutputTokens: 2048, reservedTokens: 2048 }; },
    readTurn: (params) => { aiCalls.push({ method: 'read', ...params }); return aiEvents.length ? Promise.resolve(aiEvents.shift()) : new Promise((resolve) => { aiRead = resolve; }); },
    stopTurn: (params) => aiOk('stop', params), closeChat: (params) => aiOk('close', params),
  };
  const finishAI = async (event) => { assert.ok(aiRead); const resolve = aiRead; aiRead = undefined; await act(async () => { resolve(event); await tick(); }); assert.deepEqual(policyErrors, []); };
  const queryCalls = () => apiCalls.filter((c) => c.operation === 'query').length;
  await mount(); await click('New Connection'); await click('Next'); await click('Save & Connect');
  let beforeAiQueries = queryCalls(); const beforeAiSql = byLabel('SQL statement').attributes.value;
  await click('AI SQL assistant'); assert.match(document.body.textContent, /checked when you run assistance/); assert.equal(aiCalls.length, 0);
  await change('Your request', 'Generate a SELECT of note titles.'); await click('Run assistance');
  assert.ok('disabled' in button('Run assistance').attributes); assert.match(document.body.textContent, /Synthetic stream fixture/);
  let envelope = JSON.parse(aiCalls.findLast((c) => c.method === 'start').prompt.split('BEGIN_UNTRUSTED_JSON\n')[1].split('\nEND_UNTRUSTED_JSON')[0]);
  assert.equal(envelope.task, 'generate'); assert.equal(envelope.engine, 'sqlite'); assert.equal(envelope.schema.tables[0].name, 'notes'); assert.equal(envelope.sql, beforeAiSql);
  assert.deepEqual(Object.keys(envelope).sort(), ['task', 'engine', 'dialect', 'connectionLabel', 'schema', 'sql', 'request'].sort());
  await finishAI({ kind: 'text', sequence: 1, text: 'SELECT title ' });
  assert.equal(textOf(byLabel('Unexecuted AI draft')), 'SELECT title '); assert.equal(byLabel('SQL statement').attributes.value, beforeAiSql);
  assert.ok('disabled' in button('Insert draft into editor').attributes);
  await language('zh-CN'); assert.ok(button('停止')); assert.ok(byLabel('SQL 辅助任务')); assert.ok(byLabel('你的请求'));
  await finishAI({ kind: 'text', sequence: 2, text: 'FROM notes;' }); await finishAI({ kind: 'end', sequence: 3 });
  await snapshot('ai-stream-zh-CN'); assert.equal(queryCalls(), beforeAiQueries); assert.equal(byLabel('SQL 语句').attributes.value, beforeAiSql);
  assert.deepEqual(aiCalls.slice(-2).map((c) => c.method), ['stop', 'close']);
  await click('将草稿插入编辑器'); assert.equal(byLabel('SQL 语句').attributes.value, 'SELECT title FROM notes;'); assert.equal(byLabel('SQL 参数').attributes.value, '[]'); assert.equal(queryCalls(), beforeAiQueries);
  await language('en'); await snapshot('ai-insert-unexecuted-en');
  await change('SQL statement', 'SELECT id FROM notes'); await click('Run read query');
  assert.equal(apiCalls.findLast((c) => c.operation === 'query').sql, 'SELECT id FROM notes');
  assert.equal(queryCalls(), beforeAiQueries + 1); beforeAiQueries = queryCalls();
  checks.push('explicit Run uses edited SQL, never the separate AI draft');
  checks.push('negotiated host AI starts only on click, streams schema-grounded text, en/zh-CN, cleans handles; insertion edits without query');
  for (const task of ['explain', 'optimize', 'fix']) {
    await change('SQL assistance task', task); aiEvents = [{ kind: 'text', sequence: 1, text: `Unexecuted ${task} fixture` }, { kind: 'end', sequence: 2 }];
    await click('Run assistance'); assert.match(aiCalls.findLast((c) => c.method === 'start').prompt, new RegExp(`"task":"${task}"`));
  }
  assert.equal(queryCalls(), beforeAiQueries); checks.push('all four tasks use bounded JSON envelope and never run SQL');
  aiEvents = [{ kind: 'text', sequence: 1, text: 'Partial SQL' }]; await click('Run assistance'); await click('Stop');
  assert.match(document.body.textContent, /Stopped - draft remains unexecuted/); assert.ok('disabled' in button('Insert draft into editor').attributes);
  await finishAI({ kind: 'text', sequence: 2, text: 'LATE-STOP' }); assert.doesNotMatch(document.body.textContent, /LATE-STOP/);
  aiEvents = []; await click('Run assistance'); await click('New Query'); await finishAI({ kind: 'text', sequence: 1, text: 'LATE-TAB' });
  assert.doesNotMatch(document.body.textContent, /LATE-TAB|Partial SQL/);
  await click('Run assistance'); await click('Close connection'); await finishAI({ kind: 'text', sequence: 1, text: 'LATE-DISCONNECT' });
  assert.doesNotMatch(document.body.textContent, /LATE-DISCONNECT/); await click('Synthetic SQLite');
  await click('Run assistance'); await click('AI SQL assistant'); await finishAI({ kind: 'text', sequence: 1, text: 'LATE-HIDE' });
  await click('AI SQL assistant'); assert.doesNotMatch(document.body.textContent, /LATE-HIDE/);
  checks.push('Stop, tab switch, disconnect and panel hide cancel and close; stale AI output cannot cross generations');
  for (const mode of ['denied', 'unconfigured']) {
    aiMode = mode; await click('Run assistance'); assert.match(document.body.textContent, /Unavailable/); assert.match(document.body.textContent, /Check host model configuration and AI permission/);
    assert.doesNotMatch(document.body.textContent, /PRIVATE_PROVIDER_DIAGNOSTIC/);
    await language('zh-CN'); assert.match(document.body.textContent, /AI 不可用。请检查宿主模型配置和 AI 权限/); await snapshot(`ai-${mode}-zh-CN`); await language('en');
  }
  aiMode = 'stream'; aiEvents = [{ kind: 'tool', sequence: 1, name: 'query', sql: 'DELETE FROM notes' }]; await click('Run assistance');
  assert.match(document.body.textContent, /AI output was rejected/); assert.equal(queryCalls(), beforeAiQueries);
  aiEvents = [{ kind: 'text', sequence: 1, text: 'x'.repeat(8193) }]; await click('Run assistance'); assert.match(document.body.textContent, /draft limit exceeded/);
  aiEvents = [{ kind: 'end', sequence: 1 }]; await click('Run assistance'); assert.match(document.body.textContent, /returned no draft/);
  checks.push('permission denial, missing model, unsupported tool, oversized and empty output show honest localized errors with no execution');
  aiEvents = [{ kind: 'text', sequence: 1, text: 'x'.repeat(8192) }, { kind: 'end', sequence: 2 }]; await click('Run assistance');
  assert.equal(textOf(byLabel('Unexecuted AI draft')).length, 8192); assert.deepEqual(policyErrors, []);
  await click('Run assistance'); await unmount(); await finishAI({ kind: 'text', sequence: 1, text: 'LATE-UNMOUNT' });
  assert.equal(aiCalls.filter((c) => c.method === 'stop').length, aiCalls.filter((c) => c.method === 'start').length);
  assert.equal(aiCalls.filter((c) => c.method === 'close').length, aiCalls.filter((c) => c.method === 'start').length);
  assert.equal(queryCalls(), beforeAiQueries); features.delete('ai.model-invocation');
  checks.push('8 KiB draft fits actual remote-DOM policy; unmount cancels, all opened handles closed, zero AI-driven database calls');

  // Synthetic tunnel UI regression lane: recorded outcomes only, no SSH sockets.
  await language('en'); saved = []; hostCount = 2;
  const metadataHosts = context.database.listHostsForDatabase;
  context.database.listHostsForDatabase = async () => [...await metadataHosts(), {
    hostId: 'synthetic-probe', label: 'Synthetic adapter (no SSH)', hostname: '127.0.0.1', port: 2222, username: 'smoketest',
    capability: 'metadata-only', tunnelAvailable: false, tunnelTest: { kind: 'synthetic', revision: 'revision-one' },
  }];
  let probeOutcome = 'SYNTHETIC_OK'; let probeFinish; const probes = []; const cancelledProbes = [];
  const probeResult = (code) => ({ code, status: code === 'SYNTHETIC_OK' ? 'synthetic-passed' : 'failed', synthetic: true, connected: false, closed: true, ...(code === 'SYNTHETIC_OK' ? { secretRef: 'opaque-synthetic-probe-reference' } : {}) });
  context.database.testTunnel = async (request) => { probes.push(request); return probeOutcome === 'pending' ? new Promise((resolve) => { probeFinish = resolve; }) : probeResult(probeOutcome); };
  context.database.cancelTunnelTest = async ({ testId }) => { cancelledProbes.push(testId); return null; };
  await mount(); await click('New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts');
  await change('Existing host', 'synthetic-probe'); assert.ok('disabled' in button('Test tunnel (synthetic)').attributes);
  await unmount(); features.add('database.tunnel-test.synthetic.v1');
  await mount(); await click('New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts');
  await change('Existing host', 'host-1'); assert.ok('disabled' in button('Test tunnel (synthetic)').attributes);
  const opensBeforeProbe = opens;
  await change('Existing host', 'synthetic-probe'); assert.equal(probes.length, 0);
  assert.match(document.body.textContent, /Active connections: 0/); assert.match(document.body.textContent, /No tunnel test has run/);
  await click('Test tunnel (synthetic)'); assert.match(document.body.textContent, /Synthetic tunnel test passed. No SSH or PostgreSQL connection was opened/);
  assert.equal(opens, opensBeforeProbe); assert.match(document.body.textContent, /Active connections: 0/);
  assert.deepEqual(Object.keys(probes[0]).sort(), ['hostId', 'revision', 'testId']);
  assert.doesNotMatch(JSON.stringify(tree), /opaque-synthetic-probe-reference/);
  await snapshot('tunnel-synthetic-passed-not-connected');
  await click('New Connection'); await click('Next'); await click('Advanced');
  assert.match(document.body.textContent, /No tunnel test has run/);
  await change('Existing host', 'synthetic-probe');
  for (const [code, text] of [['AUTH_FAILED', /Synthetic tunnel authentication failed/], ['UNKNOWN_HOST_KEY', /Unknown host key/], ['HOST_KEY_MISMATCH', /Host key mismatch/]]) {
    probeOutcome = code; await click('Test tunnel (synthetic)'); assert.match(document.body.textContent, text);
    assert.match(document.body.textContent, /Active connections: 0/);
    if (code === 'AUTH_FAILED') await snapshot('tunnel-synthetic-wrong-auth');
  }
  probeOutcome = 'pending'; await click('Test tunnel (synthetic)'); await click('Cancel tunnel test');
  assert.equal(cancelledProbes.at(-1), probes.at(-1).testId);
  assert.match(document.body.textContent, /Tunnel test cancellation requested/);
  await act(async () => { probeFinish(probeResult('SYNTHETIC_OK')); await tick(); });
  assert.doesNotMatch(document.body.textContent, /Synthetic tunnel test passed/);
  await click('Test tunnel (synthetic)'); await change('Existing host', 'host-1');
  await act(async () => { probeFinish(probeResult('SYNTHETIC_OK')); await tick(); });
  assert.match(document.body.textContent, /No tunnel test has run/);
  await change('Existing host', 'synthetic-probe'); probeOutcome = 'SYNTHETIC_OK';
  await language('zh-CN'); await click('测试隧道（模拟）'); assert.match(document.body.textContent, /模拟隧道测试通过。未建立 SSH 或 PostgreSQL 连接/);
  probeOutcome = 'AUTH_FAILED'; await click('测试隧道（模拟）'); assert.match(document.body.textContent, /模拟隧道身份验证失败/);
  await snapshot('tunnel-synthetic-zh-CN-failure');
  await language('en'); probeOutcome = 'pending'; await click('Test tunnel (synthetic)'); await click('Close');
  assert.equal(cancelledProbes.at(-1), probes.at(-1).testId);
  await act(async () => { probeFinish(probeResult('SYNTHETIC_OK')); await tick(); });
  assert.match(document.body.textContent, /Active connections: 0/); assert.equal(opens, opensBeforeProbe);
  await click('New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts'); await change('Existing host', 'synthetic-probe');
  await click('Test tunnel (synthetic)'); await unmount(); assert.equal(cancelledProbes.at(-1), probes.at(-1).testId);
  await act(async () => { probeFinish(probeResult('SYNTHETIC_OK')); await tick(); });
  features.delete('database.tunnel-test.synthetic.v1'); context.database.listHostsForDatabase = metadataHosts;
  checks.push('synthetic tunnel feature gate, metadata-only selection, recorded success without connection, wrong auth/key failures, cancellation and stale completion, secretRef-only requests, zh-CN, close and unmount cleanup');

  // Ordinary saved-host probe UI: mock races/timeouts, plus actual host RPC/TCP fixture when opted in.
  const portFeature = 'database.host-port-probe.v1';
  const ordinaryHost = { hostId: 'ordinary-probe', hostname: '127.0.0.1', label: 'Saved loopback host', username: 'smoketest', port: 2222, capability: 'metadata-only', tunnelAvailable: false, portProbe: { revision: 'ordinary-revision' } };
  context.database.listHostsForDatabase = async () => [ordinaryHost];
  const portRequests = []; const portCancels = []; let portFinish; let portPending = false;
  const portResult = { hostId: ordinaryHost.hostId, hostname: ordinaryHost.hostname, code: 'PROBE_OK', synthetic: false, connected: false,
    ports: [[5432, 'PostgreSQL', 'open'], [3306, 'MySQL / MariaDB', 'closed'], [1433, 'Microsoft SQL Server', 'timeout'], [27017, 'MongoDB', 'closed'], [6379, 'Redis', 'closed']].map(([port, serviceLabel, status]) => ({ port, serviceLabel, status, latencyMs: 2 })) };
  context.database.probeHostDatabasePorts = async (request) => { portRequests.push(request); return portPending ? new Promise((resolve) => { portFinish = resolve; }) : portResult; };
  context.database.cancelHostDatabasePorts = async ({ probeId }) => { portCancels.push(probeId); return null; };
  await language('en'); await mount(); await click('New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts');
  await change('Existing host', ordinaryHost.hostId); assert.ok('disabled' in button('Probe common database ports').attributes);
  await unmount(); features.add(portFeature);
  await mount(); await click('New Connection'); await click('Next'); await click('Advanced');
  assert.ok('disabled' in button('Probe common database ports').attributes);
  await click('Load permitted hosts'); await change('Existing host', ordinaryHost.hostId);
  assert.equal(portRequests.length, 0); const beforePortOpens = opens;
  assert.match(document.body.textContent, /No database connected/);
  await click('Probe common database ports');
  assert.equal(opens, beforePortOpens); assert.match(document.body.textContent, /5432 PostgreSQL: open/);
  assert.match(document.body.textContent, /1433 Microsoft SQL Server: timeout/);
  assert.match(document.body.textContent, /3306 MySQL \/ MariaDB: closed/);
  assert.match(document.body.textContent, /An open port is not an authenticated database session or an SSH tunnel/);
  assert.match(document.body.textContent, /No database connected/);
  assert.deepEqual(Object.keys(portRequests[0]).sort(), ['hostId', 'probeId', 'revision']);
  await snapshot('port-probe-en-mock-statuses');
  await language('zh-CN');
  assert.match(document.body.textContent, /5432 PostgreSQL: 开放/); assert.match(document.body.textContent, /1433 Microsoft SQL Server: 超时/);
  assert.match(document.body.textContent, /端口开放不等于数据库身份验证成功/); assert.match(document.body.textContent, /未连接数据库/);
  await snapshot('port-probe-zh-CN-mock-statuses'); await language('en');
  portPending = true; await click('Probe common database ports'); await click('Cancel port probe');
  assert.equal(portCancels.at(-1), portRequests.at(-1).probeId);
  await act(async () => { portFinish(portResult); await tick(); });
  assert.doesNotMatch(document.body.textContent, /5432 PostgreSQL: open/);
  await click('Probe common database ports'); await change('Existing host', '');
  await act(async () => { portFinish(portResult); await tick(); }); assert.match(document.body.textContent, /No port probe has run/);
  await change('Existing host', ordinaryHost.hostId); await click('Probe common database ports'); await click('Load permitted hosts');
  await act(async () => { portFinish(portResult); await tick(); }); assert.match(document.body.textContent, /No port probe has run/);
  await click('Probe common database ports'); await click('Close'); assert.equal(portCancels.at(-1), portRequests.at(-1).probeId);
  await act(async () => { portFinish(portResult); await tick(); });
  await click('New Connection'); await click('Next'); await click('Advanced'); await change('Existing host', ordinaryHost.hostId);
  await click('Probe common database ports'); await unmount(); assert.equal(portCancels.at(-1), portRequests.at(-1).probeId);
  await act(async () => { portFinish(portResult); await tick(); });
  checks.push('ordinary saved-host port probe: absent feature/selection gates; open/closed/timeout in en and zh-CN; no DB session; cancel, selection, reload, close and unmount races');
  if (process.env.NETCATTY_TEST_PREPARED_DB_PROBE === '1') {
    const { PluginSqliteFixtureService: ProbeHost } = host('./electron/plugins/sqliteFixtureService.cjs');
    const { PluginHostRpcRegistry: ProbeRegistry } = host('./electron/plugins/hostRpcRegistry.cjs');
    const { DatabaseHostPortProbeService } = host('./electron/plugins/databaseHostPortProbe.cjs');
    const probeIdentity = { pluginId: 'com.binaricat.netcatty-database', pluginVersion: '0.1.0', runtimeId: 'port-probe-ui', runtimeKind: 'browser', sourceOwner: 'owner-probe', sourceId: 'probe', securityPrincipal: 'fixture', manifest: { features: { optional: [...features] } } };
    const probeService = new ProbeHost({ enabled: true, connectionStore: {}, portProbes: new DatabaseHostPortProbeService(),
      getDatabaseHosts: async () => ({ ok: true, hosts: [{ id: ordinaryHost.hostId, hostname: '127.0.0.1', label: 'Saved loopback host', username: 'smoketest', port: 2222 }] }),
      database: { getActivePlugin: () => ({ enabled: true, source: { id: 'probe' } }), getRetainedPluginSource: () => ({ id: 'probe' }), privateOwner: () => 'owner-probe', publicPluginId: () => probeIdentity.pluginId },
      runtimeSupervisor: { getRuntimeIdentity: () => probeIdentity },
      permissionEngine: { onDidRevoke: () => ({ dispose() {} }), authorize: async (_c, d) => d.validateBeforeGrant() },
    });
    const probeRegistry = new ProbeRegistry(); probeService.register(probeRegistry);
    const probeRoutes = probeRegistry.createRoutes({ ...probeIdentity, assertCurrent() {} });
    for (const method of ['listHostsForDatabase', 'probeHostDatabasePorts', 'cancelHostDatabasePorts']) context.database[method] = (params = {}) => probeRoutes.requestHandlers[`database.${method}`](params, { signal: new AbortController().signal });
    try {
      await mount(); await click('New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts'); await change('Existing host', ordinaryHost.hostId);
      await click('Probe common database ports');
      for (let tries = 0; tries < 100 && !document.body.textContent.includes('Port probe complete.'); tries++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      assert.match(document.body.textContent, /5432 PostgreSQL: open/);
      for (const label of ['3306 MySQL / MariaDB: closed', '1433 Microsoft SQL Server: closed', '27017 MongoDB: closed', '6379 Redis: closed']) assert.ok(document.body.textContent.includes(label), label);
      assert.match(document.body.textContent, /No database connected/); assert.equal(probeService.sessions.size, 0);
      await snapshot('port-probe-en-real-tcp'); await language('zh-CN'); await snapshot('port-probe-zh-CN-real-tcp'); await language('en');
      checks.push('prepared fixture through real host registry, authorization seam and TCP: 5432 open; 3306/1433/27017/6379 closed; session count remains zero');
    } finally { await unmount(); probeService.shutdown(); }
  }
  features.delete(portFeature); context.database.listHostsForDatabase = metadataHosts;

  // Separate live fixture lane: UI mock races followed by real host RPC/SSH/PG.
  const liveFeature = 'database.host-live-ssh-pg.fixture.v1';
  const liveLabel = 'Test live SSH→PostgreSQL (fixture)';
  const liveHost = { hostId: 'live-fixture', hostname: '127.0.0.1', port: 2222, username: 'smoketest', label: 'Live fixture only', capability: 'metadata-only', tunnelAvailable: false, liveSshPg: { kind: 'fixture', revision: 'revision' } };
  const liveSuccess = { code: 'LIVE_OK', fixture: true, synthetic: false, connected: true, sessionId: 'live-session', expiresAt: Date.now() + 30000, proof: { query: 'SELECT 1', value: 1, pinnedHostKey: true }, secretRef: 'opaque-live-reference', pgSecretRef: 'opaque-pg-reference' };
  const liveCalls = []; const liveCloses = []; const liveCancels = []; let liveFinish; let liveOutcome = 'LIVE_OK';
  context.database.listHostsForDatabase = async () => [...await metadataHosts(), liveHost];
  context.database.openHostLiveSshPgFixture = async (request) => { liveCalls.push(request); return liveOutcome === 'pending' ? new Promise((r) => { liveFinish = r; }) : liveOutcome === 'LIVE_OK' ? liveSuccess : { code: liveOutcome, fixture: true, synthetic: false, connected: false }; };
  context.database.closeHostLiveSshPgSession = async ({ sessionId }) => { liveCloses.push(sessionId); return { closed: true, connected: false, fixture: true }; };
  context.database.cancelHostLiveSshPgFixture = async ({ openId }) => { liveCancels.push(openId); return null; };
  const openAdvanced = async () => { await mount(); await click('New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts'); };
  await openAdvanced(); await change('Existing host', liveHost.hostId); assert.ok('disabled' in button(liveLabel).attributes); await unmount();
  features.add(liveFeature); await openAdvanced(); await change('Existing host', 'host-1'); assert.ok('disabled' in button(liveLabel).attributes);
  await change('Existing host', liveHost.hostId); assert.equal(liveCalls.length, 0); assert.match(document.body.textContent, /Active connections: 0/);
  await click(liveLabel); assert.match(document.body.textContent, /Live fixture passed: pinned SSH/); assert.equal(liveCloses.length, 1);
  assert.deepEqual(Object.keys(liveCalls[0]).sort(), ['hostId', 'openId', 'revision']); assert.match(document.body.textContent, /Active connections: 0/);
  assert.doesNotMatch(JSON.stringify(tree), /opaque-live-reference|opaque-pg-reference/);
  for (const code of ['AUTH_FAILED', 'HOST_KEY_MISMATCH', 'STALE_HOST', 'CANCELLED']) { liveOutcome = code; await click(liveLabel); assert.doesNotMatch(document.body.textContent, /Live fixture passed:/); }
  liveOutcome = 'pending'; await click(liveLabel); await click('Cancel live fixture test');
  assert.equal(liveCancels.at(-1), liveCalls.at(-1).openId);
  await act(async () => { liveFinish(liveSuccess); await tick(); }); assert.doesNotMatch(document.body.textContent, /Live fixture passed:/); assert.equal(liveCloses.length, 2);
  await click(liveLabel); await change('Existing host', 'host-1'); await act(async () => { liveFinish(liveSuccess); await tick(); }); assert.equal(liveCloses.length, 3);
  await change('Existing host', liveHost.hostId); liveOutcome = 'LIVE_OK';
  await language('zh-CN'); await click('测试真实 SSH→PostgreSQL（测试环境）'); assert.match(document.body.textContent, /真实连接测试通过/); await snapshot('live-fixture-zh-CN-mock'); await language('en');
  liveOutcome = 'pending'; await click(liveLabel); await unmount(); await act(async () => { liveFinish(liveSuccess); await tick(); }); assert.equal(liveCloses.length, 5);
  liveOutcome = 'LIVE_OK';
  const closeLive = context.database.closeHostLiveSshPgSession;
  context.database.closeHostLiveSshPgSession = async () => { throw new Error('fixture cleanup failed'); };
  await openAdvanced(); await change('Existing host', liveHost.hostId); await click(liveLabel);
  assert.match(document.body.textContent, /Live fixture test or session cleanup failed/); assert.doesNotMatch(document.body.textContent, /Live fixture passed:/);
  assert.match(document.body.textContent, /Active connections: 0/); context.database.closeHostLiveSshPgSession = closeLive; await unmount();
  checks.push('live fixture feature/host gates, metadata never connected, close-before-success, en/zh-CN, cancel/selection/unmount late success cleanup; mock evidence only');
  if (process.env.NETCATTY_TEST_LIVE_SSH_PG === '1') {
    const { PluginSqliteFixtureService: LiveHostService } = host('./electron/plugins/sqliteFixtureService.cjs');
    const { PluginHostRpcRegistry: LiveRegistry } = host('./electron/plugins/hostRpcRegistry.cjs');
    const { DatabaseHostLiveSshPgService } = host('./electron/plugins/databaseHostLiveSshPg.cjs');
    const { PluginSecretStore } = host('./electron/plugins/secretStore.cjs');
    const { randomBytes, createCipheriv, createDecipheriv } = host('node:crypto');
    const key = randomBytes(32); const records = new Map();
    // Explicit AES-GCM test backend; this lane does not qualify OS safeStorage.
    const secretStore = new PluginSecretStore({ database: { privateOwner: (id) => id,
      getSecretByKey: (id, k) => records.get(`${id}:${k}`), getSecretByRef: (id, ref) => [...records.values()].find((r) => r.pluginId === id && r.secretRef === ref), upsertSecret: (r) => records.set(`${r.pluginId}:${r.key}`, r) },
      safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-aes-gcm',
        encryptString: (s) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(s), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
        decryptString: (b) => { const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(); } } });
    const liveService = new DatabaseHostLiveSshPgService({ secretStore });
    const id = { pluginId: 'com.binaricat.netcatty-database', pluginVersion: '0.1.0', runtimeId: 'live-ui', runtimeKind: 'browser', sourceOwner: 'owner-live', sourceId: 'live', securityPrincipal: 'fixture', manifest: { features: { optional: [...features] } } };
    const svc = new LiveHostService({ enabled: true, connectionStore: {}, liveSshPg: liveService, getDatabaseHosts: async () => ({ ok: true, hosts: [] }),
      database: { getActivePlugin: () => ({ enabled: true, source: { id: 'live' } }), getRetainedPluginSource: () => ({ id: 'live' }), privateOwner: () => id.sourceOwner, publicPluginId: () => id.pluginId },
      runtimeSupervisor: { getRuntimeIdentity: () => id }, permissionEngine: { onDidRevoke: () => ({ dispose() {} }), authorize: async (_c, d) => d.validateBeforeGrant() } });
    const registry = new LiveRegistry(); svc.register(registry); const routes = registry.createRoutes({ ...id, assertCurrent() {} });
    let proof;
    for (const method of ['listHostsForDatabase', 'openHostLiveSshPgFixture', 'cancelHostLiveSshPgFixture', 'closeHostLiveSshPgSession']) context.database[method] = async (params = {}) => {
      realPending++;
      try { const result = await routes.requestHandlers[`database.${method}`](params, { signal: new AbortController().signal }); if (method === 'openHostLiveSshPgFixture') proof = result; return result; } finally { realPending--; }
    };
    try {
      await openAdvanced(); await change('Existing host', liveService.metadata().hostId); assert.equal(liveService.sessions.size, 0);
      await click(liveLabel); assert.equal(proof.code, 'LIVE_OK'); assert.equal(proof.proof.value, 1);
      assert.match(document.body.textContent, /Live fixture passed: pinned SSH/); assert.match(document.body.textContent, /Test session closed/);
      assert.equal(liveService.sessions.size, 0); assert.equal(liveService.adapter.active, 0); assert.match(document.body.textContent, /Active connections: 0/);
      await snapshot('live-fixture-en-real-host-api'); await language('zh-CN'); await snapshot('live-fixture-zh-CN-real-host-api'); await language('en');
      await writeFile(`${evidence}/live-host-proof.json`, JSON.stringify({ host_api: true, code: proof.code, fixture: proof.fixture, proof: proof.proof, sessions_after_close: liveService.sessions.size, adapter_active_after_close: liveService.adapter.active, native_safeStorage: false }, null, 2));
      checks.push('REAL host registry -> pinned sshd 2222 -> forwarded PG 5432 -> SELECT 1=1 -> explicit close; en/zh-CN HTML; AES-GCM test SecretStore backend');
    } finally { await unmount(); svc.shutdown(); }
  }
  features.delete(liveFeature); context.database.listHostsForDatabase = metadataHosts;

  // The new multi-table lane uses the real host registry/service/subprocess.
  // Only native chooser and permission decisions are injected for this fixture.
  const { PluginSqliteFixtureService } = host('./electron/plugins/sqliteFixtureService.cjs');
  const { PluginHostRpcRegistry } = host('./electron/plugins/hostRpcRegistry.cjs');
  const { DatabaseConnectionStore } = host('./electron/plugins/databaseConnectionStore.cjs');
  const identity = { pluginId: 'com.binaricat.netcatty-database', pluginVersion: '0.1.0', runtimeId: 'm3b-ui', runtimeKind: 'browser', sourceOwner: 'owner-fixture', sourceId: 'fixture', securityPrincipal: 'synthetic', manifest: { features: { optional: [...features] } } };
  const fs = host('node:fs');
  const storeFile = `${evidence}/tmp/ui-connections.json`;
  fs.rmSync(storeFile, { force: true });
  let selectedSqliteFile = '/workspace/agent-tools/database/m3b-multitable/fixtures/commerce.sqlite';
  const service = new PluginSqliteFixtureService({ enabled: true,
    connectionStore: new DatabaseConnectionStore(storeFile),
    database: { getActivePlugin: () => ({ enabled: true, source: { id: 'fixture' } }), getRetainedPluginSource: () => ({ id: 'fixture' }), privateOwner: () => 'owner-fixture', publicPluginId: () => identity.pluginId },
    runtimeSupervisor: { getRuntimeIdentity: () => identity },
    permissionEngine: { onDidRevoke: () => ({ dispose() {} }), authorize: async (_c, d) => d.validateBeforeGrant() },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedSqliteFile] }), showMessageBox: async () => { throw new Error('File writes must never prompt'); } },
  });
  const registry = new PluginHostRpcRegistry(); service.register(registry);
  const routes = registry.createRoutes({ ...identity, assertCurrent() {} });
  const dbCalls = [];
  context.database = Object.fromEntries(Object.keys(context.database).map((method) => [method, async (params) => {
    dbCalls.push({ method, ...params });
    realPending++;
    try { return await routes.requestHandlers[`database.${method}`](params, { signal: new AbortController().signal }); } finally { realPending--; }
  }]));
  try {
    await mount(); await click('New Connection'); await click('Next');
    await change('Connection name', 'Synthetic commerce (local)'); await change('SQLite source', 'file');
    await click('Test'); await click('Save & Connect');
    for (const name of ['customers', 'order_items', 'orders', 'products']) assert.ok(byLabel(`Open table ${name}`));
    assert.ok(byLabel('Open view order_totals')); assert.ok(button('Tables (4)')); assert.ok(button('Views (1)'));
    assert.match(byLabel('SQL statement').attributes.value, /customers/); assert.doesNotMatch(byLabel('SQL statement').attributes.value, /notes/);
    checks.push('real host readSchema populates four tables and one view; initial query uses actual schema');
    await event(byLabel('Toggle Tables'), { type: 'click' }); assert.equal(byLabel('Open table customers'), undefined);
    await event(byLabel('Toggle Tables'), { type: 'click' }); await change('Search schema objects', 'total');
    assert.equal(byLabel('Open table customers'), undefined); assert.ok(byLabel('Open view order_totals'));
    await change('Search schema objects', '');
    await event(byLabel('Toggle main schema'), { type: 'click' }); assert.equal(byLabel('Open view order_totals'), undefined);
    await event(byLabel('Toggle main schema'), { type: 'click' });
    await event(byLabel('Toggle connection schema'), { type: 'click' }); assert.equal(byLabel('Toggle main schema'), undefined);
    await event(byLabel('Toggle connection schema'), { type: 'click' });
    checks.push('connection/main/category expansion and schema object search');
    await event(byLabel('Open table customers'), { type: 'click' });
    assert.ok(byLabel('Structure of customers')); assert.equal(byLabel('SQL statement'), undefined);
    const rows = [...document.querySelectorAll('.structure tbody tr')].map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent));
    assert.deepEqual(rows, [['1','id','INTEGER','No','Yes'], ['2','name','TEXT','No','No'], ['3','email','TEXT','Yes','No'], ['4','region','TEXT','No','No']]);
    assert.equal(document.querySelectorAll('.structure input,.structure textarea,.structure button').length, 0);
    await snapshot('05-commerce-structure');
    checks.push('real readonly customer structure shows columns/types/nullability/PK without mutation controls');
    await click('Data'); await click('Run read query'); assert.equal(document.querySelectorAll('.results tbody tr').length, 3);
    assert.deepEqual([...document.querySelectorAll('.result-type')].map((n) => n.textContent), ['INTEGER', 'TEXT', 'TEXT', 'TEXT']);
    await change('SQL statement', "SELECT 'arbitrary' AS id FROM customers");
    assert.equal(document.querySelector('.result-type').textContent, 'INTEGER', 'unexecuted edits retain the displayed result provenance');
    await click('Run read query');
    assert.equal(document.querySelector('.result-type').textContent, '—', 'arbitrary SQL never inherits a same-named schema type');
    await change('SQL statement', 'SELECT * FROM "main"."customers"'); await click('Run read query');
    checks.push('generated SELECT headers use real schema types; unexecuted edits preserve result provenance; arbitrary SQL types remain unknown');
    await snapshot('06-commerce-data');
    await event(byLabel('Open table order_items'), { type: 'click' });
    assert.equal([...document.querySelectorAll('.structure tbody tr')].filter((row) => row.lastElementChild.textContent === 'Yes').length, 2);
    await event(byLabel('Open view order_totals'), { type: 'click' });
    assert.match(document.body.textContent, /View nullability is not inferred/); assert.match(document.body.textContent, /Unknown/);
    await click('Data'); await click('Run read query'); assert.equal(document.querySelectorAll('.results tbody tr').length, 3);
    checks.push('real table data, composite PK structure and view data/unknown nullability');
    await click('Query 1');
    await change('SQL statement', 'SELECT customer, total_cents FROM order_totals WHERE status = ? ORDER BY order_id');
    await change('SQL parameters', '["paid"]'); await click('Run read query');
    assert.deepEqual([...document.querySelectorAll('.results tbody tr')].map((row) => row.lastElementChild.textContent), ['7400','3600']);
    assert.match(document.body.textContent, /2 rows \/ 2 columns \/ \d+ ms \/ 0 changes/);
    assert.ok(dbCalls.findLast((c) => c.method === 'query').revision); await snapshot('07-commerce-bound-query');
    checks.push('real bound multi-table view query returns 7400/3600 cents with revision and rows/ms status');
    await change('SQL statement', 'DELETE FROM customers'); await change('SQL parameters', '[]'); await click('Run read query');
    assert.match(document.body.textContent, /Statement rejected/); assert.ok('disabled' in button('Review write...').attributes);
    await click('Close connection'); await unmount(); await mount(); await click('Synthetic commerce (local)');
    await event(byLabel('Open table customers'), { type: 'click' }); assert.ok(byLabel('Structure of customers'));
    await click('Data'); await click('Run read query'); assert.equal(document.querySelectorAll('.results tbody tr').length, 3);
    checks.push('file mutation denied, close/fresh mount/saved reopen revalidates real schema and original rows');
    await click('Cancel / close'); assert.equal(service.sessions.size, 0);
    selectedSqliteFile = '/workspace/agent-tools/database/m2-chooser/fixtures/gate-c-corpus-wal-notes.sqlite';
    await click('New Connection'); await click('Next'); await change('SQLite source', 'file');
    assert.match(document.body.textContent, /Fixture WAL writer checks/);
    await change('Connection name', 'Gate E WAL snapshot'); await click('Save & Connect'); await click('Run read query');
    assert.match(document.body.textContent, /Uncheckpointed gate C note/);
    assert.ok('disabled' in button('Review write...').attributes);
    await language('zh-CN'); assert.match(document.body.textContent, /Uncheckpointed gate C note/);
    await language('en'); await click('Cancel / close');
    checks.push('real host WAL snapshot renders committed uncheckpointed notes; readonly across locale changes');
    const corpus = host('./scripts/sqlite-malformed-fixture.cjs').buildMalformedCorpus();
    try {
      for (const feature of ['database.sqlite-fd-identity.fixture.v1', 'database.sqlite-wal-checkpoint.fixture.v1', 'database.sqlite-wal-capture.fixture.v1', 'database.sqlite-malformed-reject.fixture.v1']) features.add(feature);
      identity.manifest.features.optional = [...features];
      selectedSqliteFile = corpus.entries.find((entry) => entry.name === 'corrupt-wal-page').file;
      const readsBefore = dbCalls.filter((c) => ['readSchema', 'query'].includes(c.method)).length;
      await click('New Connection'); await click('Next'); await change('SQLite source', 'file');
      assert.match(document.body.textContent, /SQLite target is stale or unavailable/);
      assert.match(document.body.textContent, /fixed malformed test corpus before opening/);
      assert.ok('disabled' in button('Save & Connect').attributes);
      assert.equal(service.sessions.size, 0); assert.equal(service.pendingFiles.size, 0);
      assert.equal(document.querySelectorAll('.results tbody tr').length, 0);
      assert.equal(dbCalls.filter((c) => ['readSchema', 'query'].includes(c.method)).length, readsBefore);
      await language('zh-CN'); assert.match(document.body.textContent, /宿主操作失败。宿主诊断：SQLite target is stale or unavailable/);
      assert.match(document.body.textContent, /固定的损坏测试样本集/);
      await snapshot('gate-i-malformed-reject-zh-CN'); await language('en');
      selectedSqliteFile = corpus.entries.find((entry) => entry.name === 'good').file;
      await click('Choose file...'); await change('Connection name', 'Gate I healthy control'); await click('Save & Connect');
      await change('SQL statement', 'SELECT count(*) FROM notes'); await change('SQL parameters', '[]'); await click('Run read query');
      assert.ok(document.querySelector('.results tbody tr'), document.body.textContent);
      assert.equal(document.querySelector('.results tbody tr').lastElementChild.textContent, '40');
      await click('Cancel / close'); assert.equal(service.sessions.size, 0);
      checks.push('REAL host rejects checksum-valid corrupt WAL before UI schema/query/rows; localized bounded error, explicit healthy reselection returns 40 rows');
    } finally { corpus.cleanup(); }


    // Gate J uses the unchanged separate-process fixture writer, not a product write API.
    const { fork } = host('node:child_process');
    const writer = fork(path.join(hostRoot, 'scripts/sqlite-wal-concurrent-fixture.cjs'), [], { execArgv: [], env: { ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let requestId = 0;
    const writerCall = (operation) => new Promise((resolve, reject) => {
      const id = String(++requestId); const timer = setTimeout(() => { writer.off('message', receive); reject(new Error('Writer deadline')); }, 5000);
      const receive = (message) => { if (message.id !== id) return; clearTimeout(timer); writer.off('message', receive); message.error ? reject(new Error('Writer failed')) : resolve(message.result); };
      writer.on('message', receive); writer.send({ id, operation });
    });
    let writerFile;
    try {
      writerFile = (await writerCall('create')).file; selectedSqliteFile = writerFile;
      features.add('database.sqlite-wal-session-refresh.fixture.v1'); identity.manifest.features.optional = [...features];
      await click('New Connection'); await click('Next'); await change('SQLite source', 'file');
      assert.match(document.body.textContent, /pause all writers through refresh and reads/);
      await change('Connection name', 'Gate J explicit refresh'); await click('Save & Connect');
      await change('SQL statement', 'SELECT id FROM notes ORDER BY id'); await change('SQL parameters', '[]'); await click('Run read query');
      const chooserCount = dbCalls.filter((c) => c.method === 'openSqliteFile').length;
      const first = [...service.sessions.values()][0]; const handleId = first.handleId; let previousRevision = first.revision;
      for (let count = 3; count <= 5; count++) {
        await writerCall('commit'); await click('Refresh WAL fixture');
        assert.equal(document.querySelectorAll('.results tbody tr').length, 0, 'refresh clears old rows; no automatic query');
        const fresh = [...service.sessions.values()][0]; assert.equal(fresh.handleId, handleId); assert.notEqual(fresh.revision, previousRevision); previousRevision = fresh.revision;
        await click('Run read query');
        assert.deepEqual([...document.querySelectorAll('.results tbody tr')].map((row) => row.lastElementChild.textContent), Array.from({ length: count }, (_, n) => String(n + 1)));
      }
      assert.equal(dbCalls.filter((c) => c.method === 'openSqliteFile').length, chooserCount);
      const refreshCount = dbCalls.filter((c) => c.method === 'refreshSqliteFile').length;
      await language('zh-CN'); assert.ok(button('刷新 WAL 测试文件')); assert.match(document.body.textContent, /刷新及读取期间需暂停所有写入/);
      await snapshot('gate-j-refresh-zh-CN'); await language('en'); await tick();
      assert.equal(dbCalls.filter((c) => c.method === 'refreshSqliteFile').length, refreshCount, 'locale changes do not poll');
      for (const dependency of ['database.sqlite-fixture.v1', 'database.sqlite-file-fixture.v1', 'database.sqlite-fd-identity.fixture.v1', 'database.sqlite-wal-readonly.fixture.v1', 'database.sqlite-wal-concurrent.fixture.v1', 'database.sqlite-wal-checkpoint.fixture.v1', 'database.sqlite-wal-capture.fixture.v1', 'database.sqlite-malformed-reject.fixture.v1', 'database.sqlite-wal-session-refresh.fixture.v1']) {
        // Base/persistence changes trigger intentional view cleanup, tested separately by existing suites.
        if (dependency === 'database.sqlite-fixture.v1') continue;
        features.delete(dependency); await language('zh-CN'); await language('en'); assert.equal(button('Refresh WAL fixture'), undefined);
        features.add(dependency); await language('zh-CN'); await language('en'); assert.ok(button('Refresh WAL fixture'));
      }
      checks.push('REAL J one chooser + same handle, new revisions, exact 3/4/5 IDs; manual refresh clears rows, no query/polling; en/zh-CN and dependency gates');
      const authorize = service.authorize.bind(service); let mutate = true;
      service.authorize = async (...args) => { await authorize(...args); if (mutate) { mutate = false; await writerCall('commit'); } };
      await click('Refresh WAL fixture');
      assert.equal(service.sessions.size, 0); assert.equal(service.pendingFiles.size, 0);
      assert.equal(document.querySelectorAll('.results tbody tr').length, 0); assert.equal(button('Refresh WAL fixture'), undefined);
      assert.match(document.body.textContent, /SQLite source changed during refresh/);
      await language('zh-CN'); assert.match(document.body.textContent, /宿主操作失败/); await snapshot('gate-j-refresh-reject-zh-CN'); await language('en');
      service.authorize = authorize;
      checks.push('REAL J commit during refresh authorization returns no revision/rows; UI disconnects and localizes error');
    } finally {
      const closed = new Promise((resolve) => writer.once('close', resolve)); writer.kill('SIGKILL'); await closed;
      if (writerFile) for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(writerFile + suffix, { force: true });
    }

  } finally { await unmount(); service.shutdown(); }
  // UI epoch test: a late refresh reply after cancel/unmount must close its new revision.
  context.database = { ...initialMockDatabase }; chosen = file; bigResult = false;
  for (const action of ['cancel', 'unmount']) {
    let finishRefresh;
    context.database.refreshSqliteFile = (params) => new Promise((resolve) => { finishRefresh = () => resolve({ ...file, handleId: params.handleId, revision: `late-j-${action}` }); });
    await mount(); await click('New Connection'); await click('Next'); await change('SQLite source', 'file');
    await change('Connection name', `J late ${action}`); await click('Save & Connect'); await click('Run read query');
    assert.ok(document.querySelectorAll('.results tbody tr').length > 0);
    await click('Refresh WAL fixture'); assert.ok(finishRefresh);
    assert.equal(document.querySelectorAll('.results tbody tr').length, 0);
    assert.ok('disabled' in button('Refresh WAL fixture').attributes);
    if (action === 'cancel') await click('Cancel / close'); else await unmount();
    await act(async () => { finishRefresh(); await tick(); });
    assert.equal(apiCalls.findLast((c) => c.operation === 'close').revision, `late-j-${action}`);
    assert.equal(document.querySelectorAll('.results tbody tr').length, 0);
    if (action === 'cancel') { assert.equal(button('Refresh WAL fixture'), undefined); await unmount(); }
  }
  checks.push('J pending refresh clears old rows; cancel and unmount close late new revisions without resurrecting session or results (mock UI epoch test)');
  const report = { kind: 'JSDOM React + SDK remote DOM + host policy; English/zh-CN mocked regressions and real host SQLite commerce lane (injected chooser/approval); not native screenshots', passed: checks.length, failed: 0, checks, policyBatches: batches, maxNodes, maxSerializedTreeBytes: maxBytes, aiProviderCalls: 0 };
  await writeFile(`${evidence}/ui-check.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await unmount(); dom.window.close(); }
