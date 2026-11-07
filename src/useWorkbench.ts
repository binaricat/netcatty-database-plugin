import {createSchemaBusyOwners} from './schemaBusy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginContext } from './databaseClient';
import type { DatabaseOpenResult, DatabaseFileOpenResult, DatabaseHandleRequest, DatabaseSchemaResult, DatabaseSavedConnection, DatabaseHostList, DatabaseConnectionMeta, DatabaseQueryResult } from './databaseTypes';
import { parseParameters, ParameterError, DATABASE_FEATURE, defaultQuery, selectObject } from './domain';
import { driverById, type DriverId } from './driverRegistry';
import type { DatabaseTcpOpenResult, DatabaseTcpOpenRequest } from './databaseTypes';
import { useHostPortProbe } from './useHostPortProbe';
import { useHostLiveSshPg } from './useHostLiveSshPg';
import { useTunnelTest } from './useTunnelTest';
import { translator, type Message } from './i18n';
import { emptyQueryLibrary, recordQuery, saveQuery, removeSavedQuery as removeLibraryQuery, clearQueryHistory, type SavedQuery } from './queryLibrary';
import {createEditorDraftStorage, type DraftSnapshot, type DraftStorageOutcome} from './editorDraftStorage';
export const SAVED_FEATURE = 'database.saved-connections.v1';
type Session = DatabaseOpenResult | DatabaseFileOpenResult | DatabaseTcpOpenResult;
export type QueryTab = { id: number; sql: string; parameters: string; result: DatabaseQueryResult | null; resultSql?: string; objectName?: string; surface?: 'data' | 'structure' };
const target = (s: Session): DatabaseHandleRequest => ({ handleId: s.handleId, ...('revision' in s ? { revision: s.revision } : {}) });
const initialTab = (id: number, schema: DatabaseSchemaResult | null, engine = 'sqlite'): QueryTab => ({ id, ...defaultQuery(schema, engine), result: null });
export type ReviewedWrite = { handleId: string; tabId: number; sql: string; parameters: string; connectionName: string };
export function matchesReviewedWrite(review: ReviewedWrite, handleId: string | undefined, tab: QueryTab | undefined): boolean {
  return Boolean(tab && review.handleId === handleId && review.tabId === tab.id && review.sql === tab.sql && review.parameters === tab.parameters);
}
export function useWorkbench(context: PluginContext) {
  const liveSshPg = useHostLiveSshPg(context);
  const tunnel = useTunnelTest(context);
  const portProbe = useHostPortProbe(context);
  const [driverId, setDriverId] = useState<DriverId>('sqlite');
  const selectedDriver = driverById(driverId);
  const tcpEnabled = context.database.capabilities.has('database.tcp.v1');
  const [saved, setSaved] = useState<DatabaseSavedConnection[]>([]);
  // Deliberately view-local: query text and bound values are never written to storage.
  const [queryLibrary, setQueryLibrary] = useState(emptyQueryLibrary);
  const [session, setSession] = useState<Session | null>(null);
  const [connectionName, setConnectionName] = useState('');
  const [connectedId, setConnectedId] = useState('');
  const [schema, setSchema] = useState<DatabaseSchemaResult | null>(null);
  const [tabs, setTabs] = useState<QueryTab[]>([]); const [activeTab, updateActiveTab] = useState(1);
  const schemaApplyingRef=useRef(false);const [schemaApplying,updateSchemaApplying]=useState(false);
  const schemaBusyOwners=useRef<ReturnType<typeof createSchemaBusyOwners> | null>(null);
  if(!schemaBusyOwners.current)schemaBusyOwners.current=createSchemaBusyOwners(value=>{schemaApplyingRef.current=value;updateSchemaApplying(value);});
  const setSchemaApplying=useCallback((value:boolean,owner?:symbol)=>{schemaBusyOwners.current!.set(value,owner);},[]);
  const editorRevision = useRef(0);
  const [draftStorageBusy,setDraftStorageBusy]=useState(false);
  const draftStorageRunning=useRef(false);
  const [draftStorageNotice,setDraftStorageNotice]=useState<DraftStorageOutcome|null>(null);
  const [pendingWrite, setPendingWrite] = useState<ReviewedWrite | null>(null);
  const reviewed = useRef<ReviewedWrite | null>(null);
  const invalidateWrite = () => { reviewed.current = null; setPendingWrite(null); };
  const setActiveTab = (id: number) => {if(schemaApplyingRef.current)return; editorRevision.current++; invalidateWrite(); updateActiveTab(id); };
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
  const draftEdits = useRef(0);
  const live = useRef<Session | null>(null); const draft = useRef<Session | null>(null);
  const epoch = useRef(0); const locked = useRef(false); const nextTab = useRef(1);
  const enabled = context.database.capabilities.has(DATABASE_FEATURE);
  const persistence = enabled && context.database.capabilities.has(SAVED_FEATURE);
  const fileEnabled = enabled && context.database.capabilities.has('database.sqlite-file-fixture.v1');
  const walEnabled = fileEnabled && context.database.capabilities.has('database.sqlite-wal-readonly.fixture.v1');
  const walCheckpointEnabled = walEnabled && context.database.capabilities.has('database.sqlite-wal-concurrent.fixture.v1') && context.database.capabilities.has('database.sqlite-wal-checkpoint.fixture.v1');
  const walCaptureEnabled = walCheckpointEnabled && context.database.capabilities.has('database.sqlite-wal-capture.fixture.v1');
  const malformedRejectEnabled = walCaptureEnabled && context.database.capabilities.has('database.sqlite-fd-identity.fixture.v1') && context.database.capabilities.has('database.sqlite-malformed-reject.fixture.v1');
  const walRefreshEnabled = malformedRejectEnabled && context.database.capabilities.has('database.sqlite-wal-session-refresh.fixture.v1');
  const walConcurrentEnabled = walEnabled && context.database.capabilities.has('database.sqlite-wal-concurrent.fixture.v1');
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
    if (locked.current || schemaApplyingRef.current) return;
    locked.current = true; setBusy(true); setFailure(null); const rev = epoch.current;
    try { await work(rev); }
    catch (e) { if (rev === epoch.current) setFailure(e instanceof ParameterError ? { key: e.messageKey } : e instanceof Error && e.message === 'Driver not packaged' ? { key: 'Driver not packaged' } : { key: 'Host operation failed', ...(e instanceof Error ? { diagnostic: e.message } : {}) }); }
    finally { if (rev === epoch.current) { locked.current = false; setBusy(false); } }
  };
  const dismiss = async () => {
    invalidateWrite();
    tunnel.reset(); portProbe.reset(); liveSshPg.reset();
    epoch.current++; locked.current = false; setBusy(false); setModal(null); setTested(false);
    const s = draft.current; draft.current = null; setDraftSession(null); await close(s);
  };
  const disconnect = async (cancel = false) => {
    if(schemaApplyingRef.current)return;
    invalidateWrite();
    epoch.current++; locked.current = false; setBusy(false);
    const s = live.current; live.current = null; setSession(null); setSchema(null); setTabs([]); setConnectedId('');
    await close(s, cancel);
  };
  const refresh = () => {
    invalidateWrite();
    if (locked.current || schemaApplyingRef.current || !walRefreshEnabled || !live.current || !('revision' in live.current)) return;
    editorRevision.current++;
    epoch.current++;
    return action(async (rev) => {
      const old = live.current!; let fresh: DatabaseFileOpenResult | null = null;
      setSchema(null); setTabs((items) => items.map((item) => ({ ...item, result: null, resultSql: undefined })));
      try {
        fresh = await context.database.refreshSqliteFile(target(old));
        if (rev !== epoch.current) { await close(fresh); return; }
        live.current = fresh; setSession(fresh);
        const inspected = await context.database.readSchema(target(fresh));
        if (rev !== epoch.current) { await close(fresh); return; }
        setSchema(inspected);
      } catch (e) {
        await close(fresh ?? old);
        if (rev === epoch.current) { live.current = null; setSession(null); setSchema(null); setTabs([]); setConnectedId(''); }
        throw e;
      }
    });
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
    invalidateWrite();
    try {
      const inspected = await context.database.readSchema(target(s));
      if (rev !== epoch.current) { await close(s); return; }
      await close(live.current);
      if (rev !== epoch.current) { await close(s); return; }
      tunnel.reset(); portProbe.reset(); liveSshPg.reset(); live.current = s; setSession(s); setSchema(inspected); setConnectionName(name); setConnectedId(id);
      nextTab.current = 2; setTabs([initialTab(1, inspected, s.engine)]); setActiveTab(1); setModal(null);
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
    invalidateWrite();
    const s = await context.database.openSavedConnection({ id: connection.id });
    if (rev !== epoch.current) { await close(s); return; }
    await attach(s, connection.name, connection.id, rev);
  });
  const invalidateDraft = () => { draftEdits.current++; setTested(false); };
  const selectDriver = (id: DriverId) => action(async () => {
    const old = draft.current; draft.current = null; setDraftSession(null); setTested(false); setDriverId(id); await close(old);
  });
  const acquireTcp = async (request: DatabaseTcpOpenRequest, rev: number) => {
    const old = draft.current; draft.current = null; setDraftSession(null); setTested(false); await close(old);
    const s = await context.database.openTcp(request);
    if (rev !== epoch.current) { await close(s); return null; }
    draft.current = s; setDraftSession(s); return s;
  };
  const testTcp = (request: DatabaseTcpOpenRequest) => action(async (rev) => {
    const edits = draftEdits.current;
    const s = await acquireTcp(request, rev); if (!s) return;
    try { await context.database.readSchema(target(s)); if (rev === epoch.current && edits === draftEdits.current) setTested(true); }
    catch (error) { await close(s); if (draft.current === s) { draft.current = null; setDraftSession(null); } throw error; }
  });
  const connectTcp = (request: DatabaseTcpOpenRequest, name: string) => action(async (rev) => {
    const s = await acquireTcp(request, rev); if (s) await attach(s, name, '', rev);
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
  const edit = (patch: Partial<QueryTab>) => {if(schemaApplyingRef.current)return; editorRevision.current++; invalidateWrite(); setTabs((items) => items.map((item) => item.id === activeTab ? { ...item, ...patch } : item)); };
  const addTab = (table?: string) => {if(schemaApplyingRef.current)return;
    const existing = table && tabs.find((item) => item.objectName === table);
    if (existing) { setActiveTab(existing.id); return; }
    if (tabs.length >= 8) return;
    const id = nextTab.current++; const item = initialTab(id, schema, session?.engine);
    if (table) { item.objectName = table; item.surface = 'structure'; item.sql = selectObject(table, session?.engine); item.parameters = '[]'; }
    setTabs((items) => [...items, item]); setActiveTab(id);
  };
  const closeTab = (id: number) => {if(schemaApplyingRef.current)return; editorRevision.current++; invalidateWrite(); const remaining = tabs.filter((t) => t.id !== id); setTabs(remaining); if (id === activeTab) setActiveTab(remaining[0]?.id ?? 0); };
  const saveCurrentQuery = (name: string) => {
    if (locked.current || schemaApplyingRef.current || !tab) return;
    try {
      const next = saveQuery(queryLibrary, { name, sql: tab.sql, parameters: tab.parameters, time: Date.now() });
      setQueryLibrary(next); setFailure(null);
    } catch (e) { setFailure({ key: 'Host operation failed', ...(e instanceof Error ? { diagnostic: e.message } : {}) }); }
  };
  const removeSavedQuery = (id: string) => setQueryLibrary(items => removeLibraryQuery(items, id));
  const clearHistory = () => setQueryLibrary(clearQueryHistory);
  const loadQuery = (entry: Pick<SavedQuery, 'sql' | 'parameters'>) => {
    if (locked.current || schemaApplyingRef.current || !tab || !live.current) return;
    edit({ sql: entry.sql, parameters: entry.parameters, result: null, resultSql: undefined, objectName: undefined, surface: 'data' });
    setFailure(null);
  };
  const execute = (mode: 'read' | 'write', snapshot: QueryTab, write?: ReviewedWrite) => action(async (rev) => {
    if (!live.current) return;
    editorRevision.current++; // Invalidate any pending restore even if execution finishes before its review closes.
    if (mode === 'write' && (!write || !matchesReviewedWrite(write, live.current.handleId, snapshot))) return;
    const tab = snapshot; const id = tab.id;
    edit({ result: null, resultSql: undefined });
    // Invalid JSON is not a dispatched execution. Do not retain malformed input.
    const parameters = parseParameters(tab.parameters);
    const execution = { sql: tab.sql, parameters: tab.parameters, connectionName, time: Date.now() };
    let success = false;
    try {
      const value = await context.database.query({ ...target(live.current), sql: tab.sql, parameters, mode, ...(write ? {writeConfirmation: {handleId: write.handleId, sql: write.sql, parameters}} : {}), maxRows: 100, timeoutMs: 3000 });
      success = true;
      if (rev === epoch.current) {
        if (value.schema) setSchema(value.schema);
        setTabs((items) => items.map((item) => item.id === id ? { ...item, result: value, resultSql: tab.sql } : item));
      }
    } finally {
      if (rev === epoch.current) {
        // History is best-effort metadata and must not mask the execution outcome.
        setQueryLibrary(items => {
          try { return recordQuery(items, { ...execution, success }); } catch { return items; }
        });
      }
    }
  });
  const canReviewWrite = Boolean(session && 'supportsReviewedWrites' in session && session.supportsReviewedWrites === true && session.readOnly === false);
  const run = (mode: 'read' | 'write') => {
    if (locked.current || schemaApplyingRef.current || !tab || !live.current) return;
    if (mode === 'read') { invalidateWrite(); return execute('read', {...tab}); }
    if (!canReviewWrite) return;
    try { parseParameters(tab.parameters); }
    catch (error) { if (error instanceof ParameterError) setFailure({key:error.messageKey}); return; }
    const review = {handleId: live.current.handleId, tabId: tab.id, sql: tab.sql, parameters: tab.parameters, connectionName};
    reviewed.current = review; setPendingWrite(review); setFailure(null);
  };
  const confirmWrite = () => {
    const review = reviewed.current;
    if (locked.current || schemaApplyingRef.current || !canReviewWrite || !review || !matchesReviewedWrite(review, live.current?.handleId, tab)) { invalidateWrite(); return; }
    // Consume the exact user-reviewed snapshot once, before any asynchronous work.
    invalidateWrite();
    return execute('write', {...tab!, sql: review.sql, parameters: review.parameters}, review);
  };
  const draftSnapshot = useRef<DraftSnapshot|null>(null);
  draftSnapshot.current=session && connectedId && saved.some(item=>item.id===connectedId) && !busy ? {connectionId:connectedId,handleId:session.handleId,revision:editorRevision.current,tabs,activeTab:tabs.length?activeTab:null,objectNames:schema?.tables.map(item=>item.name)??[]} : null;
  const draftIntegration = useRef({t,apply:(restored: QueryTab[],active:number|null,next:number)=>{invalidateWrite();editorRevision.current++;setTabs(restored);updateActiveTab(active??0);nextTab.current=next;}});
  draftIntegration.current={t,apply:(restored,active,next)=>{invalidateWrite();editorRevision.current++;setTabs(restored);updateActiveTab(active??0);nextTab.current=next;}};
  const draftController=useMemo(()=>createEditorDraftStorage({storage:context.storage,snapshot:()=>{
    const snapshot=draftSnapshot.current;
    return snapshot && !locked.current && live.current?.handleId===snapshot.handleId ? {...snapshot,revision:editorRevision.current} : null;
  },confirm:async kind=>await context.ui.quickPick(draftIntegration.current.t(kind==='restore'?'Replace current editor tabs with saved drafts?':'Delete saved workspace drafts for this connection?'),[{id:'confirm',label:draftIntegration.current.t(kind==='restore'?'Replace editor tabs':'Delete saved drafts')},{id:'cancel',label:draftIntegration.current.t('Cancel')}])==='confirm',apply:(restored,active,next)=>draftIntegration.current.apply(restored.map(item=>({...item,result:null,resultSql:undefined})),active,next)}),[context]);
  const workspaceDrafts = async (operation:'save'|'restore'|'clear')=>{
    if(draftStorageRunning.current)return;draftStorageRunning.current=true;setDraftStorageBusy(true);setDraftStorageNotice(null);
    const rev=epoch.current;
    const outcome=await draftController.run(operation);
    draftStorageRunning.current=false;
    if(rev===epoch.current){setDraftStorageNotice(outcome);setDraftStorageBusy(false);}
    else setDraftStorageBusy(false);
  };
  const canDropColumn=canReviewWrite && context.database.capabilities.has('database.sqlite-drop-column.v1') && typeof context.database.previewDropColumn==='function' && typeof context.database.applyDropColumn==='function';
  const canRenameTable=canReviewWrite && context.database.capabilities.has('database.sqlite-rename-table.v1') && typeof context.database.previewRenameTable==='function' && typeof context.database.applyRenameTable==='function';
  const canRenameColumn=canReviewWrite && context.database.capabilities.has('database.sqlite-rename-column.v1') && typeof context.database.previewRenameColumn==='function' && typeof context.database.applyRenameColumn==='function';
  const canAddColumn=canReviewWrite && context.database.capabilities.has('database.sqlite-add-column.v1') && typeof context.database.previewAddColumn==='function' && typeof context.database.applyAddColumn==='function';
  const canExplainProjection=canReviewWrite && context.database.capabilities.has('database.sqlite-estimated-plan.v1') && typeof context.database.explainProjection==='function';
  const canDropView=canReviewWrite && context.database.capabilities.has('database.sqlite-drop-view.v1') && typeof context.database.previewDropView==='function' && typeof context.database.applyDropView==='function';
  const canCreateView=canReviewWrite && context.database.capabilities.has('database.sqlite-create-view.v1') && typeof context.database.previewCreateView==='function' && typeof context.database.applyCreateView==='function';
  const canCreateTable=canReviewWrite && context.database.capabilities.has('database.sqlite-create-table.v1');
  const acceptCreatedSchema=(handleId:string,next:DatabaseSchemaResult)=>{if(live.current?.handleId!==handleId)return;invalidateWrite();editorRevision.current++;setSchema(next);const retained=tabs.filter(t=>!t.objectName||next.tables.some(table=>table.name===t.objectName));setTabs(retained);if(!retained.some(t=>t.id===activeTab))setActiveTab(retained[0]?.id??'');};
  const canDropIndex=canReviewWrite && context.database.capabilities.has('database.sqlite-drop-index.v1') && typeof context.database.previewDropIndex==='function' && typeof context.database.applyDropIndex==='function';
  const canCreateIndex=canReviewWrite && context.database.capabilities.has('database.sqlite-create-index.v1') && typeof context.database.previewCreateIndex==='function' && typeof context.database.applyCreateIndex==='function';
  const canMutateGrid=canReviewWrite && context.database.capabilities.has('database.sqlite-grid-mutation.v1');
  const invalidateResults=(handleId:string)=>{if(live.current?.handleId!==handleId)return;invalidateWrite();editorRevision.current++;setTabs(items=>items.map(item=>({...item,result:null,resultSql:undefined})));};
  const canInsertRow=canReviewWrite && context.database.capabilities.has('database.sqlite-row-insert.v1') && typeof context.database.previewRowInsert==='function' && typeof context.database.applyRowInsert==='function';
  const canImportCsv=canReviewWrite && context.database.capabilities.has('database.sqlite-csv-import.v1');
  const canSnapshot=Boolean(session&&connectedId&&saved.some(c=>c.id===connectedId)&&context.database.capabilities.has('database.sqlite-snapshot.v1')&&typeof context.database.saveSnapshot==='function'&&typeof context.database.previewRestoreSnapshot==='function'&&typeof context.database.applyRestoreSnapshot==='function'&&typeof context.database.deleteSnapshot==='function');
  return { canExplainProjection,canDropView,canCreateView,canDropColumn,canRenameTable,canSnapshot,canInsertRow,canDropIndex, schemaApplying,setSchemaApplying, canRenameColumn, canAddColumn, canImportCsv, canMutateGrid, invalidateResults, canCreateIndex, canCreateTable, acceptCreatedSchema, workspaceDrafts, draftStorageBusy, draftStorageNotice, canStoreDrafts:Boolean(draftSnapshot.current), pendingWrite, canReviewWrite, confirmWrite, cancelWrite: invalidateWrite, queryLibrary, saveCurrentQuery, removeSavedQuery, clearHistory, loadQuery, selectedDriver, selectDriver, tcpEnabled, testTcp, connectTcp, invalidateDraft, liveSshPg, portProbe, tunnel, t, locale, tabTitle, saved, session, connectedId, connectionName: session && !connectedId && session.engine === 'sqlite' ? t('Disposable SQLite') : connectionName, schema, tabs, tab, activeTab, setActiveTab, addTab, closeTab, edit, busy:busy||schemaApplying, error, modal, setModal: (next: 'picker' | 'connection' | null) => {if(schemaApplyingRef.current)return; invalidateWrite(); tunnel.reset(); portProbe.reset(); liveSshPg.reset(); setModal(next); }, draftSession, tested, hosts, theme, enabled, persistence, fileEnabled, walEnabled, walConcurrentEnabled, walCheckpointEnabled, walCaptureEnabled, malformedRejectEnabled, walRefreshEnabled, refresh, dismiss, disconnect, selectSource, test, save, open, openUnsaved, remove, loadHosts, run };
}
