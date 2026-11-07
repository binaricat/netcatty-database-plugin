import React, { useState } from 'react';
import { definePlugin } from '@netcatty/plugin-sdk';
import type { DatabaseConnectionMeta } from './databaseTypes';
import { registerHostReactView } from '@netcatty/plugin-sdk/host-react';
import { useWorkbench } from './useWorkbench';
import { selectObject } from './domain';
import { SqlAssistant } from './SqlAssistant';
import css from './style.css';
import { Icon } from './Icon';
import { driverById, filterDrivers, type DriverId, type DriverCategory } from './driverRegistry';
import { previewSummary } from './preview';
import { ResultGrid } from './ResultGrid';
import { SqlEditor } from './SqlEditor';
import type { DatabaseVariantId, DatabaseTcpOpenRequest } from './databaseTypes';
import { clampEditorSplit, DEFAULT_EDITOR_SPLIT, MIN_EDITOR_SPLIT, MAX_EDITOR_SPLIT } from './sqlDisplay';
import { createWorkbenchContext } from './sqliteClient';
import type { WorkbenchContext } from './databaseClient';
type Model = ReturnType<typeof useWorkbench>;
const CONNECTION_PAGE_SIZE = 10;
function EngineIcon({ engine, theme }: { engine: DriverId | 'postgresql'; theme: string }) {
  const driver = driverById(engine === 'postgresql' ? 'postgres' : engine);
  const icon = driver.icon;
  return icon ? <img className={`engine-icon engine-${driver.id}`} src={`asset:assets/icons/${icon}-${theme === 'dark' ? 'dark' : 'light'}.png`} alt="" width={32} height={32} /> : <span className={`engine-fallback engine-${driver.id}`}><Icon name="database" /></span>;
}
const colors: DatabaseConnectionMeta['color'][] = ['default', 'blue', 'green', 'purple', 'orange'];
function ConnectionDialog({ vm }: { vm: Model }) {
  const { t } = vm;
  const [category, setCategory] = useState<DriverCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [name, setName] = useState(t("Synthetic SQLite"));
  const [color, setColor] = useState<DatabaseConnectionMeta['color']>('default');
  const driver = vm.selectedDriver;
  const sqlite = driver.id === 'sqlite';
  const categories = [['all', 'All databases'], ['relational', 'Relational'], ['domestic', 'Domestic'], ['lightweight', 'Lightweight'], ['analytics', 'Analytics'], ['document', 'Document & cache']] as const;
  return <section className="connection-dialog" role="dialog" aria-label={t("New Connection")}>
    <header className="flow-heading"><div><h2>{t(vm.modal === 'picker' ? "Choose database" : "Connection details")}</h2><p>{t("Configure your database connection.")}</p></div><button className="secondary" onClick={() => void vm.dismiss()}>{t("Close")}</button></header>
    {vm.modal === 'picker' ? <>
      <div className="type-picker"><nav aria-label={t("Database categories")}>{categories.map(([id,label]) => <button key={id} aria-pressed={category === id} className={category === id ? 'selected-category' : ''} onClick={() => setCategory(id)}>{t(label)}</button>)}</nav>
      <div className="type-list"><label className="catalog-search"><Icon name="search" /><input aria-label={t("Search databases")} placeholder={t("Search databases...")} value={search} maxLength={64} onChange={e => setSearch(e.currentTarget.value)} /></label>
      <div className="catalog-results"><div className="engine-grid">{filterDrivers(category,search).map(engine => <button key={engine.id} aria-label={engine.label} aria-pressed={driver.id === engine.id} className={`type-option ${driver.id === engine.id ? 'selected' : ''}`} disabled={vm.busy} onClick={() => void vm.selectDriver(engine.id)}><span className="engine-mark"><EngineIcon engine={engine.id} theme={vm.theme} /></span><strong>{engine.label}</strong><small>{engine.id === 'sqlite' ? t("Available") : t("Driver not packaged")}</small></button>)}</div></div></div></div>
      <footer className="modal-footer"><span>{driver.label}</span><button onClick={() => vm.setModal('connection')}>{t("Next")}</button></footer>
    </> : <>
      <div className="connection-form"><label>{t("Name")}<input aria-label={t("Connection name")} value={name} maxLength={128} disabled={vm.busy} onChange={e => setName(e.currentTarget.value)} /></label><div className="engine-field"><span>{driver.label}</span><EngineIcon engine={driver.id} theme={vm.theme} /></div>
      {sqlite ? <><p className="hint">{t("Plugin-owned SQLite memory workspace. Read-only sample data; no host database service or user files.")}</p><label>{t("Color")}<select aria-label={t("Connection color")} value={color} onChange={e => setColor(e.currentTarget.value as DatabaseConnectionMeta['color'])}>{colors.map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label></> : <p className="hint">{t("Driver not packaged")}. {t("Vendor compatibility is unverified. Choose an explicit product variant; unsupported authentication or modes remain unavailable.")}</p>}
      {vm.tested && <p role="status">{t("Connection successful - SQLite schema validated")}</p>}{vm.error && <p className="error" role="alert">{vm.error}</p>}</div>
      <footer className="modal-footer"><button className="secondary" disabled={vm.busy} onClick={() => vm.setModal('picker')}>{t("Back")}</button><button className="secondary" disabled={!sqlite || vm.busy} onClick={() => void vm.test()}>{t("Test")}</button><button disabled={!sqlite || vm.busy || !name.trim()} onClick={() => void vm.save({name:name.trim(),color})}>{t("Save & Connect")}</button></footer>
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
      <button className="tree-toggle" aria-label={t("Toggle main schema")} aria-expanded={expanded('main')} onClick={() => toggle('main')}><Icon name={expanded('main') ? 'chevron-down' : 'chevron-right'} /><Icon name="database" />{vm.session?.engine === 'sqlite' ? 'main' : t("Database")}</button>
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
    <div className="results-heading"><strong>{`${vm.connectionName} / ${object.name}`}</strong><span>{t("Connected database / Read-only structure")}</span></div>
    <div className="results-heading"><strong>{t("Columns")}</strong><span>{t("{count} columns / {kind}", { count: object.columns.length, kind: t(object.kind ?? "table") })}</span></div>
    <div className="table-scroll"><table><thead><tr><th>#</th><th>{t("Column")}</th><th>{t("Type")}</th><th>{t("Nullable")}</th><th>{t("Primary Key")}</th></tr></thead><tbody>{object.columns.map((c, i) => <tr key={c.name} tabIndex={0}><td className="row-index">{i + 1}</td><td>{c.name}</td><td className="column-type"><span className="type-label">{c.type}</span></td><td>{c.nullable === undefined ? t("Unknown") : c.nullable ? t("Yes") : t("No")}</td><td>{c.primaryKey ? t("Yes") : t("No")}</td></tr>)}</tbody></table></div>
    <div className="result-status">{object.kind === 'view' ? t("View nullability is not inferred.") : t("Column metadata from the connected database.")} {t("Schema editing is unavailable.")}</div>
  </section>;
}
function QueryLibraryPanel({ vm }: { vm: Model }) {
  const {t} = vm; const [name,setName] = useState(''); const [page,setPage] = useState(0);
  const entries = [...vm.queryLibrary.saved.map(entry => ({...entry, kind:'saved' as const})), ...vm.queryLibrary.history.map(entry => ({...entry, name:entry.sql.slice(0,80),kind:'history' as const}))];
  const current=Math.min(page,Math.max(0,Math.ceil(entries.length/8)-1));
  return <section className="query-library" aria-label={t('Query library')}><p>{t('Query library is kept in this view only. Loading never executes SQL.')}</p><label>{t('Query name')}<input aria-label={t('Query name')} value={name} maxLength={128} onChange={e=>setName(e.currentTarget.value)} /></label><button className="secondary" disabled={!vm.tab || vm.busy || !name.trim()} onClick={()=>vm.saveCurrentQuery(name)}>{t('Save current SQL')}</button><button className="secondary" disabled={!vm.queryLibrary.history.length} onClick={vm.clearHistory}>{t('Clear history')}</button><div>{entries.slice(current*8,current*8+8).map(entry=><div key={entry.id}><button className="secondary" disabled={!vm.tab || vm.busy} onClick={()=>vm.loadQuery(entry)} title={entry.sql}>{entry.kind==='saved' ? '★ ' : 'success' in entry && entry.success ? '✓ ' : '✗ '}{entry.name}</button>{entry.kind==='saved' && <button className="secondary" onClick={()=>vm.removeSavedQuery(entry.id)}>{t('Remove saved SQL')}</button>}</div>)}</div><button className="secondary" disabled={current===0} onClick={()=>setPage(current-1)}>{t('Previous')}</button><span>{t('Page {page} / {pages}',{page:current+1,pages:Math.max(1,Math.ceil(entries.length/8))})}</span><button className="secondary" disabled={(current+1)*8>=entries.length} onClick={()=>setPage(current+1)}>{t('Next')}</button></section>;
}
function Workbench({ context }: { context: WorkbenchContext }) {
  const vm = useWorkbench(context);
  const { t } = vm; const [connectionFilter, setConnectionFilter] = useState(''); const [connectionPage, setConnectionPage] = useState(0);
  const matches = vm.saved.filter((c) => c.name.toLowerCase().includes(connectionFilter.toLowerCase()));
  const page = Math.min(connectionPage, Math.max(0, Math.ceil(matches.length / CONNECTION_PAGE_SIZE) - 1)); const [showAI, setShowAI] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [editorSplit, setEditorSplit] = useState(DEFAULT_EDITOR_SPLIT);
  const result = vm.tab?.result;
  const preview = result ? previewSummary(result) : null;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Only the exact generated SELECT has known provenance; edited SQL is not parsed.
  const resultObject = vm.schema?.tables.find((object) => vm.tab?.resultSql === selectObject(object.name, vm.session?.engine));
  return <main className="database-workbench">
    <header className="app-toolbar">
      <button className="icon-button toolbar-button" aria-label={t("Toggle connections")} aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="panel-left" /></button>
      <button className="toolbar-button" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}><Icon name="plus" />{t("New Connection")}</button>
      <button className="toolbar-button" disabled={!vm.session || vm.busy || vm.tabs.length >= 8} onClick={() => vm.addTab()}><Icon name="file-code" />{t("New Query")}</button>
      {vm.walRefreshEnabled && vm.session && 'revision' in vm.session && <button className="toolbar-button" disabled={vm.busy} onClick={() => void vm.refresh()}><Icon name="refresh" />{t("Refresh WAL fixture")}</button>}
      <button className="toolbar-button" aria-expanded={showLibrary} onClick={() => setShowLibrary(!showLibrary)}>{t("Query library")}</button>
      <span className="experimental">{t("EXPERIMENTAL")}</span>
      <button className={showAI && vm.session ? "toolbar-button ai-toggle active" : "toolbar-button ai-toggle"} disabled={!vm.session} aria-expanded={showAI && Boolean(vm.session)} onClick={() => setShowAI(!showAI)}><Icon name="sparkles" />{t("AI SQL assistant")}</button>
    </header>
    <div className={sidebarOpen ? "shell" : "shell sidebar-hidden"}><aside className="connection-sidebar"><div className="sidebar-heading"><strong>{t("Connections")}</strong></div><p className={`sidebar-status ${vm.session ? "is-connected" : vm.error ? "is-error" : "is-disconnected"}`} role="status">{t(vm.session ? "Connected" : vm.error ? "Connection unavailable" : "No database connected")}</p>
      <label className="connection-filter"><input placeholder={t("Filter connections...")} aria-label={t("Filter connections")} value={connectionFilter} maxLength={128} onChange={(e) => { setConnectionFilter(e.currentTarget.value); setConnectionPage(0); }} /></label><div className="connection-list">{vm.saved.length ? matches.slice(page * CONNECTION_PAGE_SIZE, (page + 1) * CONNECTION_PAGE_SIZE).map((c) => vm.session && vm.connectedId === c.id ? <SchemaTree key={vm.session.handleId} vm={vm} /> : <div key={c.id} className={`saved-connection ${vm.connectedId === c.id ? 'selected' : ''}`}><button className="connection-name" disabled={vm.busy || vm.connectedId === c.id} onClick={() => void vm.open(c)}><span className={`color-dot color-${c.color}`} /><span title={c.name}>{c.name}</span></button><button className="delete-connection" aria-label={t("Delete {name}", { name: c.name })} disabled={vm.busy} onClick={() => void vm.remove(c.id)}><Icon name="x" /></button></div>) : <p className="empty-sidebar">{t("No connections yet")}</p>}</div>
      {vm.session && !matches.slice(page * CONNECTION_PAGE_SIZE, (page + 1) * CONNECTION_PAGE_SIZE).some((c) => c.id === vm.connectedId) && <SchemaTree key={vm.session.handleId} vm={vm} />}
      <div className="sidebar-footer">{matches.length > CONNECTION_PAGE_SIZE && <div className="connection-pages"><button className="secondary" aria-label={t("Previous connections")} disabled={page === 0} onClick={() => setConnectionPage(page - 1)}>{t("Previous")}</button><button className="secondary" aria-label={t("Next connections")} disabled={(page + 1) * CONNECTION_PAGE_SIZE >= matches.length} onClick={() => setConnectionPage(page + 1)}>{t("Next")}</button></div>}{vm.session && <><button className="secondary" disabled={vm.busy} onClick={() => void vm.disconnect()}><Icon name="unplug" />{t("Close connection")}</button></>}</div>
    </aside><section className={showAI && vm.session ? "workspace ai-open" : "workspace"}>
      {showLibrary && <QueryLibraryPanel vm={vm} />}
      {!vm.session ? <div className="home"><div className="home-intro"><Icon name="database" /><h1>{t("Your data, inside Netcatty")}</h1><p>{t("Plugin-owned SQLite memory workspace. Read-only sample data; no host database service or user files.")}</p></div><div className="home-metrics"><div><span>{t("Connections")}</span><strong>{t(vm.saved.length ? "Available" : "No connections yet")}</strong></div><div><span>{t("Connected")}</span><strong>{t("Unavailable")}</strong></div><div><span>{t("Database Types")}</span><strong>{t("SQLite memory only")}</strong></div></div><div className="home-panels"><section className="home-panel"><h2>{t("Quick Start")}</h2><div className="home-welcome"><p>{vm.saved.length ? t("Your connections, ready to reopen") : t("No connections yet")}</p><p>{vm.saved.length ? t("Select a saved connection on the left. The host validates its target again.") : t("Create a connection to explore disposable SQLite data.")}</p><button className="secondary" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}>{t("New Connection")}</button></div></section><section className="home-panel"><h2>{t("Shortcuts")}</h2><div className="shortcut-row"><button className="shortcut" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}><Icon name="plus" />{t("New Connection")}<small>{t("SQLite / local fixtures")}</small></button><button className="shortcut" onClick={()=>setShowLibrary(true)}>{t("History")}</button></div></section></div><p className="hint home-note">{!vm.enabled ? t("The host SQLite experiment is disabled or unavailable.") : !vm.persistence ? t("This host does not support saved connections. Temporary connections remain available.") : t("Saved connections contain metadata only. Memory contents are never persisted.")}</p></div> : <>
        {vm.walRefreshEnabled && 'revision' in vm.session && <details className="session-notice"><summary><Icon name="shield" />{t("Read-only fixture · pause writers during reads")}</summary><p>{t("Explicit WAL refresh: pause all writers through refresh and reads. Click Refresh WAL fixture for appended commits in this open session. Checkpoints or replaced files require choosing again. No polling, automatic retry or uninterrupted capture.")}</p></details>}
        <nav className="tab-strip" aria-label={t("Workspace tabs")}>{vm.tabs.map((tab) => <div key={tab.id} className={vm.activeTab === tab.id ? 'workspace-tab active' : 'workspace-tab'}><button aria-pressed={vm.activeTab === tab.id} onClick={() => vm.setActiveTab(tab.id)}><Icon name={tab.objectName ? "table" : "file-code"} /><span title={vm.tabTitle(tab)}>{vm.tabTitle(tab)}</span></button><button aria-label={t("Close {name}", { name: vm.tabTitle(tab) })} disabled={vm.busy} onClick={() => vm.closeTab(tab.id)}><Icon name="x" /></button></div>)}</nav>
        {vm.tab?.objectName && <nav className="object-tabs" aria-label={t("Object surface")}><button className={vm.tab.surface === 'structure' ? 'active' : ''} aria-pressed={vm.tab.surface === 'structure'} onClick={() => vm.edit({ surface: 'structure' })}>{t("Structure")}</button><button className={vm.tab.surface === 'data' ? 'active' : ''} aria-pressed={vm.tab.surface === 'data'} onClick={() => vm.edit({ surface: 'data' })}>{t("Data")}</button></nav>}
        {vm.tab?.surface === 'structure' ? <Structure vm={vm} /> : vm.tab ? <div className={vm.tab.objectName ? "query-split object-split" : "query-split"} style={{'--plugin-editor-split': `${editorSplit}%`} as React.CSSProperties}><section className={vm.tab.objectName ? "editor object-editor" : "editor"}><div className="query-toolbar"><button disabled={vm.busy} onClick={() => void vm.run('read')}><Icon name={vm.busy ? "loader" : "play"} />{t("Run read query")}</button><button className="secondary" disabled={vm.busy || 'readOnly' in vm.session} onClick={() => void vm.run('write')}>{t("Review write...")}</button><button className="secondary" onClick={() => void vm.disconnect(true)}><Icon name="square" />{t("Cancel / close")}</button><span className="query-context" title={vm.connectionName}>{vm.connectionName}{vm.session.engine === 'sqlite' ? ' / main' : ''}{vm.tab.objectName ? ` / ${vm.tab.objectName}` : ""}</span></div><SqlEditor sql={vm.tab.sql} disabled={vm.busy} onChange={(sql) => vm.edit({ sql })} t={t} /><label className="parameters">{t("Parameters")}<input aria-label={t("SQL parameters")} value={vm.tab.parameters} maxLength={8192} disabled={vm.busy} onChange={(e) => vm.edit({ parameters: e.currentTarget.value })} /></label></section>
        {!vm.tab.objectName && <input className="query-splitter" type="range" aria-label={t("SQL editor height")} title={t("Adjust editor height with arrow keys or click the track")} aria-valuetext={t("Editor {percent}%", { percent: editorSplit })} min={MIN_EDITOR_SPLIT} max={MAX_EDITOR_SPLIT} step={1} value={editorSplit} onChange={(e) => setEditorSplit(clampEditorSplit(Number(e.currentTarget.value)))} />}
        <section className="results" aria-busy={vm.busy}><div className="results-heading"><strong>{vm.tab.objectName ? t("Table Data") : t("Results")}</strong><span>{preview ? t("Showing {rows} of {total} rows · {columns} of {allColumns} columns", { rows: preview.shownRows, total: preview.totalRows, columns: preview.shownColumns, allColumns: preview.totalColumns }) : t("Preview: 20 rows / 8 columns / 256 chars per cell")}</span></div>{result?.columns.length ? <ResultGrid key={`${vm.activeTab}:${vm.tab.resultSql}:${result.elapsedMs}`} result={result} t={t} columnTypes={resultObject?.columns} /> : <div className="empty-results"><Icon name={vm.busy ? "loader" : "table"} /><p>{vm.busy ? t("Waiting for host...") : result ? t("Statement completed. No result rows.") : t("Run a query to view results.")}</p></div>}<div className="preview-disclosure">{t("Preview: 20 rows / 8 columns / 256 chars per cell")}{preview && preview.clippedCells > 0 && <strong>{t("{count} visible cells shortened", { count: preview.clippedCells })}</strong>}{preview?.hostTruncated && <strong>{t("Host result truncated")}</strong>}</div><div className="result-status" role="status">{vm.busy ? t("Waiting for host...") : result ? t("{rows} rows / {columns} columns / {ms} ms / {changes} changes", { rows: result.rows.length, columns: result.columns.length, ms: result.elapsedMs, changes: result.changes }) + (result.truncated ? t(" / truncated") : "") : t("Nothing executed")}{result && <span className="result-sql" title={vm.tab.resultSql}>{vm.tab.resultSql}</span>}</div></section></div> : <div className="empty-results">{t("Open a table or create a new query.")}</div>}
        {showAI && <aside className="ai-secondary" aria-label={t("AI SQL assistant")}><header className="ai-heading"><Icon name="sparkles" /><strong>{t("AI SQL assistant")}</strong><button className="icon-button toolbar-button" aria-label={t("Close AI assistant")} onClick={() => setShowAI(false)}><Icon name="x" /></button></header><SqlAssistant key={`${vm.session.handleId}:${'revision' in vm.session ? vm.session.revision : 'memory'}:${vm.activeTab}`} context={context} schema={vm.schema} sql={vm.tab?.sql ?? ''} label={vm.connectionName} engine={vm.session.engine} dialect={'driverId' in vm.session ? vm.session.driverId : 'sqlite'} disabled={vm.busy || !vm.tab} insert={(sql) => vm.edit({ sql, parameters: '[]', result: null, resultSql: undefined })} t={t} /></aside>}
      </>}
      {vm.error && !vm.modal && <p className="error" role="alert"><Icon name="alert-circle" />{vm.error}</p>}
    </section></div><footer className="app-status">{vm.session ? vm.connectionName : t("No database connected")}<span>{t("Netcatty main / plugin-owned SQLite")}</span></footer>

    {vm.modal && <div className="connection-inline"><ConnectionDialog vm={vm} /></div>}
  </main>;
}
export default definePlugin({ activate(context) {
  const workbench = createWorkbenchContext(context);
  context.subscriptions.add(registerHostReactView(context.views, 'com.binaricat.netcatty-database.workbench', () => <Workbench context={workbench} />, css));
} });
