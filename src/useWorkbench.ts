import { useEffect, useRef, useState } from 'react';
import type { PluginContext, DatabaseOpenResult, DatabaseFileOpenResult, DatabaseHandleRequest, DatabaseSchemaResult, DatabaseSavedConnection, DatabaseHostList, DatabaseConnectionMeta, DatabaseQueryResult } from '@netcatty/plugin-sdk';
import { parseParameters, ParameterError, DATABASE_FEATURE, defaultQuery, selectObject } from './domain';
import { useHostPortProbe } from './useHostPortProbe';
import { useHostLiveSshPg } from './useHostLiveSshPg';
import { useTunnelTest } from './useTunnelTest';
import { translator, type Message } from './i18n';
export const SAVED_FEATURE = 'database.saved-connections.v1';
type Session = DatabaseOpenResult | DatabaseFileOpenResult;
export type QueryTab = { id: number; sql: string; parameters: string; result: DatabaseQueryResult | null; resultSql?: string; objectName?: string; surface?: 'data' | 'structure' };
const target = (s: Session): DatabaseHandleRequest => ({ handleId: s.handleId, ...('revision' in s ? { revision: s.revision } : {}) });
const initialTab = (id: number, schema: DatabaseSchemaResult | null): QueryTab => ({ id, ...defaultQuery(schema), result: null });
export function useWorkbench(context: PluginContext) {
  const liveSshPg = useHostLiveSshPg(context);
  const tunnel = useTunnelTest(context);
  const portProbe = useHostPortProbe(context);
  const [saved, setSaved] = useState<DatabaseSavedConnection[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [connectionName, setConnectionName] = useState('');
  const [connectedId, setConnectedId] = useState('');
  const [schema, setSchema] = useState<DatabaseSchemaResult | null>(null);
  const [tabs, setTabs] = useState<QueryTab[]>([]); const [activeTab, setActiveTab] = useState(1);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ key: Message; diagnostic?: string } | null>(null);
  const [modal, setModal] = useState<'picker' | 'connection' | null>(null);
  const [draftSession, setDraftSession] = useState<Session | null>(null);
  const [tested, setTested] = useState(false); const [hosts, setHosts] = useState<DatabaseHostList>([]);
  const [theme, setTheme] = useState(context.environment.theme);
  const [locale, setLocale] = useState(context.environment.locale);
  const t = translator(locale);
  const error = !failure ? '' : failure.diagnostic
    ? (locale === 'zh-CN' ? `${t(failure.key)}。${t('Host diagnostic: {message}', { message: failure.diagnostic })}` : failure.diagnostic)
    : t(failure.key);
  const tabTitle = (item: QueryTab) => item.objectName ?? t('Query {id}', { id: item.id });
  const live = useRef<Session | null>(null); const draft = useRef<Session | null>(null);
  const epoch = useRef(0); const locked = useRef(false); const nextTab = useRef(1);
  const enabled = context.enabledFeatures.has(DATABASE_FEATURE);
  const persistence = enabled && context.enabledFeatures.has(SAVED_FEATURE);
  const walEnabled = enabled && context.enabledFeatures.has('database.sqlite-wal-readonly.fixture.v1');
  const fileEnabled = enabled && context.enabledFeatures.has('database.sqlite-file-fixture.v1');
  const close = async (s: Session | null, cancel = false) => { if (s) await context.database[cancel ? 'cancel' : 'close'](target(s)).catch(() => {}); };
  useEffect(() => {
    let mounted = true;
    const sub = context.environment.onDidChange(() => { setTheme(context.environment.theme); setLocale(context.environment.locale); });
    if (persistence) void context.database.listSavedConnections({}).then((list) => { if (mounted) setSaved(list); }).catch(() => { if (mounted) setFailure({ key: 'Saved connections could not be loaded. Check host permission.' }); });
    return () => { mounted = false; epoch.current++; sub.dispose(); void close(live.current); void close(draft.current); };
    // Context is stable for the lifetime of a host view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, persistence]);
  const action = async (work: (rev: number) => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setFailure(null); const rev = epoch.current;
    try { await work(rev); }
    catch (e) { if (rev === epoch.current) setFailure(e instanceof ParameterError ? { key: e.messageKey } : { key: 'Host operation failed', ...(e instanceof Error ? { diagnostic: e.message } : {}) }); }
    finally { if (rev === epoch.current) { locked.current = false; setBusy(false); } }
  };
  const dismiss = async () => {
    tunnel.reset(); portProbe.reset(); liveSshPg.reset();
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
      tunnel.reset(); portProbe.reset(); liveSshPg.reset(); live.current = s; setSession(s); setSchema(inspected); setConnectionName(name); setConnectedId(id);
      nextTab.current = 2; setTabs([initialTab(1, inspected)]); setActiveTab(1); setModal(null);
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
  const loadHosts = () => action(async (rev) => { tunnel.reset(); portProbe.reset(); liveSshPg.reset(); const list = await context.database.listHostsForDatabase({}); if (rev === epoch.current) setHosts(list); });
  const tab = tabs.find((item) => item.id === activeTab);
  const edit = (patch: Partial<QueryTab>) => setTabs((items) => items.map((item) => item.id === activeTab ? { ...item, ...patch } : item));
  const addTab = (table?: string) => {
    const existing = table && tabs.find((item) => item.objectName === table);
    if (existing) { setActiveTab(existing.id); return; }
    if (tabs.length >= 8) return;
    const id = nextTab.current++; const item = initialTab(id, schema);
    if (table) { item.objectName = table; item.surface = 'structure'; item.sql = selectObject(table); item.parameters = '[]'; }
    setTabs((items) => [...items, item]); setActiveTab(id);
  };
  const closeTab = (id: number) => { const remaining = tabs.filter((t) => t.id !== id); setTabs(remaining); if (id === activeTab) setActiveTab(remaining[0]?.id ?? 0); };
  const run = (mode: 'read' | 'write') => action(async (rev) => {
    if (!live.current || !tab) return; const id = tab.id;
    edit({ result: null });
    const value = await context.database.query({ ...target(live.current), sql: tab.sql, parameters: parseParameters(tab.parameters), mode, maxRows: 100, timeoutMs: 3000 });
    if (rev === epoch.current) setTabs((items) => items.map((item) => item.id === id ? { ...item, result: value, resultSql: tab.sql } : item));
  });
  return { liveSshPg, portProbe, tunnel, t, locale, tabTitle, saved, session, connectedId, connectionName: session && !connectedId ? t('Disposable SQLite') : connectionName, schema, tabs, tab, activeTab, setActiveTab, addTab, closeTab, edit, busy, error, modal, setModal: (next: 'picker' | 'connection' | null) => { tunnel.reset(); portProbe.reset(); liveSshPg.reset(); setModal(next); }, draftSession, tested, hosts, theme, enabled, persistence, fileEnabled, walEnabled, dismiss, disconnect, selectSource, test, save, open, openUnsaved, remove, loadHosts, run };
}
