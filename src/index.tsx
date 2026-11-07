import { createConnectionModalChannel } from './connectionModalChannel';
import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { definePlugin, type PluginContext, type DatabaseConnectionMeta } from '@netcatty/plugin-sdk';
import { registerHostReactView, type HostViewController } from '@netcatty/plugin-sdk/host-react';
import { useWorkbench } from './useWorkbench';
import { selectObject } from './domain';
import { SqlAssistant } from './SqlAssistant';
import css from './style.css';
import { Icon } from './Icon';
import { previewSummary } from './preview';
import { SqlEditor } from './SqlEditor';
import { clampEditorSplit, DEFAULT_EDITOR_SPLIT, MIN_EDITOR_SPLIT, MAX_EDITOR_SPLIT } from './sqlDisplay';
type Model = ReturnType<typeof useWorkbench>;
const CONNECTION_PAGE_SIZE = 10;
const MODAL_VIEW = 'com.binaricat.netcatty-database.new-connection';
type ModalChannel = ReturnType<typeof createConnectionModalChannel<Model>>;
function EngineIcon({ engine, theme }: { engine: 'sqlite' | 'postgresql' | 'mysql'; theme: string }) {
  return <img className="engine-icon" src={`brand:assets/icons/${engine}-${theme === 'dark' ? 'dark' : 'light'}.png`} alt="" width={32} height={32} />;
}
function ConnectionModal({ channel, controller }: { channel: ModalChannel; controller: HostViewController }) {
  const vm = useSyncExternalStore(channel.subscribe, channel.getSnapshot);
  useEffect(() => { if (!vm?.modal) controller.close(); }, [vm?.modal, controller]);
  useEffect(() => () => { const current = channel.getSnapshot(); if (current?.modal) void current.dismiss(); }, [channel]);
  return vm?.modal ? <main className="database-workbench connection-surface"><ConnectionDialog vm={vm} /></main> : null;
}
const colors: DatabaseConnectionMeta['color'][] = ['default', 'blue', 'green', 'purple', 'orange'];
function ConnectionDialog({ vm }: { vm: Model }) {
  const { t } = vm;
  const [category, setCategory] = useState<'all' | 'lightweight' | 'relational'>('all');
  const [page, setPage] = useState<'connection' | 'advanced'>('connection');
  const [nameDraft, setName] = useState<string | null>(null);
  const name = nameDraft ?? t("Synthetic SQLite"); const [color, setColor] = useState<DatabaseConnectionMeta['color']>('default');
  const [source, setSource] = useState<'memory' | 'file'>('memory');
  const [hostId, setHostId] = useState(''); const [hostFilter, setHostFilter] = useState(''); const [savePassword, setSavePassword] = useState(false); const [password, setPassword] = useState('');
  const ready = source === 'memory' || Boolean(vm.draftSession && 'readOnly' in vm.draftSession);
  return <section className="connection-dialog">
    <div className="flow-heading"><span className="step-number">{vm.modal === 'picker' ? '1' : '2'}</span><div><h2>{t(vm.modal === 'picker' ? "Choose a database" : "Connection details")}</h2><p>{t(vm.modal === 'picker' ? "Select an engine to create your connection." : "Configure your local SQLite connection.")}</p></div><span className="step-count">{t(vm.modal === 'picker' ? "Step 1 of 2" : "Step 2 of 2")}</span></div>
    {vm.modal === 'picker' ? <><div className="type-picker"><nav aria-label={t("Database categories")}><strong>{t("Database Types")}</strong>{([['all', 'All databases', '3'], ['lightweight', 'Lightweight', '1'], ['relational', 'Relational', '2']] as const).map(([id, label, count]) => <button key={id} aria-pressed={category === id} className={category === id ? 'selected-category' : ''} onClick={() => setCategory(id)}>{t(label)}<span>{count}</span></button>)}</nav><div className="type-list"><div className="engine-list-heading"><h3>{t(category === 'all' ? "All databases" : category === 'lightweight' ? "Lightweight" : "Relational")}</h3><span>{t(category === 'relational' ? "No drivers available" : "1 available")}</span></div><div className="engine-grid">{category !== 'relational' && <button className="type-option selected" aria-pressed="true" onClick={() => vm.setModal('connection')}><span className="engine-mark"><EngineIcon engine="sqlite" theme={vm.theme} /></span><strong>SQLite</strong><small>{t("Local file or in-memory")}</small><span className="engine-status"><Icon name="check" />{t("Available")}</span></button>}{category !== 'lightweight' && (['postgresql', 'mysql'] as const).map((engine) => <button key={engine} className="type-option" disabled><span className="engine-mark"><EngineIcon engine={engine} theme={vm.theme} /></span><strong>{engine === 'postgresql' ? 'PostgreSQL' : 'MySQL'}</strong><small>{t("Relational database")}</small><span className="engine-status">{t("Driver not implemented")}</span></button>)}</div><p className="engine-disclosure"><Icon name="shield" />{t("SQLite fixtures only in this experimental release.")}</p></div></div><footer className="modal-footer"><span className="selected-engine"><EngineIcon engine="sqlite" theme={vm.theme} />{t("Selected: SQLite")}</span><button className="secondary" onClick={() => void vm.dismiss()}>{t("Cancel")}</button><button onClick={() => vm.setModal('connection')}>{t("Next")}<Icon name="arrow-right" /></button></footer></> : <>
      <nav className="modal-tabs" aria-label={t("Connection settings")}><button className={page === 'connection' ? 'active' : ''} onClick={() => setPage('connection')}>{t("Connection")}</button><button className={page === 'advanced' ? 'active' : ''} onClick={() => setPage('advanced')}>{t("Advanced")}</button></nav>
      <div className="modal-content">{page === 'connection' ? <>
        <label>{t("Name")}<input aria-label={t("Connection name")} value={name} maxLength={128} disabled={vm.busy} onChange={(e) => setName(e.currentTarget.value)} /></label>
        <div className="engine-field"><span className="field-label">{t("Type")}</span><button className="connection-engine secondary" disabled={vm.busy} onClick={() => vm.setModal('picker')} title={t("Choose a database")}><EngineIcon engine="sqlite" theme={vm.theme} /><strong>SQLite</strong><span>{t("Change")}</span></button></div><div className="color-field"><span className="field-label">{t("Color")}</span><div className="swatches">{colors.map((c) => <button key={c} aria-label={t("Color {color}", { color: t(c) })} aria-pressed={color === c} className={`swatch color-${c} ${color === c ? 'chosen' : ''}`} onClick={() => setColor(c)} />)}</div></div>
        <label>{t("File Path")}<select aria-label={t("SQLite source")} value={source} disabled={vm.busy} onChange={(e) => { const file = e.currentTarget.value === 'file'; setSource(file ? 'file' : 'memory'); void vm.selectSource(file); }}><option value="memory">{t(":memory: - disposable synthetic notes")}</option><option value="file" disabled={!vm.fileEnabled}>{t("Host-selected SQLite file (read-only)")}</option></select></label>
        {source === 'file' && <div className="file-choice"><span>{ready ? t("Disposable SQLite file (read-only)") : t("No file selected")}</span><button className="secondary" disabled={!vm.fileEnabled || vm.busy} onClick={() => void vm.selectSource(true)}>{t("Choose file...")}</button></div>}
        <p className="hint">{t("Choose an allowlisted disposable fixture. File paths stay with the host; memory data resets on open.")}</p>
        <details className="fixture-details"><summary><Icon name="shield" />{t("Fixture scope & limits")}</summary>{source === 'file' && vm.walEnabled && <p className="hint">{t(vm.walRefreshEnabled ? "Explicit WAL refresh: pause all writers through refresh and reads. Click Refresh WAL fixture for appended commits in this open session. Checkpoints or replaced files require choosing again. No polling, automatic retry or uninterrupted capture." : vm.walCaptureEnabled ? "Fixture capture: pause all writers through file selection and reads. Choose again for new rows. Resuming writes invalidates the session; displayed rows are historical. No live refresh or automatic retry." : vm.walCheckpointEnabled ? "Fixture checkpoints: after PASSIVE/FULL/RESTART, pause writing and choose again to read a verified committed WAL. Old snapshots invalidate. Empty, interrupted or stale WAL tails reject. No live refresh or crash recovery." : vm.walConcurrentEnabled ? "Fixture WAL writer checks: source changes invalidate the snapshot. Pause writing and choose the file again for new rows. No live refresh, checkpoint or recovery support." : "Stable fixture WAL: verified read-only snapshot. Changes require reopening; no concurrent writers, checkpoint or recovery.")}</p>}
        {source === 'file' && vm.malformedRejectEnabled && <p className="hint">{t("Linux fixture checks reject the fixed malformed test corpus before opening. Broader corruption handling and recovery are unqualified.")}</p>}
        <label className="check"><input type="checkbox" checked={savePassword} disabled={!vm.persistence || vm.busy} onChange={(e) => { setSavePassword(e.currentTarget.checked); setPassword(''); }} />{t("Save password")}</label>
        {savePassword && <label>{t("Synthetic credential (storage test only)")}<input type="password" aria-label={t("Synthetic password")} autoComplete="off" value={password} maxLength={4096} disabled={vm.busy} onChange={(e) => setPassword(e.currentTarget.value)} /></label>}
        <p className="hint">{t("SQLite needs no password. Optional synthetic credentials use host OS encryption and return only an opaque secretRef; no SQLCipher or remote authentication.")}</p>
      </details></> : <div className="advanced"><h3>{t("Existing host context")}</h3>
        <label>{t("Filter hosts")}<input aria-label={t("Filter hosts")} value={hostFilter} maxLength={128} onChange={(e) => setHostFilter(e.currentTarget.value)} /></label><label>{t("Existing host (optional SSH context)")}<select aria-label={t("Existing host")} disabled={vm.busy} value={hostId} onChange={(e) => { vm.tunnel.reset(); vm.portProbe.reset(); vm.liveSshPg.reset(); setHostId(e.currentTarget.value); }}><option value="">{t("None - local SQLite")}</option>{vm.hosts.filter((h) => `${h.label} ${h.hostname}`.toLowerCase().includes(hostFilter.toLowerCase()) || h.hostId === hostId).slice(0, 20).map((h) => <option key={h.hostId} value={h.hostId}>{`${h.label.slice(0, 100)} / ${h.username.slice(0, 40)}@${h.hostname.slice(0, 100)}:${h.port}`}</option>)}</select></label>
        <button className="secondary" disabled={!vm.persistence || vm.busy} onClick={() => void vm.loadHosts()}>{t("Load permitted hosts")}</button><p className="hint">{t("Up to 20 matches shown; filter to narrow the list. Metadata only. Choosing an SSH host does not open a tunnel or make it the database.")}</p>
        <div className="port-probe">
          <button className="secondary" disabled={vm.busy || vm.portProbe.busy || !vm.portProbe.enabled || !vm.hosts.find((h) => h.hostId === hostId)?.portProbe} onClick={() => void vm.portProbe.probe(vm.hosts.find((h) => h.hostId === hostId))}>{t("Probe common database ports")}</button>
          {vm.portProbe.busy && <button className="secondary" onClick={vm.portProbe.cancel}>{t("Cancel port probe")}</button>}
          <p className="hint">{t("5432 PostgreSQL / 3306 MySQL or MariaDB / 1433 Microsoft SQL Server / 27017 MongoDB / 6379 Redis")}</p>
          <p className="hint">{t("Direct TCP probe from Netcatty to the saved hostname. An open port is not an authenticated database session or an SSH tunnel.")}</p>
          <p role="status">{vm.portProbe.message ? t(vm.portProbe.message) : t("No port probe has run.")}</p>
          {vm.portProbe.result && <div><p>{t("Probed host: {hostname}", { hostname: vm.portProbe.result.hostname ?? '' })}</p><ul aria-label={t("Database port results")}>{vm.portProbe.result.ports.map((port) => <li key={port.port}>{`${port.port} ${port.serviceLabel}: ${t(port.status)}${port.latencyMs !== undefined ? ` / ${port.latencyMs} ms` : ''}`}</li>)}</ul></div>}
        </div>
        <div className="live-fixture-test">
          <button className="secondary" disabled={vm.busy || vm.portProbe.busy || vm.tunnel.busy || vm.liveSshPg.busy || !vm.liveSshPg.enabled || !vm.hosts.find((h) => h.hostId === hostId)?.liveSshPg} onClick={() => void vm.liveSshPg.test(vm.hosts.find((h) => h.hostId === hostId))}>{t("Test live SSH→PostgreSQL (fixture)")}</button>
          {vm.liveSshPg.busy && <button className="secondary" onClick={vm.liveSshPg.cancel}>{t("Cancel live fixture test")}</button>}
          <p className="hint">{t("Allowlisted loopback fixture only. Pinned SSH and SELECT 1 are required; credentials stay with the host. The test session closes automatically.")}</p>
          <p role="status">{vm.liveSshPg.message ? t(vm.liveSshPg.message) : t("No live fixture test has run. Selecting a host does not connect.")}</p>
        </div>
        <div className="tunnel-test"><button className="secondary" disabled={vm.busy || vm.portProbe.busy || vm.liveSshPg.busy || vm.tunnel.busy || !vm.tunnel.enabled || !vm.hosts.find((h) => h.hostId === hostId)?.tunnelTest} onClick={() => void vm.tunnel.test(vm.hosts.find((h) => h.hostId === hostId))}>{t("Test tunnel (synthetic)")}</button>{vm.tunnel.busy && <button className="secondary" onClick={vm.tunnel.cancel}>{t("Cancel tunnel test")}</button>}
        <p className="hint">{t("Synthetic adapter only. This test opens no SSH or PostgreSQL connection; selecting a host never connects.")}</p>
        <p role="status">{vm.tunnel.message ? t(vm.tunnel.message) : t("No tunnel test has run.")}</p></div>
        <h3>{t("Connection limits")}</h3><p>{t("100 rows / 96 KiB / 3 seconds / 8 KiB SQL")}</p><h3>{t("Transport and encryption")}</h3><p>{t("Production SSH tunnels, TLS, SQLite encryption and extensions are unavailable. The separate loopback live test is fixture-only.")}</p><h3>{t("Advanced settings")}</h3><p>{t("No additional settings are implemented.")}</p></div>}
      </div><div className="connection-feedback"><p role="status" className={vm.tested ? "test-status success" : "test-status"}><Icon name={vm.tested ? "check" : "shield"} />{vm.tested ? t("Connection successful - host schema validated") : t("Test the selected fixture before connecting.")}</p>
      {vm.error && <p className="error" role="alert"><Icon name="alert-circle" />{vm.error}</p>}</div>
      <footer className="modal-footer"><button className="secondary back-button" disabled={vm.busy} onClick={() => { setPage('connection'); vm.setModal('picker'); }}>{t("Back")}</button><button className="secondary" disabled={!ready || vm.busy || vm.portProbe.busy || vm.liveSshPg.busy || vm.tunnel.busy} onClick={() => void vm.test()}>{t("Test")}</button><button disabled={!ready || vm.busy || vm.portProbe.busy || vm.liveSshPg.busy || vm.tunnel.busy || !name.trim() || (savePassword && !password)} onClick={() => { const secret = savePassword ? password : undefined; setPassword(''); if (vm.persistence) void vm.save({ name: name.trim(), color, ...(hostId ? { hostId } : {}) }, secret); else void vm.openUnsaved(); }}>{vm.persistence ? t("Save & Connect") : t("Connect without saving")}</button><button className="secondary" disabled={vm.busy} onClick={() => void vm.dismiss()}>{t("Close")}</button></footer>
    </>}
  </section>;
}
function SchemaTree({ vm }: { vm: Model }) {
  const { t } = vm;
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const toggle = (key: string) => setCollapsed((items) => items.includes(key) ? items.filter((x) => x !== key) : [...items, key]);
  const expanded = (key: string) => !collapsed.includes(key);
  const objects = vm.schema?.tables ?? [];
  return <div className="schema-tree">
    <div className="tree-connection-row"><button className="tree-toggle tree-connection" aria-label={t("Toggle connection schema")} aria-expanded={expanded('connection')} onClick={() => toggle('connection')}><Icon name={expanded('connection') ? 'chevron-down' : 'chevron-right'} /><span className="color-dot" aria-hidden="true" /><span className="tree-label" title={vm.connectionName}>{vm.connectionName}</span></button>{vm.saved.some((c) => c.id === vm.connectedId) && <button className="delete-connection" aria-label={t("Delete {name}", { name: vm.connectionName })} disabled={vm.busy} onClick={() => void vm.remove(vm.connectedId)}><Icon name="x" /></button>}</div>
    {expanded('connection') && <div className="database-node">
      <button className="tree-toggle" aria-label={t("Toggle main schema")} aria-expanded={expanded('main')} onClick={() => toggle('main')}><Icon name={expanded('main') ? 'chevron-down' : 'chevron-right'} /><Icon name="database" />main</button>
      {expanded('main') && <>
        <label className="schema-filter"><input placeholder={t("Search objects...")} aria-label={t("Search schema objects")} value={filter} maxLength={64} onChange={(e) => setFilter(e.currentTarget.value)} /></label>
        {(['table', 'view'] as const).map((kind) => {
          const list = objects.filter((object) => (object.kind ?? 'table') === kind);
          const matches = list.filter((object) => object.name.toLowerCase().includes(filter.toLowerCase()));
          const label = kind === 'table' ? t("Tables") : t("Views");
          return <div key={kind}>
            <button className="tree-toggle tree-group" aria-label={t("Toggle {label}", { label })} aria-expanded={expanded(kind)} onClick={() => toggle(kind)}><Icon name={expanded(kind) ? 'chevron-down' : 'chevron-right'} />{`${label} (${list.length})`}</button>
            {expanded(kind) && <>{matches.map((object) => <div key={object.name} className="table-node"><button aria-label={t(kind === "table" ? "Open table {name}" : "Open view {name}", { name: object.name })} aria-pressed={vm.tab?.objectName === object.name} disabled={vm.busy || vm.tabs.length >= 8 && !vm.tabs.some((tab) => tab.objectName === object.name)} onClick={() => vm.addTab(object.name)}><Icon name={kind === 'table' ? 'table' : 'eye'} /><span className="tree-label" title={object.name}>{object.name}</span></button></div>)}{!matches.length && <small>{list.length ? t("No matching objects") : t(kind === "table" ? "No tables" : "No views")}</small>}</>}
          </div>;
        })}
      </>}
    </div>}
  </div>;
}
function Structure({ vm }: { vm: Model }) {
  const { t } = vm;
  const object = vm.schema?.tables.find((item) => item.name === vm.tab?.objectName);
  if (!object) return <p className="empty-results">{t("Structure unavailable")}</p>;
  return <section className="structure" aria-label={t("Structure of {name}", { name: object.name })}>
    <div className="results-heading"><strong>{`${vm.connectionName} / main / ${object.name}`}</strong><span>{t("SQLite / Read-only structure")}</span></div>
    <div className="results-heading"><strong>{t("Columns")}</strong><span>{t("{count} columns / {kind}", { count: object.columns.length, kind: t(object.kind ?? "table") })}</span></div>
    <div className="table-scroll"><table><thead><tr><th>#</th><th>{t("Column")}</th><th>{t("Type")}</th><th>{t("Nullable")}</th><th>{t("Primary Key")}</th></tr></thead><tbody>{object.columns.map((c, i) => <tr key={c.name} tabIndex={0}><td className="row-index">{i + 1}</td><td>{c.name}</td><td className="column-type"><span className="type-label">{c.type}</span></td><td>{c.nullable === undefined ? t("Unknown") : c.nullable ? t("Yes") : t("No")}</td><td>{c.primaryKey ? t("Yes") : t("No")}</td></tr>)}</tbody></table></div>
    <div className="result-status">{object.kind === 'view' ? t("View nullability is not inferred.") : t("Column metadata from the connected SQLite schema.")} {t("Schema editing is unavailable.")}</div>
  </section>;
}
function Workbench({ context, controller, channel }: { context: PluginContext; controller: HostViewController; channel: ModalChannel }) {
  const vm = useWorkbench(context);
  const owner = useRef(Symbol('workbench'));
  const requested = useRef(false);
  useEffect(() => {
    if (!channel.publish(owner.current, vm, vm.modal !== null)) return;
    if (vm.modal && !requested.current) { requested.current = true; controller.openModal(MODAL_VIEW); }
    if (!vm.modal) { requested.current = false; channel.release(owner.current); }
  });
  useEffect(() => { const key = owner.current; return () => channel.release(key); }, [channel]); const { t } = vm; const [connectionFilter, setConnectionFilter] = useState(''); const [connectionPage, setConnectionPage] = useState(0);
  const matches = vm.saved.filter((c) => c.name.toLowerCase().includes(connectionFilter.toLowerCase()));
  const page = Math.min(connectionPage, Math.max(0, Math.ceil(matches.length / CONNECTION_PAGE_SIZE) - 1)); const [showAI, setShowAI] = useState(false);
  const [editorSplit, setEditorSplit] = useState(DEFAULT_EDITOR_SPLIT);
  const result = vm.tab?.result;
  const preview = result ? previewSummary(result) : null;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Only the exact generated SELECT has known provenance; edited SQL is not parsed.
  const resultObject = vm.schema?.tables.find((object) => vm.tab?.resultSql === selectObject(object.name));
  return <main className="database-workbench">
    <header className="app-toolbar">
      <button className="icon-button toolbar-button" aria-label={t("Toggle connections")} aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="panel-left" /></button>
      <button className="toolbar-button" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}><Icon name="plus" />{t("New Connection")}</button>
      <button className="toolbar-button" disabled={!vm.session || vm.busy || vm.tabs.length >= 8} onClick={() => vm.addTab()}><Icon name="file-code" />{t("New Query")}</button>
      {vm.walRefreshEnabled && vm.session && 'revision' in vm.session && <button className="toolbar-button" disabled={vm.busy} onClick={() => void vm.refresh()}><Icon name="refresh" />{t("Refresh WAL fixture")}</button>}
      <span className="experimental">{t("EXPERIMENTAL")}</span>
      <button className={showAI && vm.session ? "toolbar-button ai-toggle active" : "toolbar-button ai-toggle"} disabled={!vm.session} aria-expanded={showAI && Boolean(vm.session)} onClick={() => setShowAI(!showAI)}><Icon name="sparkles" />{t("AI SQL assistant")}</button>
    </header>
    <div className={sidebarOpen ? "shell" : "shell sidebar-hidden"}><aside className="connection-sidebar"><div className="sidebar-heading"><strong>{t("Connections")}</strong><span>{vm.saved.length}</span></div><p className="sidebar-status">{t("Active connections: {count}", { count: vm.session ? 1 : 0 })}</p>
      <label className="connection-filter"><input placeholder={t("Filter connections...")} aria-label={t("Filter connections")} value={connectionFilter} maxLength={128} onChange={(e) => { setConnectionFilter(e.currentTarget.value); setConnectionPage(0); }} /></label><div className="connection-list">{vm.saved.length ? matches.slice(page * CONNECTION_PAGE_SIZE, (page + 1) * CONNECTION_PAGE_SIZE).map((c) => vm.session && vm.connectedId === c.id ? <SchemaTree key={vm.session.handleId} vm={vm} /> : <div key={c.id} className={`saved-connection ${vm.connectedId === c.id ? 'selected' : ''}`}><button className="connection-name" disabled={vm.busy || vm.connectedId === c.id} onClick={() => void vm.open(c)}><span className={`color-dot color-${c.color}`} /><span title={c.name}>{c.name}</span></button><button className="delete-connection" aria-label={t("Delete {name}", { name: c.name })} disabled={vm.busy} onClick={() => void vm.remove(c.id)}><Icon name="x" /></button></div>) : <p className="empty-sidebar">{t("No connections yet")}</p>}</div>
      {vm.session && !matches.slice(page * CONNECTION_PAGE_SIZE, (page + 1) * CONNECTION_PAGE_SIZE).some((c) => c.id === vm.connectedId) && <SchemaTree key={vm.session.handleId} vm={vm} />}
      <div className="sidebar-footer">{matches.length > CONNECTION_PAGE_SIZE && <div className="connection-pages"><button className="secondary" aria-label={t("Previous connections")} disabled={page === 0} onClick={() => setConnectionPage(page - 1)}>{t("Previous")}</button><span>{page + 1} / {Math.ceil(matches.length / CONNECTION_PAGE_SIZE)}</span><button className="secondary" aria-label={t("Next connections")} disabled={(page + 1) * CONNECTION_PAGE_SIZE >= matches.length} onClick={() => setConnectionPage(page + 1)}>{t("Next")}</button></div>}{t("SQLite fixtures only")}{vm.session && <><span>{'readOnly' in vm.session ? t("Read-only file") : t("Disposable memory")}</span><button className="secondary" disabled={vm.busy} onClick={() => void vm.disconnect()}><Icon name="unplug" />{t("Close connection")}</button></>}</div>
    </aside><section className={showAI && vm.session ? "workspace ai-open" : "workspace"}>
      {!vm.session ? <div className="home"><div className="home-intro"><Icon name="database" /><h1>{t("Your data, inside Netcatty")}</h1><p>{t("Explore a local SQLite fixture with the host’s permissions and familiar tools.")}</p></div><div className="home-metrics"><div><span>{t("Connections")}</span><strong>{vm.saved.length}</strong></div><div><span>{t("Connected")}</span><strong>0</strong></div><div><span>{t("Database Types")}</span><strong>{vm.saved.length ? 1 : 0}</strong></div></div><div className="home-panels"><section className="home-panel"><h2>{t("Quick Start")}</h2><div className="home-welcome"><p>{vm.saved.length ? t("Your connections, ready to reopen") : t("No connections yet")}</p><p>{vm.saved.length ? t("Select a saved connection on the left. The host validates its target again.") : t("Create a connection to explore disposable SQLite data.")}</p><button className="secondary" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}>{t("New Connection")}</button></div></section><section className="home-panel"><h2>{t("Shortcuts")}</h2><div className="shortcut-row"><button className="shortcut" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}><Icon name="plus" />{t("New Connection")}<small>{t("SQLite / local fixtures")}</small></button><button className="shortcut" disabled>{t("History")}<small>{t("Not available in this milestone")}</small></button></div></section></div><p className="hint home-note">{!vm.enabled ? t("The host SQLite experiment is disabled or unavailable.") : !vm.persistence ? t("This host does not support saved connections. Temporary connections remain available.") : t("Saved connections contain metadata only. Memory contents are never persisted.")}</p></div> : <>
        {vm.walRefreshEnabled && 'revision' in vm.session && <details className="session-notice"><summary><Icon name="shield" />{t("Read-only fixture · pause writers during reads")}</summary><p>{t("Explicit WAL refresh: pause all writers through refresh and reads. Click Refresh WAL fixture for appended commits in this open session. Checkpoints or replaced files require choosing again. No polling, automatic retry or uninterrupted capture.")}</p></details>}
        <nav className="tab-strip" aria-label={t("Workspace tabs")}>{vm.tabs.map((tab) => <div key={tab.id} className={vm.activeTab === tab.id ? 'workspace-tab active' : 'workspace-tab'}><button aria-pressed={vm.activeTab === tab.id} onClick={() => vm.setActiveTab(tab.id)}><Icon name={tab.objectName ? "table" : "file-code"} /><span title={vm.tabTitle(tab)}>{vm.tabTitle(tab)}</span></button><button aria-label={t("Close {name}", { name: vm.tabTitle(tab) })} disabled={vm.busy} onClick={() => vm.closeTab(tab.id)}><Icon name="x" /></button></div>)}</nav>
        {vm.tab?.objectName && <nav className="object-tabs" aria-label={t("Object surface")}><button className={vm.tab.surface === 'structure' ? 'active' : ''} aria-pressed={vm.tab.surface === 'structure'} onClick={() => vm.edit({ surface: 'structure' })}>{t("Structure")}</button><button className={vm.tab.surface === 'data' ? 'active' : ''} aria-pressed={vm.tab.surface === 'data'} onClick={() => vm.edit({ surface: 'data' })}>{t("Data")}</button></nav>}
        {vm.tab?.surface === 'structure' ? <Structure vm={vm} /> : vm.tab ? <div className={vm.tab.objectName ? "query-split object-split" : "query-split"} style={{'--plugin-editor-split': `${editorSplit}%`} as React.CSSProperties}><section className={vm.tab.objectName ? "editor object-editor" : "editor"}><div className="query-toolbar"><button disabled={vm.busy} onClick={() => void vm.run('read')}><Icon name={vm.busy ? "loader" : "play"} />{t("Run read query")}</button><button className="secondary" disabled={vm.busy || 'readOnly' in vm.session} onClick={() => void vm.run('write')}>{t("Review write...")}</button><button className="secondary" onClick={() => void vm.disconnect(true)}><Icon name="square" />{t("Cancel / close")}</button><span className="query-context" title={vm.connectionName}>{vm.connectionName} / main{vm.tab.objectName ? ` / ${vm.tab.objectName}` : ""}</span></div><SqlEditor sql={vm.tab.sql} disabled={vm.busy} onChange={(sql) => vm.edit({ sql })} t={t} /><label className="parameters">{t("Parameters")}<input aria-label={t("SQL parameters")} value={vm.tab.parameters} maxLength={8192} disabled={vm.busy} onChange={(e) => vm.edit({ parameters: e.currentTarget.value })} /></label></section>
        {!vm.tab.objectName && <input className="query-splitter" type="range" aria-label={t("SQL editor height")} title={t("Adjust editor height with arrow keys or click the track")} aria-valuetext={t("Editor {percent}%", { percent: editorSplit })} min={MIN_EDITOR_SPLIT} max={MAX_EDITOR_SPLIT} step={1} value={editorSplit} onChange={(e) => setEditorSplit(clampEditorSplit(Number(e.currentTarget.value)))} />}
        <section className="results" aria-busy={vm.busy}><div className="results-heading"><strong>{vm.tab.objectName ? t("Table Data") : t("Results")}</strong><span>{preview ? t("Showing {rows} of {total} rows · {columns} of {allColumns} columns", { rows: preview.shownRows, total: preview.totalRows, columns: preview.shownColumns, allColumns: preview.totalColumns }) : t("Preview: 20 rows / 8 columns / 256 chars per cell")}</span></div>{result?.columns.length ? <div className="table-scroll"><table><thead><tr><th>#</th>{result.columns.slice(0, 8).map((col, i) => {
          const type = resultObject?.columns.find((column) => column.name === col)?.type;
          return <th key={i}>{col}<small className="result-type" title={type ? t("Type") : t("Result type unavailable")}>{type || '—'}</small></th>;
        })}</tr></thead><tbody>{!result.rows.length && <tr><td className="empty-table" colSpan={Math.min(result.columns.length, 8) + 1}>{t("No rows returned. Try a different filter.")}</td></tr>}{result.rows.slice(0, 20).map((row, i) => <tr key={i} tabIndex={0}><td className="row-index">{i + 1}</td>{row.slice(0, 8).map((cell, j) => <td key={j} className={cell === null || cell === '' ? "null-cell" : typeof cell === "number" ? "number-cell" : undefined}>{cell === null ? 'NULL' : cell === '' ? t('Empty string') : String(cell).length > 256 ? String(cell).slice(0, 256) + '...' : String(cell)}</td>)}</tr>)}</tbody></table></div> : <div className="empty-results"><Icon name={vm.busy ? "loader" : "table"} /><p>{vm.busy ? t("Waiting for host...") : result ? t("Statement completed. No result rows.") : t("Run a query to view results.")}</p></div>}<div className="preview-disclosure">{t("Preview: 20 rows / 8 columns / 256 chars per cell")}{preview && preview.clippedCells > 0 && <strong>{t("{count} visible cells shortened", { count: preview.clippedCells })}</strong>}{preview?.hostTruncated && <strong>{t("Host result truncated")}</strong>}</div><div className="result-status" role="status">{vm.busy ? t("Waiting for host...") : result ? t("{rows} rows / {columns} columns / {ms} ms / {changes} changes", { rows: result.rows.length, columns: result.columns.length, ms: result.elapsedMs, changes: result.changes }) + (result.truncated ? t(" / truncated") : "") : t("Nothing executed")}{result && <span className="result-sql" title={vm.tab.resultSql}>{vm.tab.resultSql}</span>}</div></section></div> : <div className="empty-results">{t("Open a table or create a new query.")}</div>}
        {showAI && <aside className="ai-secondary" aria-label={t("AI SQL assistant")}><header className="ai-heading"><Icon name="sparkles" /><strong>{t("AI SQL assistant")}</strong><button className="icon-button toolbar-button" aria-label={t("Close AI assistant")} onClick={() => setShowAI(false)}><Icon name="x" /></button></header><SqlAssistant key={`${vm.session.handleId}:${'revision' in vm.session ? vm.session.revision : 'memory'}:${vm.activeTab}`} context={context} schema={vm.schema} sql={vm.tab?.sql ?? ''} label={vm.connectionName} disabled={vm.busy || !vm.tab} insert={(sql) => vm.edit({ sql, parameters: '[]', result: null, resultSql: undefined })} t={t} /></aside>}
      </>}
      {vm.error && !vm.modal && <p className="error" role="alert"><Icon name="alert-circle" />{vm.error}</p>}
    </section></div><footer className="app-status">{vm.session ? vm.connectionName : t("No database connected")}<span>{t("Netcatty host permissions / SQLite fixture service")}</span></footer>

  </main>;
}
export default definePlugin({ activate(context) {
  const channel = createConnectionModalChannel<Model>();
  context.subscriptions.add(registerHostReactView(context.views, 'com.binaricat.netcatty-database.workbench', (controller) => <Workbench context={context} controller={controller} channel={channel} />, css));
  context.subscriptions.add(registerHostReactView(context.views, MODAL_VIEW, (controller) => <ConnectionModal channel={channel} controller={controller} />, css));
} });
