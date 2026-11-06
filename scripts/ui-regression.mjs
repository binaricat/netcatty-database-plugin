// Actual plugin registration + React + SDK remote DOM: mock regression lane,
// then real host service/workers on disposable commerce only. No native dialogs,
// real vault, user databases or model calls.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    saveConnection: async (p) => { apiCalls.push({ operation: 'save', hasSecret: Boolean(p.secret), hostId: p.meta.hostId }); if (failSave) throw new Error('Synthetic keychain unavailable'); const c = { id: `saved-${saved.length + 1}`, ...p.meta, engine: 'sqlite', targetKind: p.revision ? 'file' : 'memory', readOnly: Boolean(p.revision), ...(p.secret ? { secretRef: 'opaque-synthetic-ref' } : {}) }; saved.push(c); return c; },
    openSavedConnection: async ({ id }) => { apiCalls.push({ operation: 'reopen', id }); return saved.find((c) => c.id === id).targetKind === 'file' ? { ...file, handleId: `file-${++opens}`, revision: `revision-${opens}` } : memory(); },
    deleteConnection: async ({ id }) => { saved = saved.filter((c) => c.id !== id); return null; },
    readSchema: async () => ({ tables: Array.from({ length: schemaObjects }, (_, objectIndex) => ({ name: objectIndex === 0 ? 'notes' : `object_${objectIndex}`, kind: objectIndex % 2 ? 'view' : 'table', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }, { name: 'title', type: 'TEXT', primaryKey: false }, { name: 'status', type: 'TEXT', primaryKey: false }, ...Array.from({ length: schemaColumns - 3 }, (_, i) => ({ name: `extra_${i}`, type: 'TEXT', primaryKey: false }))] })) }),
    query: async (p) => { apiCalls.push({ operation: 'query', ...p }); return bigResult ? { columns: Array.from({ length: 32 }, (_, n) => `column${n}`), rows: Array.from({ length: 100 }, () => Array(32).fill('x'.repeat(2048))), changes: 0, elapsedMs: 1, truncated: true } : { columns: ['id', 'title', 'status'], rows: [[1, 'Synthetic launch checklist', 'open'], [3, 'Parameter binding example', 'open']], changes: 0, elapsedMs: 2, truncated: false }; },
    close: async (p) => { apiCalls.push({ operation: 'close', ...p }); return null; }, cancel: async (p) => { apiCalls.push({ operation: 'cancel', ...p }); return null; },
  },
};
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
  await click('AI SQL assistant / mock only'); await click('Create mock draft'); assert.match(document.body.textContent, /SELECT id, title, status FROM notes WHERE status = \?/); checks.push('AI draft is local mock with zero provider calls');
  await click('Close connection'); await unmount(); await mount(); await click('Synthetic saved memory'); await click('Run read query'); assert.ok(apiCalls.some((c) => c.operation === 'reopen')); checks.push('saved list restored on fresh React mount, reopen then query');
  await click('Close connection'); await click('New Connection'); await click('Next'); await change('SQLite source', 'file'); assert.ok('disabled' in button('Save & Connect').attributes); assert.match(document.body.textContent, /No file selected/); checks.push('cancelled native chooser never falls back to memory');
  chosen = file; await click('Choose file...'); await change('Connection name', 'Synthetic saved file'); await click('Save & Connect');
  assert.ok('disabled' in button('Review write...').attributes); await click('Run read query'); assert.equal(apiCalls.findLast((c) => c.operation === 'query').revision, 'revision-one');
  await click('Cancel / close'); assert.equal(apiCalls.findLast((c) => c.operation === 'cancel').revision, 'revision-one'); checks.push('file read-only + query and cancel preserve revision');
  await click('Synthetic saved file'); bigResult = true; await click('Run read query'); assert.equal(document.querySelectorAll('tbody tr').length, 20); assert.equal(document.querySelectorAll('thead th').length, 9); assert.ok(document.querySelector('tbody td:nth-child(2)').textContent.length <= 259); checks.push('large host result stays inside remote DOM node and text budgets');
  await click('+ New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts'); assert.deepEqual(policyErrors, []); checks.push('modal over result grid validates against actual host remote-tree policy'); await click('Close');
  await click('Close connection'); await event(byLabel('Delete Synthetic saved file'), { type: 'click' }); assert.equal(saved.length, 1); checks.push('delete updates saved sidebar');
  await click('New Connection'); await click('Next'); let finish; chosen = new Promise((r) => { finish = r; });
  await change('SQLite source', 'file'); await unmount(); await act(async () => { finish(file); await tick(); }); assert.equal(apiCalls.findLast((c) => c.operation === 'close').revision, 'revision-one'); checks.push('late chooser result after unmount releases session');
  features.delete('database.saved-connections.v1'); features.delete('database.sqlite-file-fixture.v1'); await mount(); await click('New Connection'); await click('Next'); assert.ok(button('Connect without saving')); assert.ok('disabled' in find((n) => n.element === 'option' && n.attributes.value === 'file').attributes); await click('Connect without saving'); await click('Run read query'); checks.push('older host retains memory path; file and persistence gated independently');
  await unmount(); features.add('database.saved-connections.v1'); features.add('database.sqlite-file-fixture.v1');
  saved = Array.from({ length: 100 }, (_, i) => ({ id: `stress-${i}`, name: `Stress ${i}`, color: 'default', engine: 'sqlite', targetKind: 'memory', readOnly: false }));
  hostCount = 500; schemaColumns = 32; schemaObjects = 32; await mount(); await event(byLabel('Next connections'), { type: 'click' }); assert.ok(button('Stress 20')); await event(byLabel('Previous connections'), { type: 'click' }); await click('Stress 0'); await event(byLabel('Open table notes'), { type: 'click' }); assert.equal(document.querySelectorAll('.structure tbody tr').length, 32); await event(byLabel('Close notes'), { type: 'click' });
  for (let i = 0; i < 7; i++) await click('+ New Query');
  await click('Run read query'); await click('+ New Connection'); await click('Next'); await click('Advanced'); await click('Load permitted hosts');
  assert.deepEqual(policyErrors, []); assert.ok(maxNodes <= 1024); checks.push('100 connections, 500 hosts, 32 schema objects/columns, 8 tabs and oversized mock result remain within host tree limits');
  await unmount();
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
  await click('AI SQL 助手 / 仅模拟'); await click('生成模拟草稿'); assert.ok(byLabel('未执行的 AI 草稿'));
  checks.push('zh-CN schema/search/structure/data/query/status/mock UI; live locale preserves tabs, SQL, parameters, results and session without new host calls');
  await click('关闭连接'); await click('新建连接'); await click('下一步'); await change('SQLite 数据源', 'file');
  assert.match(document.body.textContent, /尚未选择文件/); chosen = file; await click('选择文件…');
  assert.match(document.body.textContent, /一次性 SQLite 文件（只读）/); failSave = true;
  await click('保存并连接'); assert.match(document.body.textContent, /宿主操作失败。宿主诊断：Synthetic keychain unavailable/);
  await language('en'); assert.match(document.body.textContent, /Synthetic keychain unavailable/);
  await language('zh-CN'); failSave = false; await click('保存并连接');
  assert.ok('disabled' in button('审查写入…').attributes); await click('取消 / 关闭');
  checks.push('zh-CN file chooser cancellation, readonly write control and translated host-error wrapper retain original diagnostics');
  await unmount(); saved = Array.from({ length: 21 }, (_, i) => ({ id: `zh-${i}`, name: `User ${i}`, color: 'default', engine: 'sqlite', targetKind: 'memory', readOnly: false }));
  await mount(); await event(byLabel('下一页连接'), { type: 'click' }); assert.ok(button('User 20')); await event(byLabel('上一页连接'), { type: 'click' }); assert.ok(button('User 0'));
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


  // The new multi-table lane uses the real host registry/service/subprocess.
  // Only native chooser and permission decisions are injected for this fixture.
  const { PluginSqliteFixtureService } = host('./electron/plugins/sqliteFixtureService.cjs');
  const { PluginHostRpcRegistry } = host('./electron/plugins/hostRpcRegistry.cjs');
  const { DatabaseConnectionStore } = host('./electron/plugins/databaseConnectionStore.cjs');
  const identity = { pluginId: 'com.binaricat.netcatty-database', pluginVersion: '0.1.0', runtimeId: 'm3b-ui', runtimeKind: 'browser', sourceOwner: 'owner-fixture', sourceId: 'fixture', securityPrincipal: 'synthetic', manifest: { features: { optional: [...features] } } };
  const fs = host('node:fs');
  const storeFile = `${evidence}/tmp/ui-connections.json`;
  fs.rmSync(storeFile, { force: true });
  const service = new PluginSqliteFixtureService({ enabled: true,
    connectionStore: new DatabaseConnectionStore(storeFile),
    database: { getActivePlugin: () => ({ enabled: true, source: { id: 'fixture' } }), getRetainedPluginSource: () => ({ id: 'fixture' }), privateOwner: () => 'owner-fixture', publicPluginId: () => identity.pluginId },
    runtimeSupervisor: { getRuntimeIdentity: () => identity },
    permissionEngine: { onDidRevoke: () => ({ dispose() {} }), authorize: async (_c, d) => d.validateBeforeGrant() },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/workspace/agent-tools/database/m3b-multitable/fixtures/commerce.sqlite'] }), showMessageBox: async () => { throw new Error('File writes must never prompt'); } },
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
  } finally { await unmount(); service.shutdown(); }
  const report = { kind: 'JSDOM React + SDK remote DOM + host policy; English/zh-CN mocked regressions and real host SQLite commerce lane (injected chooser/approval); not native screenshots', passed: checks.length, failed: 0, checks, policyBatches: batches, maxNodes, maxSerializedTreeBytes: maxBytes, aiProviderCalls: 0 };
  await writeFile(`${evidence}/ui-check.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await unmount(); dom.window.close(); }
