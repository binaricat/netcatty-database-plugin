import React, { useState } from 'react';
import { definePlugin, type PluginContext, type DatabaseConnectionMeta } from '@netcatty/plugin-sdk';
import { registerHostReactView } from '@netcatty/plugin-sdk/host-react';
import { useWorkbench } from './useWorkbench';
import { selectObject } from './domain';
import { SqlAssistant } from './SqlAssistant';
import css from './style.css';
import { SqlEditor } from './SqlEditor';
import { clampEditorSplit, DEFAULT_EDITOR_SPLIT, MIN_EDITOR_SPLIT, MAX_EDITOR_SPLIT } from './sqlDisplay';
type Model = ReturnType<typeof useWorkbench>;
const colors: DatabaseConnectionMeta['color'][] = ['default', 'blue', 'green', 'purple', 'orange'];
function ConnectionDialog({ vm }: { vm: Model }) {
  const { t } = vm;
  const [page, setPage] = useState<'connection' | 'advanced'>('connection');
  const [nameDraft, setName] = useState<string | null>(null);
  const name = nameDraft ?? t("Synthetic SQLite"); const [color, setColor] = useState<DatabaseConnectionMeta['color']>('default');
  const [source, setSource] = useState<'memory' | 'file'>('memory');
  const [hostId, setHostId] = useState(''); const [hostFilter, setHostFilter] = useState(''); const [savePassword, setSavePassword] = useState(false); const [password, setPassword] = useState('');
  const ready = source === 'memory' || Boolean(vm.draftSession && 'readOnly' in vm.draftSession);
  return <div className="modal-shade"><section className="modal" role="dialog" aria-modal="true" aria-label={t("New Connection")}>
    <header className="modal-heading"><h2>{t("New Connection")}</h2><span>{t("SQLite / disposable fixtures")}</span></header>
    {vm.modal === 'picker' ? <><div className="type-picker"><nav aria-label={t("Database categories")}><strong>{t("Database Types")}</strong><p>{t("Relational")}</p><p className="selected-category">{t("Lightweight")}</p></nav><div className="type-list"><h3>{t("Lightweight")}</h3><button className="type-option selected" onClick={() => vm.setModal('connection')}><strong>SQLite</strong><small>{t("Embedded / disposable fixtures")}</small></button><h3>{t("Relational")}</h3>{['PostgreSQL', 'MySQL'].map((engine) => <button key={engine} className="type-option" disabled><strong>{engine}</strong><small>{t("Driver not implemented")}</small></button>)}</div></div><footer className="modal-footer"><span>{t("Selected: SQLite")}</span><button onClick={() => vm.setModal('connection')}>{t("Next")}</button><button className="secondary" onClick={() => void vm.dismiss()}>{t("Close")}</button></footer></> : <>
      <nav className="modal-tabs" aria-label={t("Connection settings")}><button className={page === 'connection' ? 'active' : ''} onClick={() => setPage('connection')}>{t("Connection")}</button><button className={page === 'advanced' ? 'active' : ''} onClick={() => setPage('advanced')}>{t("Advanced")}</button></nav>
      <div className="modal-content">{page === 'connection' ? <>
        <label>{t("Name")}<input aria-label={t("Connection name")} value={name} maxLength={128} disabled={vm.busy} onChange={(e) => setName(e.currentTarget.value)} /></label>
        <label>{t("Type")}<input value="SQLite" readOnly /></label><div className="color-field"><span className="field-label">{t("Color")}</span><div className="swatches">{colors.map((c) => <button key={c} aria-label={t("Color {color}", { color: t(c) })} aria-pressed={color === c} className={`swatch color-${c} ${color === c ? 'chosen' : ''}`} onClick={() => setColor(c)} />)}</div></div>
        <label>{t("File Path")}<select aria-label={t("SQLite source")} value={source} disabled={vm.busy} onChange={(e) => { const file = e.currentTarget.value === 'file'; setSource(file ? 'file' : 'memory'); void vm.selectSource(file); }}><option value="memory">{t(":memory: - disposable synthetic notes")}</option><option value="file" disabled={!vm.fileEnabled}>{t("Host-selected SQLite file (read-only)")}</option></select></label>
        {source === 'file' && vm.walEnabled && <p className="hint">{t("Stable fixture WAL: verified read-only snapshot. Changes require reopening; no concurrent writers, checkpoint or recovery.")}</p>}
        {source === 'file' && <div className="file-choice"><span>{ready ? t("Disposable SQLite file (read-only)") : t("No file selected")}</span><button className="secondary" disabled={!vm.fileEnabled || vm.busy} onClick={() => void vm.selectSource(true)}>{t("Choose file...")}</button></div>}
        <p className="hint">{t("Choose an allowlisted disposable fixture. File paths stay with the host; memory data resets on open.")}</p>
        <label className="check"><input type="checkbox" checked={savePassword} disabled={!vm.persistence || vm.busy} onChange={(e) => { setSavePassword(e.currentTarget.checked); setPassword(''); }} />{t("Save password")}</label>
        {savePassword && <label>{t("Synthetic credential (storage test only)")}<input type="password" aria-label={t("Synthetic password")} autoComplete="off" value={password} maxLength={4096} disabled={vm.busy} onChange={(e) => setPassword(e.currentTarget.value)} /></label>}
        <p className="hint">{t("SQLite needs no password. Optional synthetic credentials use host OS encryption and return only an opaque secretRef; no SQLCipher or remote authentication.")}</p>
      </> : <div className="advanced"><h3>{t("Existing host context")}</h3>
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
      <p role="status" className="test-status">{vm.tested ? t("Connection successful - host schema validated") : t("Test the selected fixture before connecting.")}</p>
      {vm.error && <p className="error" role="alert">{vm.error}</p>}</div>
      <footer className="modal-footer"><button className="secondary" disabled={!ready || vm.busy || vm.portProbe.busy || vm.liveSshPg.busy || vm.tunnel.busy} onClick={() => void vm.test()}>{t("Test")}</button><button disabled={!ready || vm.busy || vm.portProbe.busy || vm.liveSshPg.busy || vm.tunnel.busy || !name.trim() || (savePassword && !password)} onClick={() => { const secret = savePassword ? password : undefined; setPassword(''); if (vm.persistence) void vm.save({ name: name.trim(), color, ...(hostId ? { hostId } : {}) }, secret); else void vm.openUnsaved(); }}>{vm.persistence ? t("Save & Connect") : t("Connect without saving")}</button><button className="secondary" disabled={vm.busy} onClick={() => void vm.dismiss()}>{t("Close")}</button></footer>
    </>}
  </section></div>;
}
function SchemaTree({ vm }: { vm: Model }) {
  const { t } = vm;
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const toggle = (key: string) => setCollapsed((items) => items.includes(key) ? items.filter((x) => x !== key) : [...items, key]);
  const expanded = (key: string) => !collapsed.includes(key);
  const objects = vm.schema?.tables ?? [];
  return <div className="schema-tree">
    <div className="tree-connection-row"><button className="tree-toggle tree-connection" aria-label={t("Toggle connection schema")} aria-expanded={expanded('connection')} onClick={() => toggle('connection')}><span aria-hidden="true" className={expanded('connection') ? 'chevron expanded' : 'chevron'} /><span className="color-dot" aria-hidden="true" /><span className="tree-label">{vm.connectionName}</span></button>{vm.saved.some((c) => c.id === vm.connectedId) && <button className="delete-connection" aria-label={t("Delete {name}", { name: vm.connectionName })} disabled={vm.busy} onClick={() => void vm.remove(vm.connectedId)}>x</button>}</div>
    {expanded('connection') && <div className="database-node">
      <button className="tree-toggle" aria-label={t("Toggle main schema")} aria-expanded={expanded('main')} onClick={() => toggle('main')}><span aria-hidden="true" className={expanded('main') ? 'chevron expanded' : 'chevron'} />main</button>
      {expanded('main') && <>
        <label className="schema-filter"><input placeholder={t("Search objects...")} aria-label={t("Search schema objects")} value={filter} maxLength={64} onChange={(e) => setFilter(e.currentTarget.value)} /></label>
        {(['table', 'view'] as const).map((kind) => {
          const list = objects.filter((object) => (object.kind ?? 'table') === kind);
          const matches = list.filter((object) => object.name.toLowerCase().includes(filter.toLowerCase()));
          const label = kind === 'table' ? t("Tables") : t("Views");
          return <div key={kind}>
            <button className="tree-toggle tree-group" aria-label={t("Toggle {label}", { label })} aria-expanded={expanded(kind)} onClick={() => toggle(kind)}><span aria-hidden="true" className={expanded(kind) ? 'chevron expanded' : 'chevron'} />{`${label} (${list.length})`}</button>
            {expanded(kind) && <>{matches.map((object) => <div key={object.name} className="table-node"><button aria-label={t(kind === "table" ? "Open table {name}" : "Open view {name}", { name: object.name })} aria-pressed={vm.tab?.objectName === object.name} disabled={vm.busy || vm.tabs.length >= 8 && !vm.tabs.some((tab) => tab.objectName === object.name)} onClick={() => vm.addTab(object.name)}><span aria-hidden="true" className={`object-icon ${kind}`} />{object.name}</button></div>)}{!matches.length && <small>{list.length ? t("No matching objects") : t(kind === "table" ? "No tables" : "No views")}</small>}</>}
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
function Workbench({ context }: { context: PluginContext }) {
  const vm = useWorkbench(context); const { t } = vm; const [connectionFilter, setConnectionFilter] = useState(''); const [connectionPage, setConnectionPage] = useState(0);
  const matches = vm.saved.filter((c) => c.name.toLowerCase().includes(connectionFilter.toLowerCase()));
  const page = Math.min(connectionPage, Math.max(0, Math.ceil(matches.length / 20) - 1)); const [showAI, setShowAI] = useState(false);
  const [editorSplit, setEditorSplit] = useState(DEFAULT_EDITOR_SPLIT);
  const result = vm.tab?.result;
  // Only the exact generated SELECT has known provenance; edited SQL is not parsed.
  const resultObject = vm.schema?.tables.find((object) => vm.tab?.resultSql === selectObject(object.name));
  const icon = `asset:assets/icons/sqlite-${vm.theme === 'light' ? 'light' : 'dark'}.svg`;
  return <main className="database-workbench">
    <header className="app-toolbar"><strong className="brand"><img src={icon} alt="" width="20" height="20" />{t("Database")}</strong><button className="toolbar-button" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}>{t("+ New Connection")}</button><button className="toolbar-button" disabled={!vm.session || vm.busy || vm.tabs.length >= 8} onClick={() => vm.addTab()}>{t("+ New Query")}</button><span className="experimental">{t("EXPERIMENTAL")}</span></header>
    <div className="shell"><aside className="connection-sidebar"><div className="sidebar-heading"><strong>{t("Connections")}</strong><span>{vm.saved.length}</span></div><p className="sidebar-status">{t("Active connections: {count}", { count: vm.session ? 1 : 0 })}</p>
      <label className="connection-filter"><input placeholder={t("Filter connections...")} aria-label={t("Filter connections")} value={connectionFilter} maxLength={128} onChange={(e) => { setConnectionFilter(e.currentTarget.value); setConnectionPage(0); }} /></label><div className="connection-list">{vm.saved.length ? matches.slice(page * 20, (page + 1) * 20).map((c) => vm.session && vm.connectedId === c.id ? <SchemaTree key={vm.session.handleId} vm={vm} /> : <div key={c.id} className={`saved-connection ${vm.connectedId === c.id ? 'selected' : ''}`}><button className="connection-name" disabled={vm.busy || vm.connectedId === c.id} onClick={() => void vm.open(c)}><span className={`color-dot color-${c.color}`} /><span>{c.name}</span></button><button className="delete-connection" aria-label={t("Delete {name}", { name: c.name })} disabled={vm.busy} onClick={() => void vm.remove(c.id)}>x</button></div>) : <p className="empty-sidebar">{t("No connections yet")}</p>}</div>
      {vm.session && !matches.slice(page * 20, (page + 1) * 20).some((c) => c.id === vm.connectedId) && <SchemaTree key={vm.session.handleId} vm={vm} />}
      <div className="sidebar-footer">{matches.length > 20 && <div className="connection-pages"><button className="secondary" aria-label={t("Previous connections")} disabled={page === 0} onClick={() => setConnectionPage(page - 1)}>{t("Previous")}</button><span>{page + 1} / {Math.ceil(matches.length / 20)}</span><button className="secondary" aria-label={t("Next connections")} disabled={(page + 1) * 20 >= matches.length} onClick={() => setConnectionPage(page + 1)}>{t("Next")}</button></div>}{t("SQLite fixtures only")}{vm.session && <><span>{'readOnly' in vm.session ? t("Read-only file") : t("Disposable memory")}</span><button className="secondary" disabled={vm.busy} onClick={() => void vm.disconnect()}>{t("Close connection")}</button></>}</div>
    </aside><section className="workspace">
      {!vm.session ? <div className="home"><div className="home-metrics"><div><span>{t("Connections")}</span><strong>{vm.saved.length}</strong></div><div><span>{t("Connected")}</span><strong>0</strong></div><div><span>{t("Database Types")}</span><strong>{vm.saved.length ? 1 : 0}</strong></div></div><div className="home-panels"><section className="home-panel"><h2>{t("Quick Start")}</h2><div className="home-welcome"><p>{vm.saved.length ? t("Your connections, ready to reopen") : t("No connections yet")}</p><p>{vm.saved.length ? t("Select a saved connection on the left. The host validates its target again.") : t("Create a connection to explore disposable SQLite data.")}</p><button className="secondary" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}>{t("New Connection")}</button></div></section><section className="home-panel"><h2>{t("Shortcuts")}</h2><div className="shortcut-row"><button className="shortcut" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}>{t("+ New Connection")}<small>{t("SQLite / local fixtures")}</small></button><button className="shortcut" disabled>{t("History")}<small>{t("Not available in this milestone")}</small></button></div></section></div><p className="hint home-note">{!vm.enabled ? t("The host SQLite experiment is disabled or unavailable.") : !vm.persistence ? t("This host does not support saved connections. Temporary connections remain available.") : t("Saved connections contain metadata only. Memory contents are never persisted.")}</p></div> : <>
        <nav className="tab-strip" aria-label={t("Workspace tabs")}>{vm.tabs.map((tab) => <div key={tab.id} className={vm.activeTab === tab.id ? 'workspace-tab active' : 'workspace-tab'}><button aria-pressed={vm.activeTab === tab.id} onClick={() => vm.setActiveTab(tab.id)}>{vm.tabTitle(tab)}</button><button aria-label={`Close ${vm.tabTitle(tab)}`} disabled={vm.busy} onClick={() => vm.closeTab(tab.id)}>x</button></div>)}</nav>
        {vm.tab?.objectName && <nav className="object-tabs" aria-label={t("Object surface")}><button className={vm.tab.surface === 'structure' ? 'active' : ''} aria-pressed={vm.tab.surface === 'structure'} onClick={() => vm.edit({ surface: 'structure' })}>{t("Structure")}</button><button className={vm.tab.surface === 'data' ? 'active' : ''} aria-pressed={vm.tab.surface === 'data'} onClick={() => vm.edit({ surface: 'data' })}>{t("Data")}</button></nav>}
        {vm.tab?.surface === 'structure' ? <Structure vm={vm} /> : vm.tab ? <div className={vm.tab.objectName ? "query-split object-split" : "query-split"} style={{'--plugin-editor-split': `${editorSplit}%`} as React.CSSProperties}><section className={vm.tab.objectName ? "editor object-editor" : "editor"}><div className="query-toolbar"><button disabled={vm.busy} onClick={() => void vm.run('read')}>{t("Run read query")}</button><button className="secondary" disabled={vm.busy || 'readOnly' in vm.session} onClick={() => void vm.run('write')}>{t("Review write...")}</button><button className="secondary" onClick={() => void vm.disconnect(true)}>{t("Cancel / close")}</button><span>{vm.connectionName} / main{vm.tab.objectName ? ` / ${vm.tab.objectName}` : ""}</span></div><SqlEditor sql={vm.tab.sql} disabled={vm.busy} onChange={(sql) => vm.edit({ sql })} t={t} /><label className="parameters">{t("Parameters")}<input aria-label={t("SQL parameters")} value={vm.tab.parameters} maxLength={8192} disabled={vm.busy} onChange={(e) => vm.edit({ parameters: e.currentTarget.value })} /></label></section>
        {!vm.tab.objectName && <input className="query-splitter" type="range" aria-label={t("SQL editor height")} title={t("Adjust editor height with arrow keys or click the track")} aria-valuetext={t("Editor {percent}%", { percent: editorSplit })} min={MIN_EDITOR_SPLIT} max={MAX_EDITOR_SPLIT} step={1} value={editorSplit} onChange={(e) => setEditorSplit(clampEditorSplit(Number(e.currentTarget.value)))} />}
        <section className="results"><div className="results-heading"><strong>{vm.tab.objectName ? t("Table Data") : t("Results")}</strong><span>{t("Preview: 20 rows / 8 columns / 256 chars per cell")}</span></div>{result?.columns.length ? <div className="table-scroll"><table><thead><tr><th>#</th>{result.columns.slice(0, 8).map((col, i) => {
          const type = resultObject?.columns.find((column) => column.name === col)?.type;
          return <th key={i}>{col}<small className="result-type" title={type ? t("Type") : t("Result type unavailable")}>{type || '—'}</small></th>;
        })}</tr></thead><tbody>{result.rows.slice(0, 20).map((row, i) => <tr key={i} tabIndex={0}><td className="row-index">{i + 1}</td>{row.slice(0, 8).map((cell, j) => <td key={j} className={cell === null ? "null-cell" : typeof cell === "number" ? "number-cell" : undefined}>{cell === null ? 'NULL' : String(cell).length > 256 ? String(cell).slice(0, 256) + '...' : String(cell)}</td>)}</tr>)}</tbody></table></div> : <div className="empty-results">{result ? t("Statement completed. No result rows.") : t("Run a query to view results.")}</div>}<div className="result-status" role="status">{vm.busy ? t("Waiting for host...") : result ? t("{rows} rows / {columns} columns / {ms} ms / {changes} changes", { rows: result.rows.length, columns: result.columns.length, ms: result.elapsedMs, changes: result.changes }) + (result.truncated ? t(" / truncated") : "") : t("Nothing executed")}{result && <span className="result-sql" title={vm.tab.resultSql}>{vm.tab.resultSql}</span>}</div></section></div> : <div className="empty-results">{t("Open a table or create a new query.")}</div>}
        <section className="ai-secondary"><button className="toolbar-button" aria-expanded={showAI} onClick={() => setShowAI(!showAI)}>{t("AI SQL assistant")}</button>{showAI && <SqlAssistant key={`${vm.session.handleId}:${vm.activeTab}`} context={context} schema={vm.schema} sql={vm.tab?.sql ?? ''} label={vm.connectionName} disabled={vm.busy || !vm.tab} insert={(sql) => vm.edit({ sql, parameters: '[]', result: null, resultSql: undefined })} t={t} />}</section>
      </>}
      {vm.error && !vm.modal && <p className="error" role="alert">{vm.error}</p>}
    </section></div><footer className="app-status">{vm.session ? vm.connectionName : t("No database connected")}<span>{t("Netcatty host permissions / SQLite fixture service")}</span></footer>
    {vm.modal && <ConnectionDialog vm={vm} />}
  </main>;
}
export default definePlugin({ activate(context) { context.subscriptions.add(registerHostReactView(context.views, 'com.binaricat.netcatty-database.workbench', () => <Workbench context={context} />, css)); } });
