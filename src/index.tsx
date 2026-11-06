import React, { useState } from 'react';
import { definePlugin, type PluginContext, type DatabaseConnectionMeta } from '@netcatty/plugin-sdk';
import { registerHostReactView } from '@netcatty/plugin-sdk/host-react';
import { useWorkbench } from './useWorkbench';
import { defaultQuery } from './domain';
import css from './style.css';
type Model = ReturnType<typeof useWorkbench>;
const colors: DatabaseConnectionMeta['color'][] = ['default', 'blue', 'green', 'purple', 'orange'];
function ConnectionDialog({ vm }: { vm: Model }) {
  const [page, setPage] = useState<'connection' | 'advanced'>('connection');
  const [name, setName] = useState('Synthetic SQLite'); const [color, setColor] = useState<DatabaseConnectionMeta['color']>('default');
  const [source, setSource] = useState<'memory' | 'file'>('memory');
  const [hostId, setHostId] = useState(''); const [hostFilter, setHostFilter] = useState(''); const [savePassword, setSavePassword] = useState(false); const [password, setPassword] = useState('');
  const ready = source === 'memory' || Boolean(vm.draftSession && 'readOnly' in vm.draftSession);
  return <div className="modal-shade"><section className="modal" role="dialog" aria-modal="true" aria-label="New Connection">
    <header className="modal-heading"><h2>New Connection</h2><span>SQLite / disposable fixtures</span></header>
    {vm.modal === 'picker' ? <><div className="type-picker"><nav aria-label="Database categories"><strong>Database Types</strong><p>Relational</p><p className="selected-category">Lightweight</p></nav><div className="type-list"><h3>Lightweight</h3><button className="type-option selected" onClick={() => vm.setModal('connection')}><strong>SQLite</strong><small>Embedded / disposable fixtures</small></button><h3>Relational</h3>{['PostgreSQL', 'MySQL'].map((engine) => <button key={engine} className="type-option" disabled><strong>{engine}</strong><small>Driver not implemented</small></button>)}</div></div><footer className="modal-footer"><span>Selected: SQLite</span><button onClick={() => vm.setModal('connection')}>Next</button><button className="secondary" onClick={() => void vm.dismiss()}>Close</button></footer></> : <>
      <nav className="modal-tabs" aria-label="Connection settings"><button className={page === 'connection' ? 'active' : ''} onClick={() => setPage('connection')}>Connection</button><button className={page === 'advanced' ? 'active' : ''} onClick={() => setPage('advanced')}>Advanced</button></nav>
      <div className="modal-content">{page === 'connection' ? <>
        <label>Name<input aria-label="Connection name" value={name} maxLength={128} disabled={vm.busy} onChange={(e) => setName(e.currentTarget.value)} /></label>
        <div className="form-row"><label>Type<input value="SQLite" readOnly /></label><div><span className="field-label">Color</span><div className="swatches">{colors.map((c) => <button key={c} aria-label={`Color ${c}`} aria-pressed={color === c} className={`swatch color-${c} ${color === c ? 'chosen' : ''}`} onClick={() => setColor(c)} />)}</div></div></div>
        <label>File Path<select aria-label="SQLite source" value={source} disabled={vm.busy} onChange={(e) => { const file = e.currentTarget.value === 'file'; setSource(file ? 'file' : 'memory'); void vm.selectSource(file); }}><option value="memory">:memory: - disposable synthetic notes</option><option value="file" disabled={!vm.fileEnabled}>Host-selected SQLite file (read-only)</option></select></label>
        {source === 'file' && <div className="file-choice"><span>{ready ? vm.draftSession?.label : 'No file selected'}</span><button className="secondary" disabled={!vm.fileEnabled || vm.busy} onClick={() => void vm.selectSource(true)}>Choose file...</button></div>}
        <p className="hint">Choose an allowlisted disposable fixture. File paths stay with the host; memory data resets on open.</p>
        <label className="check"><input type="checkbox" checked={savePassword} disabled={!vm.persistence || vm.busy} onChange={(e) => { setSavePassword(e.currentTarget.checked); setPassword(''); }} />Save password</label>
        {savePassword && <label>Synthetic credential (storage test only)<input type="password" aria-label="Synthetic password" autoComplete="off" value={password} maxLength={4096} disabled={vm.busy} onChange={(e) => setPassword(e.currentTarget.value)} /></label>}
        <p className="hint">SQLite needs no password. Optional synthetic credentials use host OS encryption and return only an opaque secretRef; no SQLCipher or remote authentication.</p>
      </> : <div className="advanced"><h3>Existing host context</h3>
        <label>Filter hosts<input aria-label="Filter hosts" value={hostFilter} maxLength={128} onChange={(e) => setHostFilter(e.currentTarget.value)} /></label><label>Existing host (optional SSH context)<select aria-label="Existing host" disabled={vm.busy} value={hostId} onChange={(e) => setHostId(e.currentTarget.value)}><option value="">None - local SQLite</option>{vm.hosts.filter((h) => `${h.label} ${h.hostname}`.toLowerCase().includes(hostFilter.toLowerCase()) || h.hostId === hostId).slice(0, 40).map((h) => <option key={h.hostId} value={h.hostId}>{`${h.label.slice(0, 100)} / ${h.username.slice(0, 40)}@${h.hostname.slice(0, 100)}:${h.port}`}</option>)}</select></label>
        <button className="secondary" disabled={!vm.persistence || vm.busy} onClick={() => void vm.loadHosts()}>Load permitted hosts</button><p className="hint">Up to 40 matches shown; filter to narrow the list. Metadata only. Choosing an SSH host does not open a tunnel or make it the database.</p>
        <h3>Connection limits</h3><p>100 rows / 96 KiB / 3 seconds / 8 KiB SQL</p><h3>Transport and encryption</h3><p>SSH tunnels, TLS, SQLite encryption and extensions are unavailable in this fixture release.</p><h3>Advanced settings</h3><p>No additional settings are implemented.</p></div>}
      <p role="status" className="test-status">{vm.tested ? 'Connection successful - host schema validated' : 'Test the selected fixture before connecting.'}</p>
      {vm.error && <p className="error" role="alert">{vm.error}</p>}</div>
      <footer className="modal-footer"><button className="secondary" disabled={!ready || vm.busy} onClick={() => void vm.test()}>Test</button><button disabled={!ready || vm.busy || !name.trim() || (savePassword && !password)} onClick={() => { const secret = savePassword ? password : undefined; setPassword(''); if (vm.persistence) void vm.save({ name: name.trim(), color, ...(hostId ? { hostId } : {}) }, secret); else void vm.openUnsaved(); }}>{vm.persistence ? 'Save & Connect' : 'Connect without saving'}</button><button className="secondary" disabled={vm.busy} onClick={() => void vm.dismiss()}>Close</button></footer>
    </>}
  </section></div>;
}
function SchemaTree({ vm }: { vm: Model }) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const toggle = (key: string) => setCollapsed((items) => items.includes(key) ? items.filter((x) => x !== key) : [...items, key]);
  const expanded = (key: string) => !collapsed.includes(key);
  const objects = vm.schema?.tables ?? [];
  return <div className="schema-tree">
    <button className="tree-toggle tree-connection" aria-label="Toggle connection schema" aria-expanded={expanded('connection')} onClick={() => toggle('connection')}><span aria-hidden="true" className={expanded('connection') ? 'chevron expanded' : 'chevron'} /><span className="tree-label">{vm.connectionName}</span></button>
    {expanded('connection') && <div className="database-node">
      <button className="tree-toggle" aria-label="Toggle main schema" aria-expanded={expanded('main')} onClick={() => toggle('main')}><span aria-hidden="true" className={expanded('main') ? 'chevron expanded' : 'chevron'} />main</button>
      {expanded('main') && <>
        <label className="schema-filter"><input placeholder="Search objects..." aria-label="Search schema objects" value={filter} maxLength={64} onChange={(e) => setFilter(e.currentTarget.value)} /></label>
        {(['table', 'view'] as const).map((kind) => {
          const list = objects.filter((object) => (object.kind ?? 'table') === kind);
          const matches = list.filter((object) => object.name.toLowerCase().includes(filter.toLowerCase()));
          const label = kind === 'table' ? 'Tables' : 'Views';
          return <div key={kind}>
            <button className="tree-toggle tree-group" aria-label={`Toggle ${label}`} aria-expanded={expanded(kind)} onClick={() => toggle(kind)}><span aria-hidden="true" className={expanded(kind) ? 'chevron expanded' : 'chevron'} />{`${label} (${list.length})`}</button>
            {expanded(kind) && <>{matches.map((object) => <div key={object.name} className="table-node"><button aria-label={`Open ${kind} ${object.name}`} aria-pressed={vm.tab?.objectName === object.name} disabled={vm.busy || vm.tabs.length >= 8 && !vm.tabs.some((tab) => tab.objectName === object.name)} onClick={() => vm.addTab(object.name)}><span aria-hidden="true" className={`object-icon ${kind}`} />{object.name}</button></div>)}{!matches.length && <small>{list.length ? 'No matching objects' : `No ${label.toLowerCase()}`}</small>}</>}
          </div>;
        })}
      </>}
    </div>}
  </div>;
}
function Structure({ vm }: { vm: Model }) {
  const object = vm.schema?.tables.find((item) => item.name === vm.tab?.objectName);
  if (!object) return <p className="empty-results">Structure unavailable</p>;
  return <section className="structure" aria-label={`Structure of ${object.name}`}>
    <div className="results-heading"><strong>{`${vm.connectionName} / main / ${object.name}`}</strong><span>SQLite / Read-only structure</span></div>
    <div className="results-heading"><strong>Columns</strong><span>{`${object.columns.length} columns / ${object.kind ?? 'table'}`}</span></div>
    <div className="table-scroll"><table><thead><tr><th>#</th><th>Column</th><th>Type</th><th>Nullable</th><th>Primary Key</th></tr></thead><tbody>{object.columns.map((c, i) => <tr key={c.name}><td className="row-index">{i + 1}</td><td>{c.name}</td><td className="column-type">{c.type}</td><td>{c.nullable === undefined ? 'Unknown' : c.nullable ? 'Yes' : 'No'}</td><td>{c.primaryKey ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div>
    <div className="result-status">{object.kind === 'view' ? 'View nullability is not inferred.' : 'Column metadata from the connected SQLite schema.'} Schema editing is unavailable.</div>
  </section>;
}
function Workbench({ context }: { context: PluginContext }) {
  const vm = useWorkbench(context); const [connectionFilter, setConnectionFilter] = useState(''); const [connectionPage, setConnectionPage] = useState(0);
  const matches = vm.saved.filter((c) => c.name.toLowerCase().includes(connectionFilter.toLowerCase()));
  const page = Math.min(connectionPage, Math.max(0, Math.ceil(matches.length / 20) - 1)); const [draft, setDraft] = useState(''); const [showAI, setShowAI] = useState(false);
  const result = vm.tab?.result;
  const icon = `asset:assets/icons/sqlite-${vm.theme === 'light' ? 'light' : 'dark'}.svg`;
  return <main className="database-workbench">
    <header className="app-toolbar"><strong className="brand"><img src={icon} alt="" width="20" height="20" />Database</strong><button className="toolbar-button" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}>+ New Connection</button><button className="toolbar-button" disabled={!vm.session || vm.busy || vm.tabs.length >= 8} onClick={() => vm.addTab()}>+ New Query</button><span className="experimental">EXPERIMENTAL</span></header>
    <div className="shell"><aside className="connection-sidebar"><div className="sidebar-heading"><strong>Connections</strong><span>{vm.saved.length}</span></div><p className="sidebar-status">Active connections: {vm.session ? 1 : 0}</p>
      <label className="connection-filter"><input placeholder="Filter connections..." aria-label="Filter connections" value={connectionFilter} maxLength={128} onChange={(e) => { setConnectionFilter(e.currentTarget.value); setConnectionPage(0); }} /></label><div className="connection-list">{vm.saved.length ? matches.slice(page * 20, (page + 1) * 20).map((c) => <div key={c.id} className={`saved-connection ${vm.connectedId === c.id ? 'selected' : ''}`}><button className="connection-name" disabled={vm.busy || vm.connectedId === c.id} onClick={() => void vm.open(c)}><span className={`color-dot color-${c.color}`} /><span>{c.name}</span></button><button className="delete-connection" aria-label={`Delete ${c.name}`} disabled={vm.busy} onClick={() => void vm.remove(c.id)}>x</button></div>) : <p className="empty-sidebar">No connections yet</p>}</div>
      {vm.session && <SchemaTree key={vm.session.handleId} vm={vm} />}
      <div className="sidebar-footer">{matches.length > 20 && <div className="connection-pages"><button className="secondary" aria-label="Previous connections" disabled={page === 0} onClick={() => setConnectionPage(page - 1)}>Previous</button><span>{page + 1} / {Math.ceil(matches.length / 20)}</span><button className="secondary" aria-label="Next connections" disabled={(page + 1) * 20 >= matches.length} onClick={() => setConnectionPage(page + 1)}>Next</button></div>}SQLite fixtures only{vm.session && <><span>{'readOnly' in vm.session ? 'Read-only file' : 'Disposable memory'}</span><button className="secondary" disabled={vm.busy} onClick={() => void vm.disconnect()}>Close connection</button></>}</div>
    </aside><section className="workspace">
      {!vm.session ? <div className="home"><div className="home-metrics"><div><span>Connections</span><strong>{vm.saved.length}</strong></div><div><span>Connected</span><strong>0</strong></div><div><span>Database Types</span><strong>{vm.saved.length ? 1 : 0}</strong></div></div><h2>Quick Start</h2><div className="home-welcome"><img src={icon} alt="SQLite" width="40" height="40" /><h1>{vm.saved.length ? 'Your connections, ready to reopen' : 'No connections yet'}</h1><p>{vm.saved.length ? 'Select a saved connection on the left. The host validates its target again.' : 'Create a connection to explore disposable SQLite data.'}</p><button disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}>New Connection</button></div><h2>Shortcuts</h2><div className="shortcut-row"><button className="shortcut" disabled={!vm.enabled || vm.busy} onClick={() => vm.setModal('picker')}>+ New Connection<small>SQLite / local fixtures</small></button><button className="shortcut" disabled>History<small>Not available in this milestone</small></button></div><p className="hint">{!vm.enabled ? 'The host SQLite experiment is disabled or unavailable.' : !vm.persistence ? 'This host does not support saved connections. Temporary connections remain available.' : 'Saved connections contain metadata only. Memory contents are never persisted.'}</p></div> : <>
        <nav className="tab-strip" aria-label="Workspace tabs">{vm.tabs.map((tab) => <div key={tab.id} className={vm.activeTab === tab.id ? 'workspace-tab active' : 'workspace-tab'}><button aria-pressed={vm.activeTab === tab.id} onClick={() => vm.setActiveTab(tab.id)}>{tab.title}</button><button aria-label={`Close ${tab.title}`} disabled={vm.busy} onClick={() => vm.closeTab(tab.id)}>x</button></div>)}</nav>
        {vm.tab?.objectName && <nav className="object-tabs" aria-label="Object surface"><button className={vm.tab.surface === 'structure' ? 'active' : ''} aria-pressed={vm.tab.surface === 'structure'} onClick={() => vm.edit({ surface: 'structure' })}>Structure</button><button className={vm.tab.surface === 'data' ? 'active' : ''} aria-pressed={vm.tab.surface === 'data'} onClick={() => vm.edit({ surface: 'data' })}>Data</button></nav>}
        {vm.tab?.surface === 'structure' ? <Structure vm={vm} /> : vm.tab ? <><section className={vm.tab.objectName ? "editor object-editor" : "editor"}><div className="query-toolbar"><button disabled={vm.busy} onClick={() => void vm.run('read')}>Run read query</button><button className="secondary" disabled={vm.busy || 'readOnly' in vm.session} onClick={() => void vm.run('write')}>Review write...</button><button className="secondary" onClick={() => void vm.disconnect(true)}>Cancel / close</button><span>{vm.connectionName} / main</span></div><label className="sql-label">SQL editor<textarea aria-label="SQL statement" value={vm.tab.sql} maxLength={8192} disabled={vm.busy} onChange={(e) => vm.edit({ sql: e.currentTarget.value })} /></label><label className="parameters">Parameters<input aria-label="SQL parameters" value={vm.tab.parameters} maxLength={8192} disabled={vm.busy} onChange={(e) => vm.edit({ parameters: e.currentTarget.value })} /></label></section>
        <section className="results"><div className="results-heading"><strong>{vm.tab.objectName ? 'Table Data' : 'Results'}</strong><span>Preview: 20 rows / 8 columns / 256 chars per cell</span></div>{result?.columns.length ? <div className="table-scroll"><table><thead><tr><th>#</th>{result.columns.slice(0, 8).map((col, i) => <th key={i}>{col}</th>)}</tr></thead><tbody>{result.rows.slice(0, 20).map((row, i) => <tr key={i}><td className="row-index">{i + 1}</td>{row.slice(0, 8).map((cell, j) => <td key={j} className={cell === null ? "null-cell" : undefined}>{cell === null ? 'NULL' : String(cell).length > 256 ? String(cell).slice(0, 256) + '...' : String(cell)}</td>)}</tr>)}</tbody></table></div> : <div className="empty-results">{result ? 'Statement completed. No result rows.' : 'Run a query to view results.'}</div>}<div className="result-status" role="status">{vm.busy ? 'Waiting for host...' : result ? `${result.rows.length} rows / ${result.columns.length} columns / ${result.elapsedMs} ms / ${result.changes} changes${result.truncated ? ' / truncated' : ''}` : 'Nothing executed'}</div></section></> : <div className="empty-results">Open a table or create a new query.</div>}
        <section className="ai-secondary"><button className="toolbar-button" onClick={() => setShowAI(!showAI)}>AI SQL assistant / mock only</button>{showAI && <div><p>No provider is called. This local example is an unexecuted draft.</p><button className="secondary" onClick={() => setDraft(defaultQuery(vm.schema).sql)}>Create mock draft</button><pre aria-label="Unexecuted AI draft">{draft || 'No draft generated.'}</pre></div>}</section>
      </>}
      {vm.error && !vm.modal && <p className="error" role="alert">{vm.error}</p>}
    </section></div><footer className="app-status">{vm.session ? vm.connectionName : 'No database connected'}<span>Netcatty host permissions / SQLite fixture service</span></footer>
    {vm.modal && <ConnectionDialog vm={vm} />}
  </main>;
}
export default definePlugin({ activate(context) { context.subscriptions.add(registerHostReactView(context.views, 'com.binaricat.netcatty-database.workbench', () => <Workbench context={context} />, css)); } });
