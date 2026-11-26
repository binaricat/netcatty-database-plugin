/**
 * Top-Level DBX-Parity Database IDE Shell (`data-plugin-chrome="full-bleed"`).
 * Orchestrates:
 * - Multi-connection sessions across PostgreSQL, MySQL/MariaDB, SQLite, ClickHouse, Redis, MongoDB
 * - Horizontal `PluginSplitPane` (268px collapsible Explorer + Multi-Tab Workspace)
 * - Persistent saved connections, encrypted secrets, query history, snippets, and per-connection tab drafts
 * - All 7 tab types (SQL, Table Data, Structure Designer, ER Diagram, Redis, MongoDB, Schema Diff)
 * - Right slide-over `AsidePanel` drawers + Global cursor-positioned `PluginPopover` context menus
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import { PluginPopover, PluginSplitPane } from '@netcatty/plugin-sdk/host-react';
import { Icon, type IconName } from '../Icon';
import {
  SqliteDriver,
  type BatchRowDelete,
  type BatchRowInsert,
  type BatchRowUpdate,
  type CellValue,
  type MongoDriver,
  type QueryResultSet,
  type RedisDriver,
  type RelationalDriver,
  type SchemaSnapshot,
  type TableStructureDiff,
} from '../drivers/index';
import {
  exportCsv,
  exportJson,
  exportMarkdown,
  exportSqlInserts,
  exportXlsx,
  formatSql,
} from '../sql/index';
import { createUiTranslator } from './i18n';
import {
  buildCompletionSchemaForSession,
  engineToSqlDialect,
  isMongoDriver,
  isRedisDriver,
  isRelationalDriver,
  loadSchemaObjects,
  makeDefaultConnection,
  openSavedConnectionSession,
  schemaCacheKey,
  type ModalBridge,
} from './sessionManager';
import { WorkbenchStorage } from './storage';
import type {
  ActiveSession,
  ContextMenuItem,
  ContextMenuState,
  ErDiagramTabState,
  MongoWorkbenchTabState,
  PersistedTabDraft,
  QueryHistoryEntry,
  RedisWorkbenchTabState,
  RightDrawerState,
  SavedConnection,
  SavedSnippet,
  SchemaDiffTabState,
  SqlQueryTabState,
  StructureDesignerTabState,
  TableDataTabState,
  ToastNotice,
  WorkspaceTab,
} from './types';
import { exportConnectionUri } from './uriParser';
import {
  AiAssistantDrawer,
  CellInspectorDrawer,
  CreateTableDrawer,
  HistorySnippetsDrawer,
  ImportWizardDrawer,
  SqlPreviewDrawer,
} from './components/AuxDrawers';
import { ConnectionDrawer } from './components/ConnectionDrawer';
import { EngineIcon, resolveThemeVariant } from './components/EngineBadge';
import { ErDiagramTab } from './components/ErDiagramTab';
import { MongoWorkbenchTab } from './components/MongoWorkbenchTab';
import { RedisWorkbenchTab } from './components/RedisWorkbenchTab';
import { SchemaDiffTab } from './components/SchemaDiffTab';
import { SidebarExplorer } from './components/SidebarExplorer';
import { SqlQueryTab, type ExportFormat } from './components/SqlQueryTab';
import { StructureDesignerTab } from './components/StructureDesignerTab';
import { TableDataTab } from './components/TableDataTab';
import { WelcomeView } from './components/WelcomeView';

const TAB_ICON: Record<WorkspaceTab['kind'], IconName> = {
  sql: 'file-code',
  table: 'table',
  structure: 'settings',
  er: 'database',
  redis: 'key',
  mongo: 'folder',
  diff: 'book-open',
};

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface DbxWorkbenchProps {
  context: PluginContext;
  modalBridge: ModalBridge;
}

export function DbxWorkbench({ context, modalBridge }: DbxWorkbenchProps) {
  const storage = useMemo(() => new WorkbenchStorage(context), [context]);

  // Environment reactivity (theme + locale)
  const [theme, setTheme] = useState(context.environment.theme || 'dark');
  const [locale, setLocale] = useState(context.environment.locale || 'en');
  useEffect(() => {
    const sub = context.environment.onDidChange((ev) => {
      setTheme(ev.theme || 'dark');
      setLocale(ev.locale || 'en');
    });
    return () => sub.dispose();
  }, [context.environment]);

  const t = useMemo(() => createUiTranslator(locale), [locale]);

  // Core workbench state
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [sessions, setSessions] = useState<Record<string, ActiveSession>>({});
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [drawer, setDrawer] = useState<RightDrawerState>({ kind: 'none' });
  const [editingPassword, setEditingPassword] = useState<string | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [toasts, setToasts] = useState<ToastNotice[]>([]);

  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
  const [snippets, setSnippets] = useState<SavedSnippet[]>([]);

  // Ephemeral SQLite bytes cache for file connections opened this runtime
  const sqliteBytesRef = useRef<Map<string, Uint8Array>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const notify = useCallback((level: ToastNotice['level'], message: string) => {
    const id = uid('toast');
    setToasts((prev) => [...prev.slice(-2), { id, level, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4000);
  }, []);

  // Load persisted connections, history, snippets on mount
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [conns, hist, snips] = await Promise.all([
        storage.loadConnections(),
        storage.loadHistory(),
        storage.loadSnippets(),
      ]);
      if (!alive) return;
      setConnections(conns);
      setHistory(hist);
      setSnippets(snips);
    })();
    return () => {
      alive = false;
      // Cleanly close all active database connections on unmount
      for (const sess of Object.values(sessionsRef.current)) {
        void sess.driver.close().catch(() => {});
      }
    };
  }, [storage]);

  // Helper to update a single tab
  const updateTab = useCallback(<T extends WorkspaceTab>(tabId: string, patch: Partial<T>) => {
    tabsRef.current = tabsRef.current.map((tab) => (tab.id === tabId ? ({ ...tab, ...patch } as WorkspaceTab) : tab));
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? ({ ...tab, ...patch } as WorkspaceTab) : tab)));
  }, []);

  const appendTab = useCallback((tab: WorkspaceTab) => {
    tabsRef.current = [...tabsRef.current, tab];
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    setActiveConnectionId(tab.connectionId);
  }, []);

  // Persist tab drafts per connection (debounced)
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeConnectionId) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      const connTabs = tabsRef.current.filter((item) => item.connectionId === activeConnectionId);
      const drafts: PersistedTabDraft[] = connTabs.map((item) => {
        if (item.kind === 'sql') {
          return {
            id: item.id,
            kind: 'sql',
            title: item.title,
            database: item.database,
            schema: item.schema,
            sql: item.sql.slice(0, 32768),
            dialect: item.dialect,
          };
        }
        if (item.kind === 'table') {
          return { id: item.id, kind: 'table', title: item.title, database: item.database, schema: item.schema, table: item.table };
        }
        if (item.kind === 'mongo') {
          return { id: item.id, kind: 'mongo', title: item.title, database: item.database, collection: item.collection };
        }
        return { id: item.id, kind: item.kind, title: item.title };
      });
      void storage.saveTabDrafts(activeConnectionId, drafts);
    }, 600);
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    };
  }, [tabs, activeConnectionId, storage]);

  // Clipboard helper
  const copyText = useCallback(
    async (text: string, label: string) => {
      try {
        await context.clipboard.writeText(text, `Copy ${label}`);
        notify('success', `${t('Copied')}: ${label}`);
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
      }
    },
    [context.clipboard, notify, t],
  );

  // Persist durable SSH tunnel binding token when returned by Netcatty
  const persistBindingToken = useCallback(
    (connectionId: string, token: string) => {
      setConnections((prev) => {
        const next = prev.map((c) =>
          c.id === connectionId
            ? { ...c, sshTunnel: { ...c.sshTunnel, hostBindingToken: token } }
            : c,
        );
        void storage.saveConnections(next);
        return next;
      });
    },
    [storage],
  );

  // Lazy load schema objects (tables, views, routines, triggers)
  const loadSchemaForSession = useCallback(
    async (connectionId: string, database: string, schema: string, force = false) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return;
      const key = schemaCacheKey(database, schema);
      if (!force && sess.objectsBySchema[key]?.loaded) return;

      setSessions((prev) => {
        const cur = prev[connectionId];
        if (!cur) return prev;
        return {
          ...prev,
          [connectionId]: {
            ...cur,
            objectsBySchema: {
              ...cur.objectsBySchema,
              [key]: cur.objectsBySchema[key] ?? {
                tables: [],
                views: [],
                routines: [],
                triggers: [],
                structures: {},
                loaded: false,
                loading: true,
              },
            },
          },
        };
      });

      try {
        const objects = await loadSchemaObjects(sess.driver, database, schema);
        setSessions((prev) => {
          const cur = prev[connectionId];
          if (!cur) return prev;
          return {
            ...prev,
            [connectionId]: {
              ...cur,
              objectsBySchema: { ...cur.objectsBySchema, [key]: objects },
            },
          };
        });
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
      }
    },
    [notify],
  );

  const loadTableStructureForCache = useCallback(
    async (connectionId: string, database: string, schema: string, table: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return null;
      const key = schemaCacheKey(database, schema);
      try {
        const struct = await sess.driver.getTableStructure(database, schema, table);
        setSessions((prev) => {
          const cur = prev[connectionId];
          if (!cur) return prev;
          const existing = cur.objectsBySchema[key] ?? {
            tables: [],
            views: [],
            routines: [],
            triggers: [],
            structures: {},
            loaded: false,
            loading: false,
          };
          return {
            ...prev,
            [connectionId]: {
              ...cur,
              objectsBySchema: {
                ...cur.objectsBySchema,
                [key]: {
                  ...existing,
                  structures: { ...existing.structures, [table]: struct },
                },
              },
            },
          };
        });
        return struct;
      } catch {
        return null;
      }
    },
    [],
  );

  // Open SQL query tab
  const openSqlTab = useCallback(
    (connectionId: string, initialSql = '', customTitle?: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess) return;
      const existingCount = tabsRef.current.filter((item) => item.kind === 'sql').length;
      const tab: SqlQueryTabState = {
        id: uid('sql'),
        connectionId,
        kind: 'sql',
        title: customTitle || `Query ${existingCount + 1}`,
        dialect: engineToSqlDialect(sess.connection.engine),
        database: sess.activeDatabase,
        schema: sess.activeSchema,
        sql: initialSql,
        selectedText: '',
        txMode: 'auto',
        inTransaction: false,
        running: false,
        results: [],
        activeResultTab: 0,
        messages: [],
        explainResult: null,
        diagnostics: [],
      };
      appendTab(tab);
    },
    [appendTab],
  );

  // Load Table Data helper
  const reloadTableTab = useCallback(
    async (
      tabId: string,
      opts?: { page?: number; pageSize?: number; whereClause?: string; sort?: TableDataTabState['sort'] },
    ) => {
      const tab = tabsRef.current.find((item): item is TableDataTabState => item.id === tabId && item.kind === 'table');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return;

      const page = opts?.page ?? tab.page;
      const pageSize = opts?.pageSize ?? tab.pageSize;
      const whereClause = opts?.whereClause !== undefined ? opts.whereClause : tab.appliedWhere;
      const sort = opts?.sort !== undefined ? opts.sort : tab.sort;

      updateTab<TableDataTabState>(tabId, { loading: true, error: undefined });
      try {
        const [browse, structure] = await Promise.all([
          sess.driver.browseTable(tab.database, tab.schema, tab.table, {
            page,
            pageSize,
            whereClause,
            sortBy: sort?.column,
            sortDir: sort?.direction,
          }),
          tab.structure
            ? Promise.resolve(tab.structure)
            : loadTableStructureForCache(tab.connectionId, tab.database, tab.schema, tab.table),
        ]);
        updateTab<TableDataTabState>(tabId, {
          loading: false,
          structure: structure ?? tab.structure,
          columns: browse.columns,
          rows: browse.rows,
          page: browse.page,
          pageSize: browse.pageSize,
          totalRows: browse.totalRows,
          totalEstimated: browse.totalEstimated,
          executionMs: browse.executionMs,
          sql: browse.sql,
          appliedWhere: whereClause,
          sort,
          dirtyCells: {},
          insertedRows: [],
          deletedRowIndices: [],
          selectedRowIndices: [],
          dirty: false,
        });
      } catch (err) {
        updateTab<TableDataTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [loadTableStructureForCache, updateTab],
  );

  // Open Table Data tab
  const openTableDataTab = useCallback(
    (connectionId: string, database: string, schema: string, table: string) => {
      const existing = tabsRef.current.find(
        (item): item is TableDataTabState =>
          item.kind === 'table' &&
          item.connectionId === connectionId &&
          item.database === database &&
          item.schema === schema &&
          item.table === table,
      );
      if (existing) {
        setActiveTabId(existing.id);
        setActiveConnectionId(connectionId);
        return;
      }
      const tab: TableDataTabState = {
        id: uid('tbl'),
        connectionId,
        kind: 'table',
        title: table,
        database,
        schema,
        table,
        structure: null,
        whereClause: '',
        appliedWhere: '',
        sort: null,
        page: 1,
        pageSize: 50,
        totalRows: 0,
        totalEstimated: false,
        columns: [],
        rows: [],
        loading: true,
        executionMs: 0,
        sql: '',
        dirtyCells: {},
        insertedRows: [],
        deletedRowIndices: [],
        selectedRowIndices: [],
      };
      appendTab(tab);
      setTimeout(() => void reloadTableTab(tab.id), 0);
    },
    [appendTab, reloadTableTab],
  );

  // Load Structure Designer tab
  const reloadStructureTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find(
        (item): item is StructureDesignerTabState => item.id === tabId && item.kind === 'structure',
      );
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return;
      updateTab<StructureDesignerTabState>(tabId, { loading: true, error: undefined });
      try {
        const [structure, allTriggers] = await Promise.all([
          sess.driver.getTableStructure(tab.database, tab.schema, tab.table),
          sess.driver.listTriggers(tab.database, tab.schema).catch(() => []),
        ]);
        const tableTriggers = allTriggers.filter((tr) => tr.tableName === tab.table);
        updateTab<StructureDesignerTabState>(tabId, {
          loading: false,
          structure,
          triggers: tableTriggers,
        });
      } catch (err) {
        updateTab<StructureDesignerTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updateTab],
  );

  const openStructureTab = useCallback(
    (connectionId: string, database: string, schema: string, table: string) => {
      const existing = tabsRef.current.find(
        (item): item is StructureDesignerTabState =>
          item.kind === 'structure' &&
          item.connectionId === connectionId &&
          item.schema === schema &&
          item.table === table,
      );
      if (existing) {
        setActiveTabId(existing.id);
        setActiveConnectionId(connectionId);
        return;
      }
      const tab: StructureDesignerTabState = {
        id: uid('struct'),
        connectionId,
        kind: 'structure',
        title: `${table} (Structure)`,
        database,
        schema,
        table,
        structure: null,
        triggers: [],
        activeSubTab: 'columns',
        pendingDiff: {},
        loading: true,
        applying: false,
      };
      appendTab(tab);
      setTimeout(() => void reloadStructureTab(tab.id), 0);
    },
    [appendTab, reloadStructureTab],
  );

  // ER Diagram Tab
  const reloadErTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item): item is ErDiagramTabState => item.id === tabId && item.kind === 'er');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return;
      updateTab<ErDiagramTabState>(tabId, { loading: true, error: undefined });
      try {
        const graph = await sess.driver.getSchemaErGraph(tab.database, tab.schema);
        updateTab<ErDiagramTabState>(tabId, { loading: false, graph });
      } catch (err) {
        updateTab<ErDiagramTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updateTab],
  );

  const openErTab = useCallback(
    (connectionId: string, database: string, schema: string) => {
      const existing = tabsRef.current.find(
        (item): item is ErDiagramTabState =>
          item.kind === 'er' && item.connectionId === connectionId && item.schema === schema,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const tab: ErDiagramTabState = {
        id: uid('er'),
        connectionId,
        kind: 'er',
        title: `ER: ${schema || database}`,
        database,
        schema,
        graph: null,
        filter: '',
        selectedTable: null,
        loading: true,
      };
      appendTab(tab);
      setTimeout(() => void reloadErTab(tab.id), 0);
    },
    [appendTab, reloadErTab],
  );

  // Redis Tab
  const scanRedisTab = useCallback(
    async (tabId: string, opts?: { db?: number; match?: string }) => {
      const tab = tabsRef.current.find((item): item is RedisWorkbenchTabState => item.id === tabId && item.kind === 'redis');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isRedisDriver(sess.driver)) return;
      const nextDb = opts?.db ?? tab.db;
      const nextMatch = opts?.match !== undefined ? opts.match : tab.matchPattern;

      updateTab<RedisWorkbenchTabState>(tabId, { loading: true, error: undefined, db: nextDb, matchPattern: nextMatch });
      try {
        if (nextDb !== sess.driver.currentDb) {
          await sess.driver.selectDb(nextDb);
        }
        const [scan, info] = await Promise.all([
          sess.driver.scanKeys({ match: nextMatch || '*', count: 200, maxKeys: 500, includeMeta: true }),
          sess.driver.getInfo().catch(() => tab.info),
        ]);
        updateTab<RedisWorkbenchTabState>(tabId, {
          loading: false,
          keys: scan.keys,
          cursor: scan.cursor,
          info: info ?? null,
        });
      } catch (err) {
        updateTab<RedisWorkbenchTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updateTab],
  );

  const openRedisTab = useCallback(
    (connectionId: string, dbOverride?: number) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isRedisDriver(sess.driver)) return;
      const existing = tabsRef.current.find(
        (item): item is RedisWorkbenchTabState => item.kind === 'redis' && item.connectionId === connectionId,
      );
      if (existing) {
        setActiveTabId(existing.id);
        if (dbOverride !== undefined && dbOverride !== existing.db) {
          void scanRedisTab(existing.id, { db: dbOverride });
        }
        return;
      }
      const tab: RedisWorkbenchTabState = {
        id: uid('redis'),
        connectionId,
        kind: 'redis',
        title: `${sess.connection.name} (Redis)`,
        db: dbOverride ?? sess.driver.currentDb,
        matchPattern: '*',
        viewMode: 'tree',
        keys: [],
        cursor: '0',
        selectedKey: null,
        keyDetail: null,
        info: sess.redisInfo ?? null,
        showInfo: false,
        showCli: false,
        cliInput: '',
        cliHistory: [],
        loading: true,
      };
      appendTab(tab);
      setTimeout(() => void scanRedisTab(tab.id), 0);
    },
    [appendTab, scanRedisTab],
  );

  // MongoDB Tab
  const runMongoTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item): item is MongoWorkbenchTabState => item.id === tabId && item.kind === 'mongo');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isMongoDriver(sess.driver)) return;
      updateTab<MongoWorkbenchTabState>(tabId, { loading: true, error: undefined });
      const started = performance.now();
      try {
        if (tab.mode === 'aggregate') {
          const pipeline = JSON.parse(tab.pipelineJson || '[]');
          if (!Array.isArray(pipeline)) throw new Error('Aggregation pipeline must be a JSON array');
          const docs = await sess.driver.aggregate(tab.database, tab.collection, pipeline);
          updateTab<MongoWorkbenchTabState>(tabId, {
            loading: false,
            documents: docs,
            totalCount: docs.length,
            executionMs: Math.round(performance.now() - started),
          });
        } else {
          const filter = tab.filterJson.trim() ? JSON.parse(tab.filterJson) : {};
          const sort = tab.sortJson.trim() ? JSON.parse(tab.sortJson) : undefined;
          const projection = tab.projectionJson.trim() ? JSON.parse(tab.projectionJson) : undefined;
          const [res, stats, indexes] = await Promise.all([
            sess.driver.find(tab.database, tab.collection, {
              filter,
              sort,
              projection,
              skip: tab.skip,
              limit: tab.limit,
            }),
            sess.driver.collStats(tab.database, tab.collection).catch(() => null),
            sess.driver.listIndexes(tab.database, tab.collection).catch(() => []),
          ]);
          updateTab<MongoWorkbenchTabState>(tabId, {
            loading: false,
            documents: res.documents,
            totalCount: res.totalCount,
            executionMs: res.executionMs,
            stats,
            indexes,
          });
        }
      } catch (err) {
        updateTab<MongoWorkbenchTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updateTab],
  );

  const openMongoCollectionTab = useCallback(
    (connectionId: string, database: string, collection: string) => {
      const existing = tabsRef.current.find(
        (item): item is MongoWorkbenchTabState =>
          item.kind === 'mongo' &&
          item.connectionId === connectionId &&
          item.database === database &&
          item.collection === collection,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const tab: MongoWorkbenchTabState = {
        id: uid('mongo'),
        connectionId,
        kind: 'mongo',
        title: collection,
        database,
        collection,
        mode: 'find',
        filterJson: '{}',
        sortJson: '',
        projectionJson: '',
        pipelineJson: '[\n  { "$limit": 20 }\n]',
        limit: 50,
        skip: 0,
        viewMode: 'table',
        activeSubTab: 'documents',
        documents: [],
        totalCount: 0,
        indexes: [],
        stats: null,
        selectedDocIndex: null,
        executionMs: 0,
        loading: true,
      };
      appendTab(tab);
      setTimeout(() => void runMongoTab(tab.id), 0);
    },
    [appendTab, runMongoTab],
  );

  // Schema Diff & Dump Tab
  const openSchemaDiffTab = useCallback((connectionId: string, initialDumpSql = '') => {
    const sess = sessionsRef.current[connectionId];
    if (!sess || !isRelationalDriver(sess.driver)) return;
    const schemas = sess.schemas.map((s) => s.name);
    const left = sess.activeSchema || schemas[0] || 'main';
    const right = schemas.find((s) => s !== left) ?? left;
    const tab: SchemaDiffTabState = {
      id: uid('diff'),
      connectionId,
      kind: 'diff',
      title: initialDumpSql ? 'SQL Dump' : 'Schema Diff',
      database: sess.activeDatabase,
      leftSchema: left,
      rightSchema: right,
      diffResult: null,
      dumpSql: initialDumpSql,
      includeData: true,
      loading: false,
    };
    appendTab(tab);
  }, [appendTab]);

  // Connect to a SavedConnection
  const connectTo = useCallback(
    async (conn: SavedConnection, overridePassword?: string, overrideSqliteBytes?: Uint8Array) => {
      if (sessionsRef.current[conn.id]) {
        setActiveConnectionId(conn.id);
        return;
      }
      setConnectingId(conn.id);
      try {
        let pw = overridePassword;
        if (pw === undefined && conn.hasPassword) {
          pw = await storage.readPassword(conn.id);
        }
        let sqlBytes = overrideSqliteBytes ?? sqliteBytesRef.current.get(conn.id);
        if (conn.engine === 'sqlite' && conn.sqliteMode === 'file' && !sqlBytes) {
          const picked = await context.ui.openFile({
            title: `Open SQLite File: ${conn.sqliteFileName || conn.name}`,
            filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'sqlite3', 'db', 's3db'] }],
            readAs: 'bytes',
          });
          if (picked.cancelled) {
            setConnectingId(null);
            return;
          }
          sqlBytes = picked.data instanceof Uint8Array ? picked.data : new Uint8Array(0);
          sqliteBytesRef.current.set(conn.id, sqlBytes);
          conn = { ...conn, sqliteFileName: picked.name, sqliteFileHandleId: picked.handleId };
        }

        const session = await openSavedConnectionSession(
          context,
          conn,
          pw,
          sqlBytes,
          (token) => persistBindingToken(conn.id, token),
        );

        sessionsRef.current = { ...sessionsRef.current, [conn.id]: session };
        setSessions((prev) => ({ ...prev, [conn.id]: session }));
        setActiveConnectionId(conn.id);
        notify('success', `${t('Connected')}: ${conn.name} (${session.info.serverVersion})`);

        // Auto-load initial schema & restore drafts / open starter tab
        if (isRelationalDriver(session.driver)) {
          void loadSchemaForSession(conn.id, session.activeDatabase, session.activeSchema);
          const drafts = await storage.loadTabDrafts(conn.id);
          const sqlDrafts = drafts.filter((d) => d.kind === 'sql');
          if (sqlDrafts.length > 0) {
            for (const d of sqlDrafts.slice(0, 3)) {
              openSqlTab(conn.id, d.sql || '', d.title);
            }
          } else {
            openSqlTab(conn.id, `-- Connected to ${conn.name} (${session.info.serverVersion})\n`);
          }
        } else if (isRedisDriver(session.driver)) {
          openRedisTab(conn.id, session.driver.currentDb);
        } else if (isMongoDriver(session.driver)) {
          const firstCol = session.mongoCollectionsByDb[session.activeDatabase]?.[0];
          if (firstCol) {
            openMongoCollectionTab(conn.id, session.activeDatabase, firstCol.name);
          }
        }
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
      } finally {
        setConnectingId(null);
      }
    },
    [
      context,
      loadSchemaForSession,
      notify,
      openMongoCollectionTab,
      openRedisTab,
      openSqlTab,
      persistBindingToken,
      storage,
      t,
    ],
  );

  // Disconnect
  const disconnectConnection = useCallback(
    async (connectionId: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess) return;
      await sess.driver.close().catch(() => {});
      const nextSessions = { ...sessionsRef.current };
      delete nextSessions[connectionId];
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      setTabs((prev) => prev.filter((item) => item.connectionId !== connectionId));
      setActiveTabId((prev) => {
        const remaining = tabsRef.current.filter((item) => item.connectionId !== connectionId);
        if (remaining.some((r) => r.id === prev)) return prev;
        return remaining[0]?.id ?? null;
      });
      if (activeConnectionId === connectionId) {
        const nextConnId = Object.keys(sessionsRef.current).find((id) => id !== connectionId) ?? null;
        setActiveConnectionId(nextConnId);
      }
      notify('info', `${t('Disconnected')}: ${sess.connection.name}`);
    },
    [activeConnectionId, notify, t],
  );

  // Save connection handler (shared with standalone modal view!)
  const handleSaveConnection = useCallback(
    async (
      conn: SavedConnection,
      password: string | undefined,
      connectNow: boolean,
      sqliteBytes?: Uint8Array,
    ) => {
      let hasPassword = conn.hasPassword;
      if (password !== undefined) {
        hasPassword = await storage.savePassword(conn.id, password);
      }
      if (sqliteBytes) {
        sqliteBytesRef.current.set(conn.id, sqliteBytes);
      }
      const finalConn: SavedConnection = { ...conn, hasPassword };
      const next = connectionsRef.current.some((c) => c.id === finalConn.id)
        ? connectionsRef.current.map((c) => (c.id === finalConn.id ? finalConn : c))
        : [...connectionsRef.current, finalConn];
      setConnections(next);
      await storage.saveConnections(next);
      setDrawer({ kind: 'none' });
      if (connectNow) {
        await connectTo(finalConn, password, sqliteBytes);
      } else {
        notify('success', `Saved connection: ${finalConn.name}`);
      }
    },
    [connectTo, notify, storage],
  );

  // Wire standalone modal bridge
  useEffect(() => {
    modalBridge.setSaveHandler(handleSaveConnection);
    return () => modalBridge.setSaveHandler(null);
  }, [modalBridge, handleSaveConnection]);

  // Quick Open Local SQLite File
  const handleQuickOpenSqliteFile = useCallback(async () => {
    try {
      const res = await context.ui.openFile({
        title: t('Open Local SQLite File'),
        filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'sqlite3', 'db', 's3db'] }],
        readAs: 'bytes',
      });
      if (res.cancelled) return;
      const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(0);
      const base = makeDefaultConnection('sqlite');
      const conn: SavedConnection = {
        ...base,
        name: res.name.replace(/\.(sqlite3?|db|s3db)$/i, '') || res.name,
        sqliteMode: 'file',
        sqliteFileName: res.name,
        sqliteFileHandleId: res.handleId,
        database: res.name,
      };
      await handleSaveConnection(conn, undefined, true, bytes);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    }
  }, [context.ui, handleSaveConnection, notify, t]);

  // Quick Launch Sample SQLite
  const handleLaunchSampleSqlite = useCallback(async () => {
    const existing = connectionsRef.current.find(
      (c) => c.engine === 'sqlite' && c.sqliteMode === 'demo',
    );
    if (existing) {
      await connectTo(existing);
      return;
    }
    const conn = makeDefaultConnection('sqlite');
    await handleSaveConnection(conn, undefined, true);
  }, [connectTo, handleSaveConnection]);

  // Save SQLite file back via `ui.saveFile` or `ui.writeFileHandle`
  const handleSaveSqliteFile = useCallback(
    async (connectionId: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !(sess.driver instanceof SqliteDriver)) return;
      try {
        const bytes = sess.driver.exportBytes();
        if (sess.sqliteFileHandleId && typeof context.ui.writeFileHandle === 'function') {
          await context.ui.writeFileHandle(sess.sqliteFileHandleId, bytes);
          notify('success', `Saved ${sess.connection.sqliteFileName || 'database.sqlite'}`);
        } else {
          const saved = await context.ui.saveFile({
            title: 'Save SQLite Database',
            defaultName: sess.connection.sqliteFileName || `${sess.connection.name}.sqlite`,
            filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }],
            data: bytes,
          });
          if (!saved.cancelled) {
            notify('success', `Saved ${saved.name}`);
          }
        }
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
      }
    },
    [context.ui, notify],
  );

  // Switch active database on a connected session
  const handleSwitchDatabase = useCallback(
    async (connectionId: string, database: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess) return;
      if (isRelationalDriver(sess.driver)) {
        try {
          if (sess.family === 'mysql' || sess.family === 'clickhouse') {
            await sess.driver.query(`USE \`${database.replaceAll('`', '``')}\``);
          }
          const schemas = await sess.driver.listSchemas(database).catch(() => [{ name: database }]);
          const activeSchema = schemas.find((s) => s.name === 'public')?.name ?? schemas[0]?.name ?? database;
          const updatedSess: ActiveSession = {
            ...sessionsRef.current[connectionId],
            activeDatabase: database,
            schemas,
            activeSchema,
          };
          sessionsRef.current = { ...sessionsRef.current, [connectionId]: updatedSess };
          setSessions((prev) => ({
            ...prev,
            [connectionId]: updatedSess,
          }));
          void loadSchemaForSession(connectionId, database, activeSchema, true);
        } catch (err) {
          notify('error', err instanceof Error ? err.message : String(err));
        }
      } else if (isMongoDriver(sess.driver)) {
        try {
          const cols = await sess.driver.listCollections(database);
          const updatedSess: ActiveSession = {
            ...sessionsRef.current[connectionId],
            activeDatabase: database,
            mongoCollectionsByDb: {
              ...sessionsRef.current[connectionId].mongoCollectionsByDb,
              [database]: cols,
            },
          };
          sessionsRef.current = { ...sessionsRef.current, [connectionId]: updatedSess };
          setSessions((prev) => ({
            ...prev,
            [connectionId]: updatedSess,
          }));
        } catch (err) {
          notify('error', err instanceof Error ? err.message : String(err));
        }
      } else if (isRedisDriver(sess.driver)) {
        const updatedSess: ActiveSession = {
          ...sessionsRef.current[connectionId],
          activeDatabase: database,
        };
        sessionsRef.current = { ...sessionsRef.current, [connectionId]: updatedSess };
        setSessions((prev) => ({
          ...prev,
          [connectionId]: updatedSess,
        }));
      }
    },
    [loadSchemaForSession, notify],
  );

  // Execute SQL on a SQL Query Tab
  const handleExecuteSqlTab = useCallback(
    async (tabId: string, sqlToRun: string) => {
      const tab = tabsRef.current.find((item): item is SqlQueryTabState => item.id === tabId && item.kind === 'sql');
      if (!tab || !sqlToRun.trim()) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return;

      updateTab<SqlQueryTabState>(tabId, { running: true, diagnostics: [] });
      try {
        const res = await sess.driver.query(sqlToRun, { database: tab.database, schema: tab.schema });
        const totalRows = res.results.reduce((acc, r) => acc + r.rowCount, 0);
        const newMsgs = res.results.map((r, idx) => ({
          time: Date.now(),
          level: 'success' as const,
          text: `[${idx + 1}] ${r.commandTag ?? 'OK'} — ${r.rowCount} rows, ${r.affectedRows} affected (${r.executionMs} ms)`,
        }));
        updateTab<SqlQueryTabState>(tabId, {
          running: false,
          results: res.results,
          activeResultTab: res.results.length > 0 ? 0 : 'messages',
          inTransaction: sess.driver.inTransaction,
          messages: [...tab.messages.slice(-40), ...newMsgs],
        });

        // Append query history
        const entry: QueryHistoryEntry = {
          id: uid('hist'),
          connectionId: sess.connectionId,
          connectionName: sess.connection.name,
          engine: sess.connection.engine,
          sql: sqlToRun.slice(0, 4000),
          executedAt: Date.now(),
          executionMs: res.totalExecutionMs,
          rowCount: totalRows,
          success: true,
        };
        setHistory((prev) => {
          void storage.appendHistory(entry, prev);
          return [entry, ...prev].slice(0, 200);
        });

        // Refresh schema cache if DDL ran
        if (/^\s*(?:CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(sqlToRun)) {
          void loadSchemaForSession(sess.connectionId, tab.database, tab.schema, true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updateTab<SqlQueryTabState>(tabId, {
          running: false,
          activeResultTab: 'messages',
          diagnostics: [{ line: 1, column: 1, endColumn: 40, message: msg, severity: 'error' }],
          messages: [...tab.messages.slice(-40), { time: Date.now(), level: 'error', text: msg }],
        });
        const entry: QueryHistoryEntry = {
          id: uid('hist'),
          connectionId: sess.connectionId,
          connectionName: sess.connection.name,
          engine: sess.connection.engine,
          sql: sqlToRun.slice(0, 4000),
          executedAt: Date.now(),
          executionMs: 0,
          rowCount: 0,
          success: false,
          error: msg,
        };
        setHistory((prev) => {
          void storage.appendHistory(entry, prev);
          return [entry, ...prev].slice(0, 200);
        });
      }
    },
    [loadSchemaForSession, storage, updateTab],
  );

  // Export helper (shared by SQL Query Tab & Table Data Tab)
  const handleExportDataset = useCallback(
    async (
      name: string,
      columns: string[],
      rows: CellValue[][],
      dialect: 'postgres' | 'mysql' | 'sqlite' | 'clickhouse',
      format: ExportFormat,
      schema?: string,
    ) => {
      try {
        if (format === 'copy-csv') {
          await copyText(exportCsv(columns, rows), `${name}.csv`);
          return;
        }
        if (format === 'copy-json') {
          await copyText(exportJson(columns, rows), `${name}.json`);
          return;
        }
        if (format === 'xlsx') {
          const bytes = exportXlsx(name, columns, rows);
          const res = await context.ui.saveFile({
            title: t('Export XLSX'),
            defaultName: `${name}.xlsx`,
            filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
            data: bytes,
          });
          if (!res.cancelled) notify('success', `Exported ${res.name}`);
          return;
        }
        const content =
          format === 'csv'
            ? exportCsv(columns, rows, { bom: true })
            : format === 'json'
              ? exportJson(columns, rows)
              : format === 'markdown'
                ? exportMarkdown(columns, rows)
                : exportSqlInserts(name, columns, rows, dialect, { schema, batchSize: 50 });
        const ext = format === 'markdown' ? 'md' : format;
        const res = await context.ui.saveFile({
          title: `${t('Export')} ${ext.toUpperCase()}`,
          defaultName: `${name}.${ext}`,
          filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
          data: content,
          encoding: 'utf8',
        });
        if (!res.cancelled) notify('success', `Exported ${res.name}`);
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
      }
    },
    [context.ui, copyText, notify, t],
  );

  // Build Batch Mutation Preview for a TableDataTab
  const buildTableBatchPreview = useCallback((tab: TableDataTabState, sess: ActiveSession) => {
    if (!isRelationalDriver(sess.driver) || !tab.structure) return null;
    const pkCols = tab.structure.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    const keyColNames = pkCols.length > 0 ? pkCols : tab.structure.columns.map((c) => c.name);
    const colIndexMap = new Map(tab.columns.map((c, i) => [c.name, i]));

    const buildKeyValues = (rowIndex: number): Record<string, CellValue> => {
      const raw = tab.rows[rowIndex] ?? [];
      const kv: Record<string, CellValue> = {};
      for (const name of keyColNames) {
        const idx = colIndexMap.get(name);
        kv[name] = idx !== undefined ? (raw[idx] ?? null) : null;
      }
      return kv;
    };

    // Group dirty cells by rowIndex
    const updatesByRow = new Map<number, Record<string, CellValue>>();
    for (const [key, val] of Object.entries(tab.dirtyCells)) {
      const sep = key.indexOf(':');
      const rIdx = Number(key.slice(0, sep));
      const cName = key.slice(sep + 1);
      if (rIdx >= tab.rows.length || tab.deletedRowIndices.includes(rIdx)) continue;
      const bucket = updatesByRow.get(rIdx) ?? {};
      bucket[cName] = val;
      updatesByRow.set(rIdx, bucket);
    }

    const updates: BatchRowUpdate[] = Array.from(updatesByRow.entries()).map(([rIdx, changes]) => ({
      keyValues: buildKeyValues(rIdx),
      changes,
    }));
    const inserts: BatchRowInsert[] = tab.insertedRows.map((values) => ({ values }));
    const deletes: BatchRowDelete[] = tab.deletedRowIndices
      .filter((i) => i < tab.rows.length)
      .map((i) => ({ keyValues: buildKeyValues(i) }));

    return sess.driver.generateBatchMutations(tab.database, tab.schema, tab.table, tab.structure, {
      inserts,
      updates,
      deletes,
    });
  }, []);

  // Active tab & session references
  const activeTab = useMemo(
    () => tabs.find((item) => item.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const activeSession = activeTab
    ? sessions[activeTab.connectionId]
    : activeConnectionId
      ? sessions[activeConnectionId]
      : undefined;

  const connectedIds = useMemo(() => new Set(Object.keys(sessions)), [sessions]);

  const activeCompletionSchema = useMemo(() => {
    if (!activeTab || activeTab.kind !== 'sql' || !activeSession) return undefined;
    return buildCompletionSchemaForSession(activeSession, activeTab.database, activeTab.schema);
  }, [activeTab, activeSession]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((item) => item.id === tabId);
      const next = prev.filter((item) => item.id !== tabId);
      setActiveTabId((cur) => {
        if (cur !== tabId) return cur;
        return next[Math.max(0, idx - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

  const openEditDrawer = useCallback(
    async (conn: SavedConnection) => {
      setEditingPassword(undefined);
      setDrawer({ kind: 'connection', editingId: conn.id });
      if (conn.hasPassword) {
        const pw = await storage.readPassword(conn.id);
        setEditingPassword(pw);
      }
    },
    [storage],
  );

  return (
    <main
      className="dbx-workbench database-workbench"
      data-plugin-chrome="full-bleed"
      data-theme={resolveThemeVariant(theme)}
    >
      {/* Sleek Full-Bleed Top Chrome Bar */}
      <header className="dbx-topbar">
        <div className="dbx-topbar-left">
          <button
            type="button"
            className="dbx-icon-btn"
            aria-label="Toggle explorer"
            aria-pressed={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            <Icon name="panel-left" />
          </button>

          {activeSession ? (
            <div className="dbx-active-conn-pill">
              <EngineIcon engine={activeSession.connection.engine} theme={theme} size={16} />
              <strong>{activeSession.connection.name}</strong>
              <span className="dbx-online-dot" />
              <span className="dbx-muted dbx-mono">{activeSession.activeDatabase}</span>
              {activeSession.info.tlsActive && <span className="dbx-tag dbx-tag-ok">TLS</span>}
              {activeSession.connection.sshTunnel.enabled && <span className="dbx-tag dbx-tag-ssh">SSH</span>}
            </div>
          ) : (
            <span className="dbx-brand-title">
              <Icon name="database" />
              <strong>{t('Database')}</strong>
            </span>
          )}
        </div>

        <div className="dbx-spacer" />

        <div className="dbx-topbar-right">
          {activeSession && isRelationalDriver(activeSession.driver) && (
            <>
              <button
                type="button"
                className="dbx-btn dbx-btn-primary dbx-btn-sm"
                onClick={() => openSqlTab(activeSession.connectionId)}
              >
                <Icon name="plus" />
                {t('New Query')}
              </button>
              <button
                type="button"
                className="dbx-btn dbx-btn-ghost dbx-btn-sm"
                onClick={() =>
                  openErTab(
                    activeSession.connectionId,
                    activeSession.activeDatabase,
                    activeSession.activeSchema,
                  )
                }
              >
                {t('ER Diagram')}
              </button>
              <button
                type="button"
                className="dbx-btn dbx-btn-ghost dbx-btn-sm"
                onClick={() => openSchemaDiffTab(activeSession.connectionId)}
              >
                {t('Schema Diff')}
              </button>
            </>
          )}

          <button
            type="button"
            className="dbx-btn dbx-btn-ghost dbx-btn-sm"
            onClick={() =>
              setDrawer((d) =>
                d.kind === 'history' ? { kind: 'none' } : { kind: 'history', initialTab: 'history' },
              )
            }
          >
            <Icon name="history" />
            {t('History')}
          </button>

          <button
            type="button"
            className="dbx-btn dbx-btn-secondary dbx-btn-sm"
            onClick={() => setDrawer((d) => (d.kind === 'ai' ? { kind: 'none' } : { kind: 'ai' }))}
          >
            <Icon name="sparkles" />
            {t('AI Assistant')}
          </button>
        </div>
      </header>

      {/* Main Split Workspace */}
      <div className="dbx-main-area">
        <PluginSplitPane
          direction="horizontal"
          initialSize={268}
          minSize={200}
          maxSize={460}
          collapsible
          collapsed={sidebarCollapsed}
          onResizeEnd={({ collapsed }) => {
            if (collapsed !== undefined) setSidebarCollapsed(collapsed);
          }}
        >
          {/* Left Pane: Connection Hub & Multi-DB Explorer */}
          <SidebarExplorer
            connections={connections}
            sessions={sessions}
            activeConnectionId={activeConnectionId}
            connectingId={connectingId}
            theme={theme}
            t={t}
            onNewConnection={() => {
              setEditingPassword(undefined);
              setDrawer({ kind: 'connection', editingId: null });
            }}
            onOpenSqliteFile={() => void handleQuickOpenSqliteFile()}
            onConnect={(conn) => void connectTo(conn)}
            onDisconnect={(id) => void disconnectConnection(id)}
            onSelectConnection={(id) => setActiveConnectionId(id)}
            onSwitchDatabase={(id, db) => void handleSwitchDatabase(id, db)}
            onExpandSchema={(id, db, sch) => void loadSchemaForSession(id, db, sch)}
            onExpandTable={(id, db, sch, tbl) => void loadTableStructureForCache(id, db, sch, tbl)}
            onOpenTableData={openTableDataTab}
            onOpenTableStructure={openStructureTab}
            onOpenErDiagram={openErTab}
            onOpenNewQuery={openSqlTab}
            onOpenRedisTab={openRedisTab}
            onOpenMongoCollection={openMongoCollectionTab}
            onOpenCreateTable={(connectionId, database, schema) =>
              setDrawer({ kind: 'createTable', target: { connectionId, database, schema } })
            }
            onDumpSchema={async (connectionId, database, schema, table) => {
              const sess = sessionsRef.current[connectionId];
              if (!sess || !isRelationalDriver(sess.driver)) return;
              try {
                const sql = await sess.driver.dumpDatabaseSql(
                  database,
                  schema,
                  table ? [table] : undefined,
                  true,
                );
                openSchemaDiffTab(connectionId, sql);
              } catch (err) {
                notify('error', err instanceof Error ? err.message : String(err));
              }
            }}
            onExportTable={async (connectionId, database, schema, table) => {
              const sess = sessionsRef.current[connectionId];
              if (!sess || !isRelationalDriver(sess.driver)) return;
              try {
                const res = await sess.driver.browseTable(database, schema, table, { page: 1, pageSize: 1000 });
                await handleExportDataset(
                  table,
                  res.columns.map((c) => c.name),
                  res.rows,
                  engineToSqlDialect(sess.connection.engine),
                  'csv',
                  schema,
                );
              } catch (err) {
                notify('error', err instanceof Error ? err.message : String(err));
              }
            }}
            onTruncateTable={async (connectionId, database, schema, table) => {
              const sess = sessionsRef.current[connectionId];
              if (!sess || !isRelationalDriver(sess.driver)) return;
              setDrawer({
                kind: 'sqlPreview',
                target: {
                  title: `Truncate ${table}`,
                  subtitle: 'Confirm before removing all rows',
                  sql: sess.family === 'sqlite' ? `DELETE FROM "${table}";` : `TRUNCATE TABLE "${schema}"."${table}";`,
                  dialect: engineToSqlDialect(sess.connection.engine),
                  confirmLabel: t('Truncate Table'),
                  onConfirm: async () => {
                    await (sess.driver as RelationalDriver).truncateTable(database, schema, table);
                    notify('success', `Truncated ${table}`);
                    void loadSchemaForSession(connectionId, database, schema, true);
                  },
                },
              });
            }}
            onDropObject={(connectionId, database, schema, name, kind) => {
              const sess = sessionsRef.current[connectionId];
              if (!sess || !isRelationalDriver(sess.driver)) return;
              setDrawer({
                kind: 'sqlPreview',
                target: {
                  title: `Drop ${kind} ${name}`,
                  subtitle: 'Destructive DDL — review carefully before executing',
                  sql: `DROP ${kind.toUpperCase()} "${name}";`,
                  dialect: engineToSqlDialect(sess.connection.engine),
                  confirmLabel: t('Drop Object'),
                  onConfirm: async () => {
                    await (sess.driver as RelationalDriver).dropObject(database, schema, name, kind);
                    notify('success', `Dropped ${kind} ${name}`);
                    void loadSchemaForSession(connectionId, database, schema, true);
                  },
                },
              });
            }}
            onEditConnection={(conn) => void openEditDrawer(conn)}
            onDuplicateConnection={async (conn) => {
              const copy: SavedConnection = {
                ...conn,
                id: uid('conn'),
                name: `${conn.name} (Copy)`,
                hasPassword: false,
                sshTunnel: { ...conn.sshTunnel, hostBindingToken: undefined },
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              await handleSaveConnection(copy, undefined, false);
            }}
            onExportUri={(conn) => void copyText(exportConnectionUri(conn), `${conn.name} URI`)}
            onDeleteConnection={async (conn) => {
              if (sessionsRef.current[conn.id]) {
                await disconnectConnection(conn.id);
              }
              await storage.deletePassword(conn.id);
              await storage.deleteTabDrafts(conn.id);
              const next = connectionsRef.current.filter((c) => c.id !== conn.id);
              setConnections(next);
              await storage.saveConnections(next);
              notify('info', `Deleted ${conn.name}`);
            }}
            onCopyText={(text, label) => void copyText(text, label)}
            onRefreshSchema={(id, db, sch) => void loadSchemaForSession(id, db, sch, true)}
            onOpenContextMenu={(x, y, items) => setContextMenu({ x, y, items })}
          />

          {/* Right Pane: Tabbed IDE Workspace */}
          <section className="dbx-workspace">
            {tabs.length > 0 && (
              <nav className="dbx-tabbar" aria-label="Workspace tabs">
                {tabs.map((tab) => {
                  const isActive = tab.id === activeTabId;
                  return (
                    <div key={tab.id} className={`dbx-tab ${isActive ? 'is-active' : ''}`}>
                      <button
                        type="button"
                        className="dbx-tab-btn"
                        aria-pressed={isActive}
                        onClick={() => {
                          setActiveTabId(tab.id);
                          setActiveConnectionId(tab.connectionId);
                        }}
                      >
                        <Icon name={TAB_ICON[tab.kind]} />
                        <span className="dbx-truncate">{tab.title}</span>
                        {tab.dirty && <span className="dbx-dirty-dot" aria-label="Unsaved changes" />}
                      </button>
                      <button
                        type="button"
                        className="dbx-tab-close"
                        aria-label={`Close ${tab.title}`}
                        onClick={() => closeTab(tab.id)}
                      >
                        <Icon name="x" />
                      </button>
                    </div>
                  );
                })}
                {activeSession && isRelationalDriver(activeSession.driver) && (
                  <button
                    type="button"
                    className="dbx-tab-add"
                    title={t('New Query')}
                    aria-label={t('New Query')}
                    onClick={() => openSqlTab(activeSession.connectionId)}
                  >
                    <Icon name="plus" />
                  </button>
                )}
              </nav>
            )}

            <div className="dbx-workspace-stage">
              {!activeTab || !activeSession ? (
                <WelcomeView
                  connections={connections}
                  connectedIds={connectedIds}
                  connectingId={connectingId}
                  theme={theme}
                  t={t}
                  onNewConnection={() => {
                    setEditingPassword(undefined);
                    setDrawer({ kind: 'connection', editingId: null });
                  }}
                  onOpenSqliteFile={() => void handleQuickOpenSqliteFile()}
                  onLaunchSampleSqlite={() => void handleLaunchSampleSqlite()}
                  onConnect={(conn) => void connectTo(conn)}
                  onEdit={(conn) => void openEditDrawer(conn)}
                />
              ) : activeTab.kind === 'sql' ? (
                <SqlQueryTab
                  tab={activeTab}
                  session={activeSession}
                  completionSchema={activeCompletionSchema}
                  t={t}
                  onUpdateTab={(patch) => updateTab<SqlQueryTabState>(activeTab.id, patch)}
                  onExecute={(sql) => void handleExecuteSqlTab(activeTab.id, sql)}
                  onCancel={() => {
                    if (isRelationalDriver(activeSession.driver)) {
                      void activeSession.driver.cancelQuery().catch(() => {});
                    }
                    updateTab<SqlQueryTabState>(activeTab.id, { running: false });
                  }}
                  onFormat={(sql) =>
                    updateTab<SqlQueryTabState>(activeTab.id, {
                      sql: formatSql(sql, { dialect: activeTab.dialect }),
                      dirty: true,
                    })
                  }
                  onExplain={async (sql, analyze) => {
                    if (!isRelationalDriver(activeSession.driver)) return;
                    updateTab<SqlQueryTabState>(activeTab.id, { running: true });
                    try {
                      const plan = await activeSession.driver.explain(sql, analyze);
                      updateTab<SqlQueryTabState>(activeTab.id, {
                        running: false,
                        explainResult: plan,
                        activeResultTab: 'explain',
                      });
                    } catch (err) {
                      updateTab<SqlQueryTabState>(activeTab.id, {
                        running: false,
                        activeResultTab: 'messages',
                        messages: [
                          ...activeTab.messages,
                          { time: Date.now(), level: 'error', text: err instanceof Error ? err.message : String(err) },
                        ],
                      });
                    }
                  }}
                  onToggleTxMode={() =>
                    updateTab<SqlQueryTabState>(activeTab.id, {
                      txMode: activeTab.txMode === 'auto' ? 'manual' : 'auto',
                    })
                  }
                  onBeginTx={async () => {
                    if (!isRelationalDriver(activeSession.driver)) return;
                    await activeSession.driver.beginTransaction();
                    updateTab<SqlQueryTabState>(activeTab.id, { inTransaction: true });
                    notify('info', 'Transaction started (BEGIN)');
                  }}
                  onCommitTx={async () => {
                    if (!isRelationalDriver(activeSession.driver)) return;
                    await activeSession.driver.commitTransaction();
                    updateTab<SqlQueryTabState>(activeTab.id, { inTransaction: false });
                    notify('success', 'Transaction committed');
                  }}
                  onRollbackTx={async () => {
                    if (!isRelationalDriver(activeSession.driver)) return;
                    await activeSession.driver.rollbackTransaction();
                    updateTab<SqlQueryTabState>(activeTab.id, { inTransaction: false });
                    notify('warning', 'Transaction rolled back');
                  }}
                  onOpenSqlFile={async () => {
                    const res = await context.ui.openFile({
                      title: 'Open SQL Script',
                      filters: [{ name: 'SQL Script', extensions: ['sql', 'txt'] }],
                      readAs: 'utf8',
                    });
                    if (!res.cancelled) {
                      updateTab<SqlQueryTabState>(activeTab.id, {
                        sql: String(res.data),
                        title: res.name,
                        fileName: res.name,
                        fileHandleId: res.handleId,
                        dirty: false,
                      });
                    }
                  }}
                  onSaveSqlFile={async () => {
                    const res = await context.ui.saveFile({
                      title: 'Save SQL Script',
                      defaultName: activeTab.fileName || `${activeTab.title.replace(/\s+/g, '_')}.sql`,
                      filters: [{ name: 'SQL Script', extensions: ['sql'] }],
                      data: activeTab.sql,
                      encoding: 'utf8',
                    });
                    if (!res.cancelled) {
                      updateTab<SqlQueryTabState>(activeTab.id, {
                        title: res.name,
                        fileName: res.name,
                        fileHandleId: res.handleId,
                        dirty: false,
                      });
                      notify('success', `Saved ${res.name}`);
                    }
                  }}
                  onOpenHistory={(initialTab) => setDrawer({ kind: 'history', initialTab })}
                  onOpenAi={() => setDrawer({ kind: 'ai' })}
                  onExportResult={(res: QueryResultSet, fmt: ExportFormat) =>
                    void handleExportDataset(
                      activeTab.title.replace(/\s+/g, '_'),
                      res.columns.map((c) => c.name),
                      res.rows,
                      activeTab.dialect,
                      fmt,
                    )
                  }
                  onInspectCell={(rowIndex, colName, value, rowObj) =>
                    setDrawer({
                      kind: 'inspector',
                      target: {
                        tabId: activeTab.id,
                        rowIndex,
                        colName,
                        value: value as CellValue,
                        rowObject: rowObj as Record<string, CellValue>,
                        editable: false,
                      },
                    })
                  }
                />
              ) : activeTab.kind === 'table' ? (
                <TableDataTab
                  tab={activeTab}
                  session={activeSession}
                  t={t}
                  onUpdateTab={(patch) => updateTab<TableDataTabState>(activeTab.id, patch)}
                  onReload={(opts) => void reloadTableTab(activeTab.id, opts)}
                  onOpenStructure={() =>
                    openStructureTab(
                      activeTab.connectionId,
                      activeTab.database,
                      activeTab.schema,
                      activeTab.table,
                    )
                  }
                  onOpenImport={() =>
                    setDrawer({
                      kind: 'import',
                      target: {
                        tabId: activeTab.id,
                        connectionId: activeTab.connectionId,
                        database: activeTab.database,
                        schema: activeTab.schema,
                        table: activeTab.table,
                        structure: activeTab.structure,
                      },
                    })
                  }
                  onExportData={(fmt) =>
                    void handleExportDataset(
                      activeTab.table,
                      activeTab.columns.map((c) => c.name),
                      activeTab.rows,
                      engineToSqlDialect(activeSession.connection.engine),
                      fmt,
                      activeTab.schema,
                    )
                  }
                  onPreviewChanges={() => {
                    const preview = buildTableBatchPreview(activeTab, activeSession);
                    if (!preview) return;
                    setDrawer({
                      kind: 'sqlPreview',
                      target: {
                        title: `Pending Changes: ${activeTab.table}`,
                        subtitle: `+${preview.insertCount} insert · ~${preview.updateCount} update · -${preview.deleteCount} delete`,
                        sql: preview.sql || '-- No SQL statements generated',
                        dialect: preview.dialect,
                        confirmLabel: t('Commit'),
                        onConfirm: async () => {
                          await (activeSession.driver as RelationalDriver).applyBatchMutations(preview.statements);
                          notify('success', `Committed ${preview.statements.length} changes to ${activeTab.table}`);
                          await reloadTableTab(activeTab.id);
                        },
                      },
                    });
                  }}
                  onCommitChanges={async () => {
                    const preview = buildTableBatchPreview(activeTab, activeSession);
                    if (!preview || preview.statements.length === 0) return;
                    try {
                      await (activeSession.driver as RelationalDriver).applyBatchMutations(preview.statements);
                      notify('success', `Committed ${preview.statements.length} changes`);
                      await reloadTableTab(activeTab.id);
                    } catch (err) {
                      notify('error', err instanceof Error ? err.message : String(err));
                    }
                  }}
                  onDiscardChanges={() =>
                    updateTab<TableDataTabState>(activeTab.id, {
                      dirtyCells: {},
                      insertedRows: [],
                      deletedRowIndices: [],
                      dirty: false,
                    })
                  }
                  onInspectCell={(rowIndex, colName, value, rowObj) =>
                    setDrawer({
                      kind: 'inspector',
                      target: {
                        tabId: activeTab.id,
                        rowIndex,
                        colName,
                        value,
                        rowObject: rowObj,
                        editable: activeSession.family !== 'clickhouse',
                      },
                    })
                  }
                  onCopyText={(text, label) => void copyText(text, label)}
                  onCopyRowAsSql={(rowObj) => {
                    const cols = Object.keys(rowObj);
                    const sql = exportSqlInserts(
                      activeTab.table,
                      cols,
                      [cols.map((c) => rowObj[c] ?? null)],
                      engineToSqlDialect(activeSession.connection.engine),
                      { schema: activeTab.schema },
                    );
                    void copyText(sql, 'SQL INSERT');
                  }}
                  onSaveSqliteFile={
                    activeSession.family === 'sqlite'
                      ? () => void handleSaveSqliteFile(activeSession.connectionId)
                      : undefined
                  }
                  onOpenContextMenu={(x, y, items) => setContextMenu({ x, y, items })}
                />
              ) : activeTab.kind === 'structure' ? (
                <StructureDesignerTab
                  tab={activeTab}
                  session={activeSession}
                  t={t}
                  onUpdateTab={(patch) => updateTab<StructureDesignerTabState>(activeTab.id, patch)}
                  onReload={() => void reloadStructureTab(activeTab.id)}
                  onPreviewAlter={(diff: TableStructureDiff) => {
                    if (!isRelationalDriver(activeSession.driver)) return;
                    const stmts =
                      activeSession.driver instanceof SqliteDriver
                        ? activeSession.driver.generateAlterTableDdl(
                            activeTab.database,
                            activeTab.schema,
                            activeTab.table,
                            diff,
                            activeTab.structure ?? undefined,
                          )
                        : activeSession.driver.generateAlterTableDdl(
                            activeTab.database,
                            activeTab.schema,
                            activeTab.table,
                            diff,
                          );
                    setDrawer({
                      kind: 'sqlPreview',
                      target: {
                        title: `ALTER TABLE ${activeTab.table}`,
                        subtitle: `${stmts.length} DDL statement(s)`,
                        sql: stmts.join('\n\n') || '-- No DDL changes',
                        dialect: engineToSqlDialect(activeSession.connection.engine),
                        confirmLabel: t('Apply Changes'),
                        onConfirm: async () => {
                          await (activeSession.driver as RelationalDriver).applyBatchMutations(stmts);
                          updateTab<StructureDesignerTabState>(activeTab.id, { pendingDiff: {}, dirty: false });
                          notify('success', `Altered table ${activeTab.table}`);
                          await reloadStructureTab(activeTab.id);
                          void loadSchemaForSession(activeTab.connectionId, activeTab.database, activeTab.schema, true);
                        },
                      },
                    });
                  }}
                  onApplyAlter={async (diff: TableStructureDiff) => {
                    if (!isRelationalDriver(activeSession.driver)) return;
                    updateTab<StructureDesignerTabState>(activeTab.id, { applying: true, error: undefined });
                    try {
                      const stmts =
                        activeSession.driver instanceof SqliteDriver
                          ? activeSession.driver.generateAlterTableDdl(
                              activeTab.database,
                              activeTab.schema,
                              activeTab.table,
                              diff,
                              activeTab.structure ?? undefined,
                            )
                          : activeSession.driver.generateAlterTableDdl(
                              activeTab.database,
                              activeTab.schema,
                              activeTab.table,
                              diff,
                            );
                      await activeSession.driver.applyBatchMutations(stmts);
                      const nextTableName = diff.renameTableTo || activeTab.table;
                      updateTab<StructureDesignerTabState>(activeTab.id, {
                        applying: false,
                        table: nextTableName,
                        title: `${nextTableName} (Structure)`,
                        pendingDiff: {},
                        dirty: false,
                      });
                      notify('success', `Updated structure for ${nextTableName}`);
                      setTimeout(() => void reloadStructureTab(activeTab.id), 0);
                      void loadSchemaForSession(activeTab.connectionId, activeTab.database, activeTab.schema, true);
                    } catch (err) {
                      updateTab<StructureDesignerTabState>(activeTab.id, {
                        applying: false,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  onOpenData={() =>
                    openTableDataTab(
                      activeTab.connectionId,
                      activeTab.database,
                      activeTab.schema,
                      activeTab.table,
                    )
                  }
                />
              ) : activeTab.kind === 'er' ? (
                <ErDiagramTab
                  tab={activeTab}
                  t={t}
                  onUpdateTab={(patch) => updateTab<ErDiagramTabState>(activeTab.id, patch)}
                  onReload={() => void reloadErTab(activeTab.id)}
                  onDumpSql={async () => {
                    if (!isRelationalDriver(activeSession.driver)) return;
                    try {
                      const sql = await activeSession.driver.dumpDatabaseSql(
                        activeTab.database,
                        activeTab.schema,
                        undefined,
                        true,
                      );
                      openSchemaDiffTab(activeTab.connectionId, sql);
                    } catch (err) {
                      notify('error', err instanceof Error ? err.message : String(err));
                    }
                  }}
                  onOpenSchemaDiff={() => openSchemaDiffTab(activeTab.connectionId)}
                  onOpenTableData={(table, sch) =>
                    openTableDataTab(activeTab.connectionId, activeTab.database, sch ?? activeTab.schema, table)
                  }
                  onOpenTableStructure={(table, sch) =>
                    openStructureTab(activeTab.connectionId, activeTab.database, sch ?? activeTab.schema, table)
                  }
                />
              ) : activeTab.kind === 'redis' && isRedisDriver(activeSession.driver) ? (
                <RedisWorkbenchTab
                  tab={activeTab}
                  driver={activeSession.driver as RedisDriver}
                  t={t}
                  onUpdateTab={(patch) => updateTab<RedisWorkbenchTabState>(activeTab.id, patch)}
                  onScan={(opts) => scanRedisTab(activeTab.id, opts)}
                  onSelectKey={async (key) => {
                    updateTab<RedisWorkbenchTabState>(activeTab.id, { selectedKey: key });
                    try {
                      const detail = await (activeSession.driver as RedisDriver).getKeyDetail(key);
                      updateTab<RedisWorkbenchTabState>(activeTab.id, { keyDetail: detail });
                    } catch (err) {
                      notify('error', err instanceof Error ? err.message : String(err));
                    }
                  }}
                  onNotify={notify}
                />
              ) : activeTab.kind === 'mongo' && isMongoDriver(activeSession.driver) ? (
                <MongoWorkbenchTab
                  tab={activeTab}
                  driver={activeSession.driver as MongoDriver}
                  t={t}
                  onUpdateTab={(patch) => updateTab<MongoWorkbenchTabState>(activeTab.id, patch)}
                  onRun={() => runMongoTab(activeTab.id)}
                  onReloadIndexes={async () => {
                    try {
                      const indexes = await (activeSession.driver as MongoDriver).listIndexes(
                        activeTab.database,
                        activeTab.collection,
                      );
                      updateTab<MongoWorkbenchTabState>(activeTab.id, { indexes });
                    } catch (err) {
                      notify('error', err instanceof Error ? err.message : String(err));
                    }
                  }}
                  onNotify={notify}
                />
              ) : activeTab.kind === 'diff' && isRelationalDriver(activeSession.driver) ? (
                <SchemaDiffTab
                  tab={activeTab}
                  session={activeSession}
                  t={t}
                  onUpdateTab={(patch) => updateTab<SchemaDiffTabState>(activeTab.id, patch)}
                  onRunDiff={async () => {
                    const drv = activeSession.driver as RelationalDriver;
                    updateTab<SchemaDiffTabState>(activeTab.id, { loading: true, error: undefined });
                    try {
                      const loadSnap = async (sch: string): Promise<SchemaSnapshot> => {
                        const tbls = await drv.listTables(activeTab.database, sch);
                        const structs = await Promise.all(
                          tbls.map((tb) => drv.getTableStructure(activeTab.database, sch, tb.name)),
                        );
                        return {
                          dialect: engineToSqlDialect(activeSession.connection.engine),
                          database: activeTab.database,
                          schema: sch,
                          tables: structs,
                        };
                      };
                      const [leftSnap, rightSnap] = await Promise.all([
                        loadSnap(activeTab.leftSchema),
                        loadSnap(activeTab.rightSchema),
                      ]);
                      const diffResult = drv.diffSchemas(leftSnap, rightSnap);
                      updateTab<SchemaDiffTabState>(activeTab.id, { loading: false, diffResult });
                    } catch (err) {
                      updateTab<SchemaDiffTabState>(activeTab.id, {
                        loading: false,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  onRunDump={async () => {
                    const drv = activeSession.driver as RelationalDriver;
                    updateTab<SchemaDiffTabState>(activeTab.id, { loading: true, error: undefined });
                    try {
                      const dumpSql = await drv.dumpDatabaseSql(
                        activeTab.database,
                        activeTab.leftSchema,
                        undefined,
                        activeTab.includeData,
                      );
                      updateTab<SchemaDiffTabState>(activeTab.id, {
                        loading: false,
                        diffResult: null,
                        dumpSql,
                      });
                    } catch (err) {
                      updateTab<SchemaDiffTabState>(activeTab.id, {
                        loading: false,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  onSaveSql={async (sql, defaultName) => {
                    const res = await context.ui.saveFile({
                      title: 'Save SQL File',
                      defaultName,
                      filters: [{ name: 'SQL Script', extensions: ['sql'] }],
                      data: sql,
                      encoding: 'utf8',
                    });
                    if (!res.cancelled) notify('success', `Saved ${res.name}`);
                  }}
                  onOpenInQuery={(sql) => openSqlTab(activeTab.connectionId, sql, 'Migration / Dump')}
                />
              ) : null}
            </div>
          </section>
        </PluginSplitPane>

        {/* Right Slide-Over Drawers (AsidePanel style, never destroying active tabs) */}
        {drawer.kind !== 'none' && (
          <div className="dbx-drawer-layer">
            {drawer.kind === 'connection' && (
              <ConnectionDrawer
                context={context}
                theme={theme}
                t={t}
                editingConnection={
                  drawer.editingId ? connections.find((c) => c.id === drawer.editingId) ?? null : null
                }
                initialEngine={drawer.initialEngine}
                initialPassword={editingPassword}
                onClose={() => setDrawer({ kind: 'none' })}
                onSave={handleSaveConnection}
              />
            )}

            {drawer.kind === 'ai' && (
              <AiAssistantDrawer
                context={context}
                session={activeSession}
                currentSql={activeTab?.kind === 'sql' ? activeTab.sql : ''}
                t={t}
                onInsertSql={(sql) => {
                  if (activeTab?.kind === 'sql') {
                    updateTab<SqlQueryTabState>(activeTab.id, { sql, dirty: true });
                  } else if (activeSession) {
                    openSqlTab(activeSession.connectionId, sql, 'AI Query');
                  }
                  notify('success', 'Inserted SQL into editor');
                }}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}

            {drawer.kind === 'history' && (
              <HistorySnippetsDrawer
                initialTab={drawer.initialTab}
                history={history}
                snippets={snippets}
                currentSql={activeTab?.kind === 'sql' ? activeTab.sql : ''}
                currentDialect={
                  activeTab?.kind === 'sql'
                    ? activeTab.dialect
                    : activeSession
                      ? engineToSqlDialect(activeSession.connection.engine)
                      : 'postgres'
                }
                t={t}
                onInsertSql={(sql) => {
                  if (activeTab?.kind === 'sql') {
                    updateTab<SqlQueryTabState>(activeTab.id, { sql, dirty: true });
                  } else if (activeSession) {
                    openSqlTab(activeSession.connectionId, sql);
                  }
                  setDrawer({ kind: 'none' });
                }}
                onOpenNewQuery={(sql) => {
                  if (activeSession) openSqlTab(activeSession.connectionId, sql);
                  setDrawer({ kind: 'none' });
                }}
                onSaveSnippet={(title, sql, tags) => {
                  const next: SavedSnippet[] = [
                    {
                      id: uid('snip'),
                      title,
                      sql,
                      dialect: activeTab?.kind === 'sql' ? activeTab.dialect : 'all',
                      tags,
                      updatedAt: Date.now(),
                    },
                    ...snippets,
                  ];
                  setSnippets(next);
                  void storage.saveSnippets(next);
                  notify('success', `Saved snippet: ${title}`);
                }}
                onDeleteSnippet={(id) => {
                  const next = snippets.filter((s) => s.id !== id);
                  setSnippets(next);
                  void storage.saveSnippets(next);
                }}
                onClearHistory={() => {
                  setHistory([]);
                  void storage.clearHistory();
                }}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}

            {drawer.kind === 'inspector' && (
              <CellInspectorDrawer
                target={drawer.target}
                t={t}
                onCopy={(text, label) => void copyText(text, label)}
                onSaveCell={(rowIndex, colName, value, isNull) => {
                  const targetTab = tabsRef.current.find(
                    (item): item is TableDataTabState => item.id === drawer.target.tabId && item.kind === 'table',
                  );
                  if (!targetTab) return;
                  const key = `${rowIndex}:${colName}`;
                  updateTab<TableDataTabState>(targetTab.id, {
                    dirtyCells: { ...targetTab.dirtyCells, [key]: isNull ? null : value },
                    dirty: true,
                  });
                }}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}

            {drawer.kind === 'sqlPreview' && (
              <SqlPreviewDrawer
                target={drawer.target}
                t={t}
                onCopy={(text, label) => void copyText(text, label)}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}

            {drawer.kind === 'import' && sessions[drawer.target.connectionId] && (
              <ImportWizardDrawer
                context={context}
                target={drawer.target}
                session={sessions[drawer.target.connectionId]}
                t={t}
                onImported={() => {
                  notify('success', `Imported data into ${drawer.target.table}`);
                  void reloadTableTab(drawer.target.tabId);
                }}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}

            {drawer.kind === 'createTable' && sessions[drawer.target.connectionId] && (
              <CreateTableDrawer
                target={drawer.target}
                session={sessions[drawer.target.connectionId]}
                t={t}
                onCreated={(tableName) => {
                  notify('success', `Created table ${tableName}`);
                  void loadSchemaForSession(
                    drawer.target.connectionId,
                    drawer.target.database,
                    drawer.target.schema,
                    true,
                  );
                }}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}
          </div>
        )}
      </div>

      {/* Global Right-Click Context Menu (`PluginPopover` at cursor X/Y) */}
      <PluginPopover
        anchorX={contextMenu?.x}
        anchorY={contextMenu?.y}
        width={220}
        open={Boolean(contextMenu)}
        onClose={() => setContextMenu(null)}
      >
        <div className="dbx-menu-list" role="menu">
          {(contextMenu?.items ?? []).map((item: ContextMenuItem) => (
            <React.Fragment key={item.id}>
              {item.dividerBefore && <div className="dbx-menu-sep" />}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`dbx-menu-item ${item.danger ? 'is-danger' : ''}`}
                onClick={() => {
                  setContextMenu(null);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      </PluginPopover>

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="dbx-toast-stack" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`dbx-toast dbx-toast-${toast.level}`}>
              <span>{toast.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Compact Bottom Status Strip */}
      <footer className="dbx-statusbar dbx-mono">
        {activeSession ? (
          <>
            <span className="dbx-status-item">
              <span className="dbx-online-dot" />
              {`${activeSession.connection.name} (${activeSession.info.serverVersion})`}
            </span>
            <span>{activeSession.info.tlsActive ? 'TLS encrypted' : 'Plain TCP / Local'}</span>
            {activeSession.connection.sshTunnel.enabled && (
              <span>{`SSH Tunnel: ${activeSession.connection.sshTunnel.hostLabel || 'Vault Host'}`}</span>
            )}
          </>
        ) : (
          <span>{t('Disconnected')}</span>
        )}
        <span className="dbx-spacer" />
        <span>{`${Object.keys(sessions).length} active · ${connections.length} saved`}</span>
      </footer>
    </main>
  );
}
