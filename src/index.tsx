import React, { useEffect, useRef, useState } from 'react';
import { definePlugin, type PluginContext, type DatabaseOpenResult, type DatabaseFileOpenResult, type DatabaseHandleRequest, type DatabaseQueryResult, type DatabaseSchemaResult } from '@netcatty/plugin-sdk';
import { registerHostReactView } from '@netcatty/plugin-sdk/host-react';
import { DATABASE_FEATURE, DraftStream, buildPrompt, parseParameters, tasks, type Task } from './domain';
import css from './style.css';
function Workbench({ context }: { context: PluginContext }) {
  const [session, setSession] = useState<DatabaseOpenResult | DatabaseFileOpenResult | null>(null);
  const [schema, setSchema] = useState<DatabaseSchemaResult | null>(null);
  const [sql, setSql] = useState('SELECT id, title, status FROM notes WHERE status = ? ORDER BY id');
  const [parameters, setParameters] = useState('["open"]');
  const [result, setResult] = useState<DatabaseQueryResult | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [task, setTask] = useState<Task>('generate'); const [request, setRequest] = useState('');
  const [share, setShare] = useState(false); const [draft, setDraft] = useState(''); const [aiBusy, setAiBusy] = useState(false);
  const [theme, setTheme] = useState(context.environment.theme);
  const handle = useRef<DatabaseHandleRequest | null>(null); const revision = useRef(0); const ai = useRef(new DraftStream(context.ai));
  useEffect(() => {
    const sub = context.environment.onDidChange(() => setTheme(context.environment.theme));
    return () => { revision.current++; sub.dispose(); void ai.current.stop(); if (handle.current) void context.database.close(handle.current).catch(() => {}); };
  }, [context]);
  const enabled = context.enabledFeatures.has(DATABASE_FEATURE);
  const reset = async () => {
    revision.current++; const id = handle.current; handle.current = null;
    setSession(null); setSchema(null); setResult(null); setShare(false); setDraft(''); setBusy(false); setAiBusy(false); await ai.current.stop();
    if (id) await context.database.close(id).catch(() => {});
  };
  const connect = async (file = false) => {
    setBusy(true); setError(''); const rev = revision.current;
    try {
      const opened = file ? await context.database.openSqliteFile({}) : await context.database.openFixture({});
      if (!opened) return;
      const target = { handleId: opened.handleId, ...("revision" in opened ? { revision: opened.revision } : {}) };
      if (rev !== revision.current) { await context.database.close(target); return; }
      handle.current = target; setSession(opened);
      const inspected = await context.database.readSchema(target);
      if (rev === revision.current) setSchema(inspected);
    } catch (e) { if (rev === revision.current) { setError(e instanceof Error ? e.message : 'Database connection failed'); await reset(); } }
    finally { if (rev === revision.current) setBusy(false); }
  };
  const run = async (mode: 'read' | 'write') => {
    if (!session || !handle.current || busy) return; const rev = revision.current; setBusy(true); setError(''); setResult(null);
    try { const value = await context.database.query({ ...handle.current, sql, parameters: parseParameters(parameters), mode, maxRows: 100, timeoutMs: 3000 }); if (rev === revision.current) setResult(value); }
    catch (e) { if (rev === revision.current) setError(e instanceof Error ? e.message : 'Query failed'); }
    finally { if (rev === revision.current) setBusy(false); }
  };
  const ask = async () => {
    if (!share || !schema || aiBusy) return; setAiBusy(true); setDraft(''); setError(''); const rev = revision.current;
    try { await ai.current.run(buildPrompt(task, schema, sql, request), (text) => { if (rev === revision.current) setDraft(text); }); }
    catch (e) { if (rev === revision.current) setError(e instanceof Error ? e.message : 'Host AI unavailable'); }
    finally { if (rev === revision.current) setAiBusy(false); }
  };
  const icon = (engine: string) => `asset:assets/icons/${engine}-${theme === 'light' ? 'light' : 'dark'}.svg`;
  return <main className="database-workbench">
    <header><div><p className="eyebrow">NETCATTY / DATABASE LAB</p><h1>Database workbench</h1><p>Explore a disposable SQLite database. Keep execution and AI drafts under your control.</p></div><span className="badge">M2 · EXPERIMENTAL</span></header>
    <div className="layout"><aside>
      <h2>Connections</h2><section className="engine selected"><img src={icon('sqlite')} alt="SQLite" width="28" height="28"/><div><strong>SQLite</strong><small>Disposable fixtures only</small></div></section>
      {['postgresql', 'mysql'].map((engine) => <section className="engine unavailable" key={engine}><img src={icon(engine)} alt={engine} width="28" height="28"/><div><strong>{engine === 'postgresql' ? 'PostgreSQL' : 'MySQL'}</strong><small>Driver not implemented</small></div></section>)}
      <p className="hint">File chooser accepts only host-approved disposable fixtures. User databases and remote connections remain unavailable.</p>
      <h2>Schema</h2>{schema ? schema.tables.map((table) => <div className="schema" key={table.name}><strong>{table.name}</strong>{table.columns.map((column) => <small key={column.name}>{column.primaryKey ? 'PK · ' : ''}{column.name}<span>{column.type}</span></small>)}</div>) : <p className="hint">Connect to inspect actual schema.</p>}
    </aside><section className="workspace">
      <section className="connection"><div><strong>{session ? `Connected · ${session.label}` : 'No database connected'}</strong><p>{enabled ? 'readOnly' in (session ?? {}) ? 'Read-only file fixture. Writes are unavailable.' : 'Memory changes are discarded on close. File fixtures open read-only.' : 'Host SQLite experiment is disabled or unavailable. No query will execute.'}</p></div>{session ? <button disabled={busy} onClick={() => void reset()}>Close fixture</button> : <div className="actions"><button disabled={!enabled || busy} onClick={() => void connect()}>Open synthetic SQLite</button><button disabled={!enabled || busy || !context.enabledFeatures.has('database.sqlite-file-fixture.v1')} onClick={() => void connect(true)}>Open SQLite file…</button></div>}</section>
      <section className="editor"><div className="section-title"><h2>SQL editor</h2><span>SQLite · positional parameters · one statement</span></div><label>Statement<textarea aria-label="SQL statement" value={sql} maxLength={8192} onChange={(e) => setSql(e.currentTarget.value)} /></label>
        <label>Bound parameters (JSON array)<input aria-label="SQL parameters" value={parameters} maxLength={8192} onChange={(e) => setParameters(e.currentTarget.value)} /></label>
        <div className="actions"><button disabled={!session || busy} onClick={() => void run('read')}>Run read query</button><button className="secondary" disabled={!session || busy || 'readOnly' in session} onClick={() => void run('write')}>Review write…</button><button className="secondary" disabled={!session} onClick={() => void reset()}>Cancel / close fixture</button><small>100 rows · 96 KiB · 3 seconds</small></div>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="results"><div className="section-title"><h2>Results</h2><span role="status">{busy ? 'Waiting for host…' : result ? `${result.rows.length} rows · ${result.changes} changes · ${result.elapsedMs} ms${result.truncated ? ' · truncated preview' : ''}` : 'Nothing executed'}</span></div>
        {result?.columns.length ? <div className="table-scroll"><table><thead><tr>{result.columns.slice(0, 8).map((col, i) => <th key={i}>{col}</th>)}</tr></thead><tbody>{result.rows.slice(0, 20).map((row, i) => <tr key={i}>{row.slice(0, 8).map((cell, j) => <td key={j}>{cell === null ? 'NULL' : String(cell)}</td>)}</tr>)}</tbody></table><p className="hint">Table preview: up to 20 rows and 8 columns.</p></div> : <p className="hint">{result ? 'Statement completed. No result rows.' : 'Run an explicit query to see real SQLite results here.'}</p>}
      </section>
      <section className="ai"><div className="section-title"><h2>AI SQL assistant</h2><span>Host model · text only</span></div>
        <label>Task<select aria-label="AI SQL task" value={task} onChange={(e) => setTask(e.currentTarget.value as Task)}>{tasks.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
        <label>Request<textarea aria-label="AI SQL request" rows={2} maxLength={1500} value={request} onChange={(e) => setRequest(e.currentTarget.value)} placeholder="Describe the query, explanation or correction you need" /></label>
        <label className="check"><input type="checkbox" checked={share} disabled={!schema} onChange={(e) => setShare(e.currentTarget.checked)} />Share the inspected notes schema, SQL and request with the configured host model. No result rows.</label>
        <div className="actions"><button disabled={!schema || !share || aiBusy || !context.enabledFeatures.has('ai.model-invocation')} onClick={() => void ask()}>Create AI draft</button><button className="secondary" disabled={!aiBusy} onClick={() => { void ai.current.stop(); setAiBusy(false); }}>Stop AI</button></div>
        <p className="hint">{context.enabledFeatures.has('ai.model-invocation') ? 'Requires a configured host model and AI permission. Generated SQL is never executed automatically.' : 'Host AI streaming is unavailable.'}</p>
        <h3>Unexecuted AI draft</h3><pre aria-label="Unexecuted AI draft">{draft ? draft.match(/[\s\S]{1,4096}/g)?.map((chunk, i) => <span key={i}>{chunk}</span>) : 'No draft generated.'}</pre>
      </section>
    </section></div>
  </main>;
}
export default definePlugin({ activate(context) { context.subscriptions.add(registerHostReactView(context.views, 'com.binaricat.netcatty-database.workbench', () => <Workbench context={context} />, css)); } });
