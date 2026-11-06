import { useEffect, useRef, useState } from 'react';
import type { PluginContext, DatabaseOpenResult, DatabaseFileOpenResult, DatabaseHandleRequest, DatabaseSchemaResult, DatabaseSavedConnection, DatabaseHostList, DatabaseConnectionMeta, DatabaseQueryResult } from '@netcatty/plugin-sdk';
import { parseParameters, DATABASE_FEATURE } from './domain';
export const SAVED_FEATURE = 'database.saved-connections.v1';
type Session = DatabaseOpenResult | DatabaseFileOpenResult;
export type QueryTab = { id: number; title: string; sql: string; parameters: string; result: DatabaseQueryResult | null };
const target = (s: Session): DatabaseHandleRequest => ({ handleId: s.handleId, ...('revision' in s ? { revision: s.revision } : {}) });
const initialTab = (id: number): QueryTab => ({ id, title: `Query ${id}`, sql: 'SELECT id, title, status FROM notes WHERE status = ? ORDER BY id', parameters: '["open"]', result: null });
export function useWorkbench(context: PluginContext) {
  const [saved, setSaved] = useState<DatabaseSavedConnection[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [connectionName, setConnectionName] = useState('');
  const [connectedId, setConnectedId] = useState('');
  const [schema, setSchema] = useState<DatabaseSchemaResult | null>(null);
  const [tabs, setTabs] = useState<QueryTab[]>([]); const [activeTab, setActiveTab] = useState(1);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [modal, setModal] = useState<'picker' | 'connection' | null>(null);
  const [draftSession, setDraftSession] = useState<Session | null>(null);
  const [tested, setTested] = useState(false); const [hosts, setHosts] = useState<DatabaseHostList>([]);
  const [theme, setTheme] = useState(context.environment.theme);
  const live = useRef<Session | null>(null); const draft = useRef<Session | null>(null);
  const epoch = useRef(0); const locked = useRef(false); const nextTab = useRef(1);
  const enabled = context.enabledFeatures.has(DATABASE_FEATURE);
  const persistence = enabled && context.enabledFeatures.has(SAVED_FEATURE);
  const fileEnabled = enabled && context.enabledFeatures.has('database.sqlite-file-fixture.v1');
  const close = async (s: Session | null, cancel = false) => { if (s) await context.database[cancel ? 'cancel' : 'close'](target(s)).catch(() => {}); };
  useEffect(() => {
    let mounted = true;
    const sub = context.environment.onDidChange(() => setTheme(context.environment.theme));
    if (persistence) void context.database.listSavedConnections({}).then((list) => { if (mounted) setSaved(list); }).catch(() => { if (mounted) setError('Saved connections could not be loaded. Check host permission.'); });
    return () => { mounted = false; epoch.current++; sub.dispose(); void close(live.current); void close(draft.current); };
    // Context is stable for the lifetime of a host view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, persistence]);
  const action = async (work: (rev: number) => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); const rev = epoch.current;
    try { await work(rev); }
    catch (e) { if (rev === epoch.current) setError(e instanceof Error ? e.message : 'Host operation failed'); }
    finally { if (rev === epoch.current) { locked.current = false; setBusy(false); } }
  };
  const dismiss = async () => {
    epoch.current++; locked.current = false; setBusy(false); setModal(null); setTested(false);
    const s = draft.current; draft.current = null; setDraftSession(null); await close(s);
  };
  const disconnect = async (cancel = false) => {
    epoch.current++; locked.current = false; setBusy(false);
    const s = live.current; live.current = null; setSession(null); setSchema(null); setTabs([]); setConnectedId('');
    await close(s, cancel);
  };
  const acquire = async (file: boolean, rev: number) => {
    const opened = await (file ? context.database.openSqliteFile({}) : context.database.openFixture({}));
    if (!opened) return null;
    if (rev !== epoch.current) { await close(opened); return null; }
    draft.current = opened; setDraftSession(opened); return opened;
  };
  const selectSource = (file: boolean) => action(async (rev) => {
    const old = draft.current; draft.current = null; setDraftSession(null); setTested(false); await close(old);
    if (rev === epoch.current && file) await acquire(true, rev);
  });
  const test = () => action(async (rev) => {
    const s = draft.current ?? await acquire(false, rev); if (!s) return;
    try { await context.database.readSchema(target(s)); if (rev === epoch.current) setTested(true); }
    catch (e) { if (rev === epoch.current) { draft.current = null; setDraftSession(null); setTested(false); } await close(s); throw e; }
  });
  const attach = async (s: Session, name: string, id: string, rev: number) => {
    try {
      const inspected = await context.database.readSchema(target(s));
      if (rev !== epoch.current) { await close(s); return; }
      await close(live.current);
      if (rev !== epoch.current) { await close(s); return; }
      live.current = s; setSession(s); setSchema(inspected); setConnectionName(name); setConnectedId(id);
      nextTab.current = 2; setTabs([initialTab(1)]); setActiveTab(1); setModal(null);
      if (draft.current === s) { draft.current = null; setDraftSession(null); }
    } catch (e) { await close(s); if (draft.current === s) { draft.current = null; setDraftSession(null); setTested(false); } throw e; }
  };
  const save = (meta: DatabaseConnectionMeta, password?: string) => action(async (rev) => {
    const s = draft.current ?? await acquire(false, rev); if (!s) return;
    const connection = await context.database.saveConnection({ ...target(s), meta, ...(password ? { secret: { kind: 'password', value: password } } : {}) });
    if (rev !== epoch.current) { await close(s); return; }
    setSaved((items) => [...items, connection]); await attach(s, connection.name, connection.id, rev);
  });
  const open = (connection: DatabaseSavedConnection) => action(async (rev) => {
    const s = await context.database.openSavedConnection({ id: connection.id });
    if (rev !== epoch.current) { await close(s); return; }
    await attach(s, connection.name, connection.id, rev);
  });
  const openUnsaved = () => action(async (rev) => {
    const s = draft.current ?? await acquire(false, rev); if (s) await attach(s, 'Disposable SQLite', '', rev);
  });
  const remove = (id: string) => action(async (rev) => {
    await context.database.deleteConnection({ id });
    if (rev === epoch.current) setSaved((items) => items.filter((item) => item.id !== id));
  });
  const loadHosts = () => action(async (rev) => { const list = await context.database.listHostsForDatabase({}); if (rev === epoch.current) setHosts(list); });
  const tab = tabs.find((item) => item.id === activeTab);
  const edit = (patch: Partial<QueryTab>) => setTabs((items) => items.map((item) => item.id === activeTab ? { ...item, ...patch } : item));
  const addTab = (table?: string) => {
    if (tabs.length >= 8) return;
    const id = nextTab.current++; const item = initialTab(id);
    if (table) { item.title = `Data: ${table}`; item.sql = `SELECT * FROM "${table.replaceAll('"', '""')}"`; item.parameters = '[]'; }
    setTabs((items) => [...items, item]); setActiveTab(id);
  };
  const closeTab = (id: number) => { const remaining = tabs.filter((t) => t.id !== id); setTabs(remaining); if (id === activeTab) setActiveTab(remaining[0]?.id ?? 0); };
  const run = (mode: 'read' | 'write') => action(async (rev) => {
    if (!live.current || !tab) return; const id = tab.id;
    edit({ result: null });
    const value = await context.database.query({ ...target(live.current), sql: tab.sql, parameters: parseParameters(tab.parameters), mode, maxRows: 100, timeoutMs: 3000 });
    if (rev === epoch.current) setTabs((items) => items.map((item) => item.id === id ? { ...item, result: value } : item));
  });
  return { saved, session, connectedId, connectionName, schema, tabs, tab, activeTab, setActiveTab, addTab, closeTab, edit, busy, error, modal, setModal, draftSession, tested, hosts, theme, enabled, persistence, fileEnabled, dismiss, disconnect, selectSource, test, save, open, openUnsaved, remove, loadHosts, run };
}
