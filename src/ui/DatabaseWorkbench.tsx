/**
 * Top-Level Multi-Database Database IDE Shell (v0.3.0 — `data-plugin-chrome="full-bleed"`).
 * Orchestrates:
 * - Multi-connection sessions across PostgreSQL, MySQL/MariaDB, SQLite, ClickHouse, Redis, MongoDB
 * - Global keyboard shortcuts (`usePluginShortcuts` + per-widget `onShortcut`) & Cmd/Ctrl+K Command Palette (P0-3)
 * - Read-Only Safe Mode + Destructive SQL risk confirmation guard (`classifySqlRisk`) (P0-2)
 * - Parameterized SQL prompt (`extractSqlParameters` / `bindSqlParameters`) + QueryError line/col diagnostics (P0-6)
 * - Inline FK jump (`onFkJump`), Undo/Redo, Visual Filter Builder, Column Visibility Picker (P0-4, P0-5)
 * - Dedicated Object Definition Viewer tabs for Views, Routines, Triggers (P0-1, P0-7)
 * - Cross-connection Schema Diff / Dump / Restore / Data Transfer (P0-8)
 * - Redis SCAN Load More, Info Dashboard, Pub/Sub & MongoDB EJSON, Pagination, Schema Analyzer (P0-9)
 * - SQLite dirty-state indicator + 1-click Save & Save As in topbar (P0-10)
 * - Flex-docked right drawers (P1-1), AI Error Fix (P1-2), Tab Context Menu + env color dots (P1-3)
 * - Connections JSON / DBeaver Import & Export + Reconnect banner (P1-5)
 * - ER Diagram SVG Export (P1-6) & 100% EN / zh-CN localization (P1-7)
 */

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import {
  PluginPopover,
  PluginSplitPane,
  usePluginShortcuts,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon, type IconName } from '../Icon';
import {
  QueryError,
  type BatchRowDelete,
  type BatchRowInsert,
  type BatchRowUpdate,
  type CellValue,
  type GraphDriver,
  type KvDriver,
  type KvEntry,
  type MongoDriver,
  type QueryResultSet,
  type RedisDriver,
  type RelationalDriver,
  type SchemaSnapshot,
  type SearchDriver,
  type SqlDialect,
  type TableStructure,
  type TableStructureDiff,
} from '../drivers/types';
import { buildDropObjectSql, quoteIdent, quoteSqlLiteral } from '../drivers/sqlDialect';
import { classifySqlRisk } from '../sql/riskClassifier';
import { formatSql } from '../sql/formatter';
import { extractSqlParameters } from '../sql/parameters';
import { exportConnectionsJson, importConnectionsJson } from './connectionTransfer';
import { hasPendingGridEdits, pushGridUndo, redoGridEdit, undoGridEdit } from './gridHistory';
import { createUiTranslator } from './i18n';
import {
  buildCompletionSchemaForSession,
  engineToSqlDialect,
  isBiSupportedDriver,
  isGraphDriver,
  isKvDriver,
  isMongoDriver,
  isMqDriver,
  isRedisDriver,
  isRelationalDriver,
  isSearchDriver,
  loadSchemaObjects,
  makeDefaultConnection,
  openSavedConnectionSession,
  schemaCacheKey,
  type ModalBridge,
} from './sessionManager';
import { WorkbenchStorage } from './storage';
import type {
  ActiveSession,
  BiAnalyticsTabState,
  ContextMenuItem,
  ContextMenuState,
  ErDiagramTabState,
  GraphWorkbenchTabState,
  KvWorkbenchTabState,
  MongoWorkbenchTabState,
  MqWorkbenchTabState,
  ObjectDefTabState,
  PersistedTabDraft,
  QueryHistoryEntry,
  RedisWorkbenchTabState,
  RightDrawerState,
  SavedConnection,
  SavedSnippet,
  SchemaDiffTabState,
  SearchWorkbenchTabState,
  SqlQueryTabState,
  StructureDesignerTabState,
  TableDataTabState,
  ToastNotice,
  WorkspaceTab,
} from './types';
import type {
  BiAnalysisCard,
  BiChartConfig,
  BiExportPngDetail,
  BiExportSvgDetail,
} from '../bi/types';
import { exportConnectionUri } from './uriParser';
import type { CommandPaletteItem } from './components/CommandPalette';
import { EngineIcon, EnvColorDot, resolveThemeVariant } from './components/EngineBadge';
import { SidebarExplorer } from './components/SidebarExplorer';
import type { ExportFormat } from './components/SqlQueryTab';
import { WelcomeView } from './components/WelcomeView';

// Lazy-loaded heavy tabs & drawers — keeps initial browser.js lean for instant first paint.
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })));
const ConnectionDrawer = lazy(() => import('./components/ConnectionDrawer').then((m) => ({ default: m.ConnectionDrawer })));
const SqlQueryTab = lazy(() => import('./components/SqlQueryTab').then((m) => ({ default: m.SqlQueryTab })));
const TableDataTab = lazy(() => import('./components/TableDataTab').then((m) => ({ default: m.TableDataTab })));
const StructureDesignerTab = lazy(() => import('./components/StructureDesignerTab').then((m) => ({ default: m.StructureDesignerTab })));
const ObjectDefTab = lazy(() => import('./components/ObjectDefTab').then((m) => ({ default: m.ObjectDefTab })));
const ErDiagramTab = lazy(() => import('./components/ErDiagramTab').then((m) => ({ default: m.ErDiagramTab })));
const BiAnalyticsTab = lazy(() => import('./components/BiAnalyticsTab').then((m) => ({ default: m.BiAnalyticsTab })));
const RedisWorkbenchTab = lazy(() => import('./components/RedisWorkbenchTab').then((m) => ({ default: m.RedisWorkbenchTab })));
const MongoWorkbenchTab = lazy(() => import('./components/MongoWorkbenchTab').then((m) => ({ default: m.MongoWorkbenchTab })));
const GraphWorkbenchTab = lazy(() => import('./components/GraphWorkbenchTab').then((m) => ({ default: m.GraphWorkbenchTab })));
const SearchWorkbenchTab = lazy(() => import('./components/SearchWorkbenchTab').then((m) => ({ default: m.SearchWorkbenchTab })));
const KvWorkbenchTab = lazy(() => import('./components/KvWorkbenchTab').then((m) => ({ default: m.KvWorkbenchTab })));
const MqWorkbenchTab = lazy(() => import('./components/MqWorkbenchTab').then((m) => ({ default: m.MqWorkbenchTab })));
const SchemaDiffTab = lazy(() => import('./components/SchemaDiffTab').then((m) => ({ default: m.SchemaDiffTab })));
const ServerMonitorTab = lazy(() => import('./components/ServerMonitorTab').then((m) => ({ default: m.ServerMonitorTab })));
const UserAdminTab = lazy(() => import('./components/UserAdminTab').then((m) => ({ default: m.UserAdminTab })));
const DataCompareTab = lazy(() => import('./components/DataCompareTab').then((m) => ({ default: m.DataCompareTab })));
const DoltVersionTab = lazy(() => import('./components/DoltVersionTab').then((m) => ({ default: m.DoltVersionTab })));
const MockDataDrawer = lazy(() => import('./components/MockDataDrawer').then((m) => ({ default: m.MockDataDrawer })));
const DocsAndModelDrawer = lazy(() => import('./components/DocsAndModelDrawer').then((m) => ({ default: m.DocsAndModelDrawer })));
const GlobalSearchDrawer = lazy(() => import('./components/GlobalSearchDrawer').then((m) => ({ default: m.GlobalSearchDrawer })));

const AiAssistantDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.AiAssistantDrawer })));
const CellInspectorDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.CellInspectorDrawer })));
const ConfirmSqlDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.ConfirmSqlDrawer })));
const CreateCollectionDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.CreateCollectionDrawer })));
const CreateTableDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.CreateTableDrawer })));
const HistorySnippetsDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.HistorySnippetsDrawer })));
const ImportWizardDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.ImportWizardDrawer })));
const SqlParameterDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.SqlParameterDrawer })));
const SqlPreviewDrawer = lazy(() => import('./components/AuxDrawers').then((m) => ({ default: m.SqlPreviewDrawer })));

function isSqliteExportableDriver(
  drv: unknown,
): drv is RelationalDriver & {
  exportBytes: () => Uint8Array;
  generateAlterTableDdl: (
    db: string,
    schema: string,
    table: string,
    diff: TableStructureDiff,
    currentStructure?: TableStructure,
  ) => string[];
} {
  return Boolean(drv && typeof drv === 'object' && 'exportBytes' in drv && typeof (drv as { exportBytes?: unknown }).exportBytes === 'function');
}

const TAB_ICON: Record<WorkspaceTab['kind'], IconName> = {
  sql: 'file-code',
  table: 'table',
  structure: 'settings',
  er: 'database',
  bi: 'bar-chart-2',
  redis: 'key',
  mongo: 'folder',
  graph: 'sparkles',
  search: 'search',
  kv: 'key',
  mq: 'server',
  diff: 'book-open',
  objectDef: 'eye',
  monitor: 'server',
  users: 'shield',
  dataCompare: 'book-open',
  dolt: 'history',
  powerTools: 'settings',
};

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function isDisconnectError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('connection is closed') ||
    msg.includes('eof') ||
    msg.includes('econnreset') ||
    msg.includes('epipe') ||
    msg.includes('broken pipe') ||
    msg.includes('socket closed') ||
    msg.includes('stream closed')
  );
}

export interface DatabaseWorkbenchProps {
  context: PluginContext;
  modalBridge: ModalBridge;
}

export function DatabaseWorkbench({ context, modalBridge }: DatabaseWorkbenchProps) {
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
  const [pinnedTabIds, setPinnedTabIds] = useState<string[]>([]);
  const [recentlyClosedTabs, setRecentlyClosedTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [drawer, setDrawer] = useState<RightDrawerState>({ kind: 'none' });
  const [editingPassword, setEditingPassword] = useState<string | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [toasts, setToasts] = useState<ToastNotice[]>([]);

  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
  const [snippets, setSnippets] = useState<SavedSnippet[]>([]);

  // Refs kept synchronously up-to-date for immediate follow-up callbacks
  const sqliteBytesRef = useRef<Map<string, Uint8Array>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const notify = useCallback((level: ToastNotice['level'], message: string) => {
    const id = uid('toast');
    setToasts((prev) => [...prev.slice(-2), { id, level, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4000);
  }, []);

  const updateSession = useCallback((connectionId: string, updater: (cur: ActiveSession) => ActiveSession) => {
    const cur = sessionsRef.current[connectionId];
    if (!cur) return;
    const nextSess = updater(cur);
    sessionsRef.current = { ...sessionsRef.current, [connectionId]: nextSess };
    setSessions((prev) => {
      const prevCur = prev[connectionId];
      if (!prevCur) return prev;
      return { ...prev, [connectionId]: updater(prevCur) };
    });
  }, []);

  const markSqliteDirty = useCallback(
    (connectionId: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || sess.family !== 'sqlite') return;
      updateSession(connectionId, (cur) => ({ ...cur, sqliteDirty: true }));
    },
    [updateSession],
  );

  const checkDisconnect = useCallback(
    (connectionId: string, err: unknown) => {
      if (isDisconnectError(err)) {
        updateSession(connectionId, (cur) => ({ ...cur, disconnected: true }));
      }
    },
    [updateSession],
  );

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
    activeTabIdRef.current = tab.id;
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

  // Persist durable SSH tunnel binding token
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

  // Toggle Read-Only Safe Mode on active connection
  const handleToggleReadOnly = useCallback(
    (connectionId: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess) return;
      const nextRo = !sess.connection.readOnly;
      const updatedConn: SavedConnection = { ...sess.connection, readOnly: nextRo, updatedAt: Date.now() };
      updateSession(connectionId, (cur) => ({ ...cur, connection: updatedConn }));
      setConnections((prev) => {
        const next = prev.map((c) => (c.id === connectionId ? updatedConn : c));
        void storage.saveConnections(next);
        return next;
      });
      notify(nextRo ? 'warning' : 'info', `${updatedConn.name}: ${nextRo ? t('Read-Only Mode') : 'Read/Write'}`);
    },
    [notify, storage, t, updateSession],
  );

  // Lazy load schema objects
  const loadSchemaForSession = useCallback(
    async (connectionId: string, database: string, schema: string, force = false) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return;
      const key = schemaCacheKey(database, schema);
      if (!force && sess.objectsBySchema[key]?.loaded) return;

      updateSession(connectionId, (cur) => ({
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
      }));

      try {
        const objects = await loadSchemaObjects(sess.driver, database, schema);
        updateSession(connectionId, (cur) => ({
          ...cur,
          objectsBySchema: { ...cur.objectsBySchema, [key]: objects },
        }));
      } catch (err) {
        checkDisconnect(connectionId, err);
        notify('error', err instanceof Error ? err.message : String(err));
      }
    },
    [checkDisconnect, notify, updateSession],
  );

  const loadTableStructureForCache = useCallback(
    async (connectionId: string, database: string, schema: string, table: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return null;
      const key = schemaCacheKey(database, schema);
      try {
        const struct = await sess.driver.getTableStructure(database, schema, table);
        updateSession(connectionId, (cur) => {
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
            ...cur,
            objectsBySchema: {
              ...cur.objectsBySchema,
              [key]: {
                ...existing,
                structures: { ...existing.structures, [table]: struct },
              },
            },
          };
        });
        return struct;
      } catch (err) {
        checkDisconnect(connectionId, err);
        return null;
      }
    },
    [checkDisconnect, updateSession],
  );

  // Open SQL query tab
  const openSqlTab = useCallback(
    (connectionId: string, initialSql = '', customTitle?: string): string | undefined => {
      const sess = sessionsRef.current[connectionId];
      if (!sess) return undefined;
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
        resultFilter: '',
        resultSort: null,
        explainViewMode: 'tree',
        messages: [],
        explainResult: null,
        diagnostics: [],
        serverDiagnostics: [],
        lastParamValues: {},
      };
      appendTab(tab);
      return tab.id;
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
          whereClause,
          appliedWhere: whereClause,
          sort,
          dirtyCells: {},
          insertedRows: [],
          deletedRowIndices: [],
          selectedRowIndices: [],
          undoStack: [],
          redoStack: [],
          dirty: false,
        });
      } catch (err) {
        checkDisconnect(tab.connectionId, err);
        updateTab<TableDataTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [checkDisconnect, loadTableStructureForCache, updateTab],
  );

  // Open Table Data tab (with optional initial WHERE for FK jump!)
  const openTableDataTab = useCallback(
    (connectionId: string, database: string, schema: string, table: string, initialWhere?: string) => {
      const existing = tabsRef.current.find(
        (item): item is TableDataTabState =>
          item.kind === 'table' &&
          item.connectionId === connectionId &&
          item.database === database &&
          item.schema === schema &&
          item.table === table,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        setActiveConnectionId(connectionId);
        if (initialWhere !== undefined) {
          updateTab<TableDataTabState>(existing.id, { whereClause: initialWhere });
          void reloadTableTab(existing.id, { page: 1, whereClause: initialWhere });
        }
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
        whereClause: initialWhere ?? '',
        appliedWhere: initialWhere ?? '',
        filterRules: [],
        showFilterBuilder: false,
        hiddenColumns: [],
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
        undoStack: [],
        redoStack: [],
      };
      appendTab(tab);
      setTimeout(() => void reloadTableTab(tab.id, initialWhere !== undefined ? { page: 1, whereClause: initialWhere } : undefined), 0);
    },
    [appendTab, reloadTableTab, updateTab],
  );

  // Open Object Definition tab (View / Materialized View / Routine / Trigger / Sequence / Event / Type / Extension / Synonym)
  const openObjectDefTab = useCallback(
    (
      connectionId: string,
      obj: {
        objectKind: ObjectDefTabState['objectKind'];
        database: string;
        schema: string;
        name: string;
        tableName?: string;
        returnType?: string;
        arguments?: string;
        language?: string;
        timing?: string;
        event?: string;
        enabled?: boolean;
        definition: string;
      },
    ) => {
      const existing = tabsRef.current.find(
        (item): item is ObjectDefTabState =>
          item.kind === 'objectDef' &&
          item.connectionId === connectionId &&
          item.objectKind === obj.objectKind &&
          item.schema === obj.schema &&
          item.name === obj.name,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        setActiveConnectionId(connectionId);
        return;
      }
      const tabId = uid('def');
      const tab: ObjectDefTabState = {
        id: tabId,
        connectionId,
        kind: 'objectDef',
        title: `${obj.name} (${obj.objectKind})`,
        ...obj,
      };
      appendTab(tab);

      // Hydrate full DDL (e.g. SHOW CREATE PROCEDURE/EVENT) & Object Dependencies asynchronously
      const sess = sessionsRef.current[connectionId];
      if (sess && isRelationalDriver(sess.driver)) {
        const drv = sess.driver;
        void (async () => {
          const [fullDef, deps] = await Promise.all([
            drv.getObjectDefinition
              ? drv.getObjectDefinition(obj.database, obj.schema, obj.name, obj.objectKind).catch(() => '')
              : Promise.resolve(''),
            drv.listObjectDependencies
              ? drv.listObjectDependencies(obj.database, obj.schema, obj.name, obj.objectKind).catch(() => [])
              : Promise.resolve([]),
          ]);
          const patch: Partial<ObjectDefTabState> = {};
          if (fullDef && fullDef.trim()) patch.definition = fullDef;
          if (deps.length > 0) patch.dependencies = deps;
          if (Object.keys(patch).length > 0) {
            updateTab<ObjectDefTabState>(tabId, patch);
          }
        })();
      }
    },
    [appendTab, updateTab],
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
        const [structure, allTriggers, partitions] = await Promise.all([
          sess.driver.getTableStructure(tab.database, tab.schema, tab.table),
          sess.driver.listTriggers(tab.database, tab.schema).catch(() => []),
          sess.driver.listTablePartitions
            ? sess.driver.listTablePartitions(tab.database, tab.schema, tab.table).catch(() => [])
            : Promise.resolve([]),
        ]);
        const tableTriggers = allTriggers.filter((tr) => tr.tableName === tab.table);
        updateTab<StructureDesignerTabState>(tabId, {
          loading: false,
          structure,
          triggers: tableTriggers,
          partitions,
        });
      } catch (err) {
        checkDisconnect(tab.connectionId, err);
        updateTab<StructureDesignerTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [checkDisconnect, updateTab],
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
        activeTabIdRef.current = existing.id;
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
        checkDisconnect(tab.connectionId, err);
        updateTab<ErDiagramTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [checkDisconnect, updateTab],
  );

  const openErTab = useCallback(
    (connectionId: string, database: string, schema: string) => {
      const existing = tabsRef.current.find(
        (item): item is ErDiagramTabState =>
          item.kind === 'er' && item.connectionId === connectionId && item.schema === schema,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
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

  // BI Analytics Studio Tab (lazy-loaded + persistent per-connection dashboard)
  const openBiTab = useCallback(
    async (
      connectionId: string,
      opts?: {
        pinChart?: {
          title: string;
          sql: string;
          result: QueryResultSet;
          chartConfig: BiChartConfig;
        };
        xrayTable?: {
          database: string;
          schema: string;
          table: string;
        };
      },
    ) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isBiSupportedDriver(sess.driver)) {
        notify('warning', t('BI Analytics requires a relational SQL or MongoDB connection.'));
        return;
      }

      const db = opts?.xrayTable?.database || sess.activeDatabase;
      const sch = opts?.xrayTable?.schema || sess.activeSchema;

      let existing = tabsRef.current.find(
        (item): item is BiAnalyticsTabState => item.kind === 'bi' && item.connectionId === connectionId,
      );

      let tabId: string;
      let baseCards: BiAnalysisCard[];

      if (existing) {
        tabId = existing.id;
        baseCards = existing.cards;
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        setActiveConnectionId(connectionId);
      } else {
        const persisted = await storage.loadBiDashboard(connectionId);
        const tab: BiAnalyticsTabState = {
          id: uid('bi'),
          connectionId,
          kind: 'bi',
          title: t('BI Dashboard'),
          database: db,
          schema: sch,
          viewMode: 'dashboard',
          question: '',
          pipelineStage: 'idle',
          cards: persisted,
          activeCardId: persisted[0]?.id ?? null,
          crossFilter: null,
        };
        tabId = tab.id;
        baseCards = persisted;
        appendTab(tab);
      }

      // Ensure relational schema objects are loaded when applicable
      if (isRelationalDriver(sess.driver)) {
        void loadSchemaForSession(connectionId, db, sch);
      }

      if (opts?.pinChart) {
        const { buildPinnedSqlCard } = await import('../bi/workbenchActions');
        const card = buildPinnedSqlCard({
          id: uid('bi-card'),
          title: opts.pinChart.title || t('SQL Chart'),
          sql: opts.pinChart.sql,
          result: opts.pinChart.result,
          chartConfig: opts.pinChart.chartConfig,
        });
        const nextCards = [card, ...baseCards].slice(0, 24);
        updateTab<BiAnalyticsTabState>(tabId, { cards: nextCards, activeCardId: card.id, viewMode: 'dashboard', crossFilter: null });
        void storage.saveBiDashboard(connectionId, nextCards);
        notify('success', `${t('Pinned to BI Dashboard')}: ${card.title}`);
        return;
      }

      if (opts?.xrayTable && isRelationalDriver(sess.driver)) {
        const { table } = opts.xrayTable;
        updateTab<BiAnalyticsTabState>(tabId, { pipelineStage: 'running', pipelineError: undefined });
        try {
          const { runTableXrayCards } = await import('../bi/workbenchActions');
          const created = await runTableXrayCards({
            driver: sess.driver as RelationalDriver,
            dialect: engineToSqlDialect(sess.connection.engine),
            database: db,
            schema: sch,
            table,
            cachedStructure: sess.objectsBySchema[schemaCacheKey(db, sch)]?.structures[table],
            makeId: () => uid('bi-card'),
          });
          if (created.length > 0) {
            const curTab = tabsRef.current.find((item): item is BiAnalyticsTabState => item.id === tabId && item.kind === 'bi');
            const nextCards = [...created, ...(curTab?.cards ?? baseCards)].slice(0, 24);
            updateTab<BiAnalyticsTabState>(tabId, {
              cards: nextCards,
              activeCardId: created[0].id,
              viewMode: created.length > 1 ? 'dashboard' : 'spotlight',
              pipelineStage: 'idle',
              crossFilter: null,
            });
            void storage.saveBiDashboard(connectionId, nextCards);
            notify('success', `${t('X-Ray complete')}: ${table} (${created.length} ${t('charts')})`);
          } else {
            updateTab<BiAnalyticsTabState>(tabId, { pipelineStage: 'idle', pipelineError: `No visualizable metrics returned for ${table}.` });
          }
        } catch (err) {
          updateTab<BiAnalyticsTabState>(tabId, { pipelineStage: 'idle', pipelineError: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    [appendTab, loadSchemaForSession, notify, storage, t, updateTab],
  );

  const handleExportBiChartFile = useCallback(
    async (opts: { title: string; defaultName: string; ext: 'svg' | 'png'; data: string; encoding: 'utf8' | 'base64'; downloadedByHost?: boolean }) => {
      if (opts.downloadedByHost) { notify('success', `${t('Exported')} ${opts.defaultName}`); return; }
      if (!opts.data) return;
      try {
        const res = await context.ui.saveFile({
          title: opts.title,
          defaultName: opts.defaultName,
          filters: [{ name: `${opts.ext.toUpperCase()} Image`, extensions: [opts.ext] }],
          data: opts.data,
          encoding: opts.encoding,
        });
        if (!res.cancelled) notify('success', `${t('Exported')} ${res.name}`);
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
      }
    },
    [context.ui, notify, t],
  );

  const handleExportBiChartSvg = useCallback(
    (d: BiExportSvgDetail) =>
      void handleExportBiChartFile({ title: t('Export SVG'), defaultName: d.suggestedName || 'chart.svg', ext: 'svg', data: d.svg, encoding: 'utf8', downloadedByHost: d.downloadedByHost }),
    [handleExportBiChartFile, t],
  );

  const handleExportBiChartPng = useCallback(
    (d: BiExportPngDetail) =>
      void handleExportBiChartFile({ title: t('Export PNG'), defaultName: d.suggestedName || 'chart.png', ext: 'png', data: (d.dataUrl ?? '').replace(/^data:image\/png;base64,/, ''), encoding: 'base64', downloadedByHost: d.downloadedByHost }),
    [handleExportBiChartFile, t],
  );

  // Native Catty Agent Contextual Sidebar integration (`ai.sidebar-tools`)
  const sidebarAiSupported =
    context.enabledFeatures.has('ai.sidebar-tools') &&
    typeof context.ai?.registerTools === 'function' &&
    typeof context.ai?.openSidebar === 'function';
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const activeConnectionIdRef = useRef(activeConnectionId);
  activeConnectionIdRef.current = activeConnectionId;
  const openSqlTabRef = useRef(openSqlTab);
  openSqlTabRef.current = openSqlTab;
  const openBiTabRef = useRef(openBiTab);
  openBiTabRef.current = openBiTab;
  const loadSchemaRef = useRef(loadSchemaForSession);
  loadSchemaRef.current = loadSchemaForSession;

  const openAiAssistant = useCallback(
    (options?: { initialMode?: 'generate' | 'explain' | 'optimize' | 'fix'; initialPrompt?: string; autoSend?: boolean }) => {
      if (sidebarAiSupported) {
        void context.ai
          .openSidebar({
            viewId: 'com.binaricat.netcatty-database.workbench',
            ...(options?.initialPrompt ? { prompt: options.initialPrompt } : {}),
            ...(options?.autoSend ? { autoSend: true } : {}),
          })
          .catch(() => {
            setDrawer({ kind: 'ai', options });
          });
        return;
      }
      setDrawer((d) =>
        !options && d.kind === 'ai' ? { kind: 'none' } : { kind: 'ai', options },
      );
    },
    [context.ai, sidebarAiSupported],
  );

  // Lazy-register 7 Database Agent tools once on mount (zero bloat to initial browser.js!)
  useEffect(() => {
    if (!sidebarAiSupported) return;
    let disposed = false;
    let registration: { dispose: () => void } | null = null;
    void (async () => {
      const { registerDatabaseAgentSidebar } = await import('../ai/databaseAgentTools');
      if (disposed) return;
      registration = await registerDatabaseAgentSidebar(context, {
        getConnections: () => connectionsRef.current,
        getSessions: () => sessionsRef.current,
        getActiveConnectionId: () => activeConnectionIdRef.current,
        getActiveSql: () => {
          const cur = tabsRef.current.find((tb) => tb.id === activeTabIdRef.current);
          return cur?.kind === 'sql' ? cur.sql : '';
        },
        getLocale: () => localeRef.current,
        openSqlTab: (connId, sql, title) => openSqlTabRef.current(connId, sql, title),
        pinChartToDashboard: async (connId, payload) => {
          await openBiTabRef.current(connId, { pinChart: payload });
        },
        ensureSchemaLoaded: (connId, db, sch) => loadSchemaRef.current(connId, db, sch),
      });
      if (disposed) registration.dispose();
    })().catch(() => {});
    return () => {
      disposed = true;
      registration?.dispose();
      if (typeof context.ai?.clearContext === 'function') {
        void context.ai.clearContext('com.binaricat.netcatty-database.workbench').catch(() => {});
      }
    };
  }, [context, sidebarAiSupported]);

  // Keep Catty Agent live database context synced (debounced)
  const activeTabForAi = tabs.find((tb) => tb.id === activeTabId);
  const activeSqlForAi = activeTabForAi?.kind === 'sql' ? activeTabForAi.sql : '';
  const activeSessionForAi = activeConnectionId ? sessions[activeConnectionId] : undefined;
  useEffect(() => {
    if (!sidebarAiSupported || typeof context.ai?.setContext !== 'function') return;
    const timer = setTimeout(() => {
      void (async () => {
        const { buildDatabaseAgentContext } = await import('../ai/databaseAgentTools');
        const payload = buildDatabaseAgentContext({
          session: activeSessionForAi,
          connectionsCount: connections.length,
          activeSql: activeSqlForAi,
          locale,
        });
        await context.ai.setContext(payload);
      })().catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [activeSessionForAi, activeSqlForAi, connections.length, context.ai, locale, sidebarAiSupported]);

  // Redis Tab (supports SCAN Load More cursor pagination!)
  const scanRedisTab = useCallback(
    async (tabId: string, opts?: { db?: number; match?: string; append?: boolean }) => {
      const tab = tabsRef.current.find((item): item is RedisWorkbenchTabState => item.id === tabId && item.kind === 'redis');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isRedisDriver(sess.driver)) return;
      const nextDb = opts?.db ?? tab.db;
      const nextMatch = opts?.match !== undefined ? opts.match : tab.matchPattern;
      const cursor = opts?.append ? tab.cursor : '0';

      updateTab<RedisWorkbenchTabState>(tabId, { loading: true, error: undefined, db: nextDb, matchPattern: nextMatch });
      try {
        if (nextDb !== sess.driver.currentDb) {
          await sess.driver.selectDb(nextDb);
        }
        const [scan, info] = await Promise.all([
          sess.driver.scanKeys({ cursor, match: nextMatch || '*', count: 200, maxKeys: 300, includeMeta: true }),
          opts?.append ? Promise.resolve(tab.info) : sess.driver.getInfo().catch(() => tab.info),
        ]);
        const mergedKeys = opts?.append
          ? [
              ...tab.keys,
              ...scan.keys.filter((k) => !tab.keys.some((e) => e.key === k.key)),
            ]
          : scan.keys;
        updateTab<RedisWorkbenchTabState>(tabId, {
          loading: false,
          keys: mergedKeys,
          cursor: scan.cursor,
          info: info ?? null,
        });
      } catch (err) {
        checkDisconnect(tab.connectionId, err);
        updateTab<RedisWorkbenchTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [checkDisconnect, updateTab],
  );

  const openRedisTab = useCallback(
    (connectionId: string, dbOverride?: number) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isRedisDriver(sess.driver)) return;
      const existing = tabsRef.current.find(
        (item): item is RedisWorkbenchTabState => item.kind === 'redis' && item.connectionId === connectionId,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
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
        activeSubTab: 'keys',
        keys: [],
        cursor: '0',
        selectedKey: null,
        keyDetail: null,
        info: sess.redisInfo ?? null,
        infoFilter: '',
        showCli: false,
        cliInput: '',
        cliHistory: [],
        cliCommandHistory: [],
        pubsubChannel: 'notifications',
        pubsubMessage: '',
        pubsubSubscribed: [],
        pubsubLog: [],
        loading: true,
      };
      appendTab(tab);
      setTimeout(() => void scanRedisTab(tab.id), 0);
    },
    [appendTab, scanRedisTab],
  );

  // MongoDB Tab (uses EJSON + pagination + schema analyzer)
  const runMongoTab = useCallback(
    async (tabId: string, opts?: { skip?: number }) => {
      const tab = tabsRef.current.find((item): item is MongoWorkbenchTabState => item.id === tabId && item.kind === 'mongo');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isMongoDriver(sess.driver)) return;
      const nextSkip = opts?.skip !== undefined ? opts.skip : tab.skip;
      updateTab<MongoWorkbenchTabState>(tabId, { loading: true, error: undefined, skip: nextSkip });
      const started = performance.now();
      try {
        const { parseMongoEjson } = await import('../drivers/mongoDriver');
        if (tab.mode === 'aggregate') {
          const pipeline = parseMongoEjson<unknown>(tab.pipelineJson || '[]');
          if (!Array.isArray(pipeline)) throw new Error('Aggregation pipeline must be a JSON array');
          const docs = await sess.driver.aggregate(tab.database, tab.collection, pipeline);
          updateTab<MongoWorkbenchTabState>(tabId, {
            loading: false,
            documents: docs,
            totalCount: docs.length,
            selectedDocIndex: null,
            executionMs: Math.round(performance.now() - started),
          });
        } else {
          const filter = tab.filterJson.trim() ? parseMongoEjson(tab.filterJson) : {};
          const sort = tab.sortJson.trim() ? parseMongoEjson(tab.sortJson) : undefined;
          const projection = tab.projectionJson.trim() ? parseMongoEjson(tab.projectionJson) : undefined;
          const [res, stats, indexes] = await Promise.all([
            sess.driver.find(tab.database, tab.collection, {
              filter,
              sort,
              projection,
              skip: nextSkip,
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
            selectedDocIndex: null,
            stats,
            indexes,
          });
        }
      } catch (err) {
        checkDisconnect(tab.connectionId, err);
        updateTab<MongoWorkbenchTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [checkDisconnect, updateTab],
  );

  const analyzeMongoSchemaTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item): item is MongoWorkbenchTabState => item.id === tabId && item.kind === 'mongo');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isMongoDriver(sess.driver)) return;
      updateTab<MongoWorkbenchTabState>(tabId, { schemaLoading: true, error: undefined });
      try {
        const analysis = await sess.driver.analyzeCollectionSchema(tab.database, tab.collection, 100);
        updateTab<MongoWorkbenchTabState>(tabId, { schemaLoading: false, schemaAnalysis: analysis });
      } catch (err) {
        updateTab<MongoWorkbenchTabState>(tabId, {
          schemaLoading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updateTab],
  );

  const openMongoCollectionTab = useCallback(
    (
      connectionId: string,
      database: string,
      collection: string,
      initialSubTab: 'documents' | 'indexes' | 'schema' = 'documents',
    ) => {
      const existing = tabsRef.current.find(
        (item): item is MongoWorkbenchTabState =>
          item.kind === 'mongo' &&
          item.connectionId === connectionId &&
          item.database === database &&
          item.collection === collection,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        updateTab<MongoWorkbenchTabState>(existing.id, { activeSubTab: initialSubTab });
        if (initialSubTab === 'schema') void analyzeMongoSchemaTab(existing.id);
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
        activeSubTab: initialSubTab,
        documents: [],
        totalCount: 0,
        indexes: [],
        stats: null,
        schemaAnalysis: null,
        schemaLoading: false,
        selectedDocIndex: null,
        executionMs: 0,
        loading: true,
      };
      appendTab(tab);
      setTimeout(() => {
        void runMongoTab(tab.id);
        if (initialSubTab === 'schema') void analyzeMongoSchemaTab(tab.id);
      }, 0);
    },
    [analyzeMongoSchemaTab, appendTab, runMongoTab, updateTab],
  );

  // Graph Database Tab (Neo4j Cypher + Visual Graph Canvas)
  const runGraphTab = useCallback(
    async (tabId: string, cypherOverride?: string) => {
      const tab = tabsRef.current.find((item): item is GraphWorkbenchTabState => item.id === tabId && item.kind === 'graph');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isGraphDriver(sess.driver)) return;
      const cypher = (cypherOverride ?? tab.cypher).trim();
      if (!cypher) return;
      if (sess.connection.readOnly && /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP)\b/i.test(cypher)) {
        updateTab<GraphWorkbenchTabState>(tabId, {
          running: false,
          error: t('Connection is in Read-Only mode. Unlock it in the top bar to run write operations.'),
        });
        return;
      }
      updateTab<GraphWorkbenchTabState>(tabId, { running: true, error: undefined, cypher });
      try {
        const result = await sess.driver.executeCypher(cypher, {
          database: tab.database || sess.activeDatabase,
          maxRows: 200,
        });
        updateTab<GraphWorkbenchTabState>(tabId, {
          running: false,
          result,
          viewMode: result.nodes.length > 0 ? tab.viewMode : tab.viewMode === 'graph' ? 'table' : tab.viewMode,
        });
      } catch (err) {
        checkDisconnect(tab.connectionId, err);
        updateTab<GraphWorkbenchTabState>(tabId, {
          running: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [checkDisconnect, t, updateTab],
  );

  const openGraphTab = useCallback(
    (connectionId: string, initialCypher?: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isGraphDriver(sess.driver)) return;
      const db = sess.activeDatabase || 'neo4j';
      const existing = tabsRef.current.find(
        (item): item is GraphWorkbenchTabState => item.kind === 'graph' && item.connectionId === connectionId,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        if (initialCypher) {
          updateTab<GraphWorkbenchTabState>(existing.id, { cypher: initialCypher, database: db });
          setTimeout(() => void runGraphTab(existing.id, initialCypher), 0);
        }
        return;
      }
      const cypher = initialCypher || 'MATCH (n) OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 50';
      const tab: GraphWorkbenchTabState = {
        id: uid('graph'),
        connectionId,
        kind: 'graph',
        title: `${sess.connection.name} · Graph`,
        database: db,
        cypher,
        viewMode: 'graph',
        result: null,
        schema: sess.graphSchemaByDb?.[db] ?? null,
        selectedNodeId: null,
        running: false,
      };
      appendTab(tab);
      setTimeout(() => void runGraphTab(tab.id, cypher), 0);
    },
    [appendTab, runGraphTab, updateTab],
  );

  // Search / Document / Vector Tab (Elasticsearch, Easysearch, Meilisearch, CouchDB, Qdrant, ChromaDB, Weaviate)
  const runSearchTab = useCallback(
    async (tabId: string, opts?: { from?: number }) => {
      const tab = tabsRef.current.find((item): item is SearchWorkbenchTabState => item.id === tabId && item.kind === 'search');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isSearchDriver(sess.driver)) return;
      const nextFrom = opts?.from !== undefined ? opts.from : tab.from;
      updateTab<SearchWorkbenchTabState>(tabId, { loading: true, error: undefined, from: nextFrom });
      try {
        let query: string | Record<string, unknown> = tab.queryText.trim();
        if (query.startsWith('{')) {
          try {
            query = JSON.parse(query) as Record<string, unknown>;
          } catch {
            // pass through as raw string query
          }
        }
        const res = await sess.driver.search(tab.index, query, { from: nextFrom, size: tab.size });
        updateTab<SearchWorkbenchTabState>(tabId, {
          loading: false,
          documents: res.documents,
          totalCount: res.totalCount,
          executionMs: res.executionMs,
        });
      } catch (err) {
        checkDisconnect(tab.connectionId, err);
        updateTab<SearchWorkbenchTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [checkDisconnect, updateTab],
  );

  const openSearchIndexTab = useCallback(
    (connectionId: string, index: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isSearchDriver(sess.driver)) return;
      const existing = tabsRef.current.find(
        (item): item is SearchWorkbenchTabState =>
          item.kind === 'search' && item.connectionId === connectionId && item.index === index,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        return;
      }
      const tab: SearchWorkbenchTabState = {
        id: uid('search'),
        connectionId,
        kind: 'search',
        title: index,
        index,
        queryText: '',
        viewMode: 'table',
        activeSubTab: 'documents',
        documents: [],
        totalCount: 0,
        mapping: null,
        from: 0,
        size: 50,
        executionMs: 0,
        loading: true,
      };
      appendTab(tab);
      setTimeout(() => void runSearchTab(tab.id), 0);
    },
    [appendTab, runSearchTab],
  );

  // Registry / Config KV Tab (etcd, Consul, Nacos)
  const reloadKvTab = useCallback(
    async (tabId: string, prefixOverride?: string) => {
      const tab = tabsRef.current.find((item): item is KvWorkbenchTabState => item.id === tabId && item.kind === 'kv');
      if (!tab) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isKvDriver(sess.driver)) return;
      const prefix = prefixOverride !== undefined ? prefixOverride : tab.prefix;
      updateTab<KvWorkbenchTabState>(tabId, { loading: true, error: undefined, prefix });
      try {
        const entries = await sess.driver.listKeys(prefix, { namespace: tab.namespace || undefined, limit: 200 });
        updateTab<KvWorkbenchTabState>(tabId, { loading: false, entries });
      } catch (err) {
        checkDisconnect(tab.connectionId, err);
        updateTab<KvWorkbenchTabState>(tabId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [checkDisconnect, updateTab],
  );

  const openKvTab = useCallback(
    (connectionId: string, namespace?: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isKvDriver(sess.driver)) return;
      const ns = namespace ?? sess.activeDatabase ?? '';
      const existing = tabsRef.current.find(
        (item): item is KvWorkbenchTabState => item.kind === 'kv' && item.connectionId === connectionId,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        if (ns !== existing.namespace) {
          updateTab<KvWorkbenchTabState>(existing.id, { namespace: ns });
          setTimeout(() => void reloadKvTab(existing.id), 0);
        }
        return;
      }
      const tab: KvWorkbenchTabState = {
        id: uid('kv'),
        connectionId,
        kind: 'kv',
        title: `${sess.connection.name} · KV`,
        namespace: ns,
        prefix: '',
        entries: [],
        selectedKey: null,
        selectedEntry: null,
        loading: true,
      };
      appendTab(tab);
      setTimeout(() => void reloadKvTab(tab.id), 0);
    },
    [appendTab, reloadKvTab, updateTab],
  );

  // Message Queue / Event Broker Tab (RabbitMQ, Pulsar, MQTT, Kafka)
  const openMqTab = useCallback(
    (connectionId: string, vhost?: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isMqDriver(sess.driver)) return;
      const targetVhost = vhost || sess.activeDatabase || '/';
      const existing = tabsRef.current.find(
        (item): item is MqWorkbenchTabState => item.kind === 'mq' && item.connectionId === connectionId,
      );
      if (existing) {
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        updateTab<MqWorkbenchTabState>(existing.id, { vhost: targetVhost });
        return;
      }
      appendTab({
        id: uid('mq'),
        connectionId,
        kind: 'mq',
        title: sess.connection.name,
        vhost: targetVhost,
        vhosts: sess.mqVhosts ?? [targetVhost],
        activeSubTab: 'overview',
        overview: null,
        queues: [],
        exchanges: [],
        bindings: [],
        selectedQueue: null,
        messages: [],
        loading: false,
      });
    },
    [appendTab, updateTab],
  );

  // Schema Diff / Dump / Restore / Data Transfer Tab
  const openSchemaDiffTab = useCallback(
    (connectionId: string, initialDumpSql = '', mode: SchemaDiffTabState['mode'] = initialDumpSql ? 'dump' : 'diff') => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return;
      const schemas = sess.schemas.map((s) => s.name);
      const left = sess.activeSchema || schemas[0] || 'main';
      const right = schemas.find((s) => s !== left) ?? left;
      const otherRel = Object.values(sessionsRef.current).find(
        (s) => s.connectionId !== connectionId && isRelationalDriver(s.driver),
      );
      const tab: SchemaDiffTabState = {
        id: uid('diff'),
        connectionId,
        kind: 'diff',
        title: mode === 'dump' ? t('SQL Dump') : mode === 'restore' ? t('SQL Restore') : mode === 'transfer' ? t('Data Transfer') : t('Schema Diff'),
        mode,
        leftConnectionId: connectionId,
        leftDatabase: sess.activeDatabase,
        leftSchema: left,
        rightConnectionId: otherRel ? otherRel.connectionId : connectionId,
        rightDatabase: otherRel ? otherRel.activeDatabase : sess.activeDatabase,
        rightSchema: otherRel ? otherRel.activeSchema || otherRel.schemas[0]?.name || 'main' : right,
        diffResult: null,
        selectedItemIds: [],
        dumpSql: initialDumpSql,
        dumpTables: [],
        includeData: true,
        restoreFileName: '',
        restoreSql: '',
        restoreContinueOnError: false,
        restoreProgress: null,
        restoreResult: null,
        transferTables: [],
        transferCreateTables: true,
        transferDropIfExists: false,
        transferIncludeData: true,
        transferProgress: null,
        transferResult: null,
        loading: false,
      };
      appendTab(tab);
    },
    [appendTab, t],
  );

  // Connect to a SavedConnection
  const connectTo = useCallback(
    async (conn: SavedConnection, overridePassword?: string, overrideSqliteBytes?: Uint8Array) => {
      if (sessionsRef.current[conn.id] && !sessionsRef.current[conn.id].disconnected) {
        setActiveConnectionId(conn.id);
        return;
      }
      setConnectingId(conn.id);
      try {
        if (sessionsRef.current[conn.id]?.disconnected) {
          await sessionsRef.current[conn.id].driver.close().catch(() => {});
        }
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

        const wasReconnecting = Boolean(sessionsRef.current[conn.id]);
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

        if (isRelationalDriver(session.driver)) {
          void loadSchemaForSession(conn.id, session.activeDatabase, session.activeSchema, true);
          if (!wasReconnecting) {
            const drafts = await storage.loadTabDrafts(conn.id);
            const sqlDrafts = drafts.filter((d) => d.kind === 'sql');
            if (sqlDrafts.length > 0) {
              for (const d of sqlDrafts.slice(0, 3)) {
                openSqlTab(conn.id, d.sql || '', d.title);
              }
            } else {
              openSqlTab(conn.id, `-- Connected to ${conn.name} (${session.info.serverVersion})\n`);
            }
          }
        } else if (isRedisDriver(session.driver) && !wasReconnecting) {
          openRedisTab(conn.id, session.driver.currentDb);
        } else if (isMongoDriver(session.driver) && !wasReconnecting) {
          const firstCol = session.mongoCollectionsByDb[session.activeDatabase]?.[0];
          if (firstCol) {
            openMongoCollectionTab(conn.id, session.activeDatabase, firstCol.name);
          }
        } else if (isGraphDriver(session.driver) && !wasReconnecting) {
          openGraphTab(conn.id);
        } else if (isSearchDriver(session.driver) && !wasReconnecting) {
          const firstIdx = session.searchIndices?.[0]?.name ?? '_all';
          openSearchIndexTab(conn.id, firstIdx);
        } else if (isKvDriver(session.driver) && !wasReconnecting) {
          openKvTab(conn.id, session.activeDatabase);
        } else if (isMqDriver(session.driver) && !wasReconnecting) {
          openMqTab(conn.id, session.activeDatabase);
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
      openGraphTab,
      openKvTab,
      openMongoCollectionTab,
      openRedisTab,
      openSearchIndexTab,
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
      const remaining = tabsRef.current.filter((item) => item.connectionId !== connectionId);
      tabsRef.current = remaining;
      setTabs(remaining);
      setActiveTabId((prev) => {
        if (remaining.some((r) => r.id === prev)) return prev;
        const nextId = remaining[0]?.id ?? null;
        activeTabIdRef.current = nextId;
        return nextId;
      });
      if (activeConnectionId === connectionId) {
        const nextConnId = Object.keys(nextSessions)[0] ?? null;
        setActiveConnectionId(nextConnId);
      }
      notify('info', `${t('Disconnected')}: ${sess.connection.name}`);
    },
    [activeConnectionId, notify, t],
  );

  // Save connection handler
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
      if (sessionsRef.current[finalConn.id]) {
        updateSession(finalConn.id, (cur) => ({ ...cur, connection: finalConn }));
      }
      setDrawer({ kind: 'none' });
      if (connectNow) {
        await connectTo(finalConn, password, sqliteBytes);
      } else {
        notify('success', `Saved connection: ${finalConn.name}`);
      }
    },
    [connectTo, notify, storage, updateSession],
  );

  useEffect(() => {
    modalBridge.setSaveHandler(handleSaveConnection);
    return () => modalBridge.setSaveHandler(null);
  }, [modalBridge, handleSaveConnection]);

  // Export & Import Connections JSON / DBeaver data-sources.json (P1-5)
  const handleExportConnections = useCallback(async () => {
    try {
      const json = exportConnectionsJson(connectionsRef.current);
      const res = await context.ui.saveFile({
        title: t('Export Connections'),
        defaultName: 'netcatty-database-connections.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        data: json,
        encoding: 'utf8',
      });
      if (!res.cancelled) notify('success', `Exported ${connectionsRef.current.length} connections`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    }
  }, [context.ui, notify, t]);

  const handleImportConnections = useCallback(async () => {
    try {
      const res = await context.ui.openFile({
        title: t('Import Connections'),
        filters: [{ name: 'JSON / DBeaver', extensions: ['json'] }],
        readAs: 'utf8',
      });
      if (res.cancelled) return;
      const parsed = importConnectionsJson(String(res.data));
      if (parsed.length === 0) {
        notify('warning', 'No valid connections found in file');
        return;
      }
      const existingNames = new Set(connectionsRef.current.map((c) => `${c.engine}:${c.name}:${c.host}:${c.port}`));
      const toAdd = parsed.filter(
        (c) => !existingNames.has(`${c.engine}:${c.name}:${c.host}:${c.port}`),
      );
      const merged = [...connectionsRef.current, ...toAdd];
      setConnections(merged);
      await storage.saveConnections(merged);
      notify('success', `Imported ${toAdd.length} connection(s)`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    }
  }, [context.ui, notify, storage, t]);

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

  // Save SQLite file back via `ui.writeFileHandle` (in-place) or `ui.saveFile` (Save As) (P0-10)
  const handleSaveSqliteFile = useCallback(
    async (connectionId: string, forceSaveAs = false) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess || !isSqliteExportableDriver(sess.driver)) return;
      try {
        const bytes = sess.driver.exportBytes();
        if (!forceSaveAs && sess.sqliteFileHandleId && typeof context.ui.writeFileHandle === 'function') {
          await context.ui.writeFileHandle(sess.sqliteFileHandleId, bytes);
          updateSession(connectionId, (cur) => ({ ...cur, sqliteDirty: false }));
          notify('success', `Saved ${sess.connection.sqliteFileName || 'database.sqlite'}`);
        } else {
          const saved = await context.ui.saveFile({
            title: forceSaveAs ? t('Save SQLite As...') : t('Save SQLite File'),
            defaultName: sess.connection.sqliteFileName || `${sess.connection.name}.sqlite`,
            filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }],
            data: bytes,
          });
          if (!saved.cancelled) {
            updateSession(connectionId, (cur) => ({
              ...cur,
              sqliteDirty: false,
              sqliteFileHandleId: saved.handleId || cur.sqliteFileHandleId,
            }));
            notify('success', `Saved ${saved.name}`);
          }
        }
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
      }
    },
    [context.ui, notify, t, updateSession],
  );

  // Switch active database (uses RelationalDriver.switchDatabase for PG/MySQL/ClickHouse — P0-1)
  const handleSwitchDatabase = useCallback(
    async (connectionId: string, database: string) => {
      const sess = sessionsRef.current[connectionId];
      if (!sess) return;
      if (isRelationalDriver(sess.driver)) {
        try {
          let nextInfo = sess.info;
          if (typeof sess.driver.switchDatabase === 'function') {
            nextInfo = await sess.driver.switchDatabase(database);
          } else if (sess.family === 'mysql' || sess.family === 'clickhouse') {
            await sess.driver.query(`USE \`${database.replaceAll('`', '``')}\``);
          }
          const schemas = await sess.driver.listSchemas(database).catch(() => [{ name: database }]);
          const activeSchema = schemas.find((s) => s.name === 'public')?.name ?? schemas[0]?.name ?? database;
          updateSession(connectionId, (cur) => ({
            ...cur,
            info: nextInfo,
            activeDatabase: database,
            schemas,
            activeSchema,
            disconnected: false,
          }));
          // Also keep active SQL tabs on this connection aware of the newly selected DB/schema
          for (const tb of tabsRef.current) {
            if (tb.connectionId === connectionId && tb.kind === 'sql') {
              updateTab<SqlQueryTabState>(tb.id, { database, schema: activeSchema });
            }
          }
          void loadSchemaForSession(connectionId, database, activeSchema, true);
        } catch (err) {
          checkDisconnect(connectionId, err);
          notify('error', err instanceof Error ? err.message : String(err));
        }
      } else if (isMongoDriver(sess.driver)) {
        try {
          const cols = await sess.driver.listCollections(database);
          updateSession(connectionId, (cur) => ({
            ...cur,
            activeDatabase: database,
            mongoCollectionsByDb: {
              ...cur.mongoCollectionsByDb,
              [database]: cols,
            },
          }));
        } catch (err) {
          checkDisconnect(connectionId, err);
          notify('error', err instanceof Error ? err.message : String(err));
        }
      } else if (isRedisDriver(sess.driver)) {
        updateSession(connectionId, (cur) => ({ ...cur, activeDatabase: database }));
      } else if (isGraphDriver(sess.driver)) {
        try {
          const nextInfo = await sess.driver.switchDatabase(database);
          const gSchema = await sess.driver.getSchemaSummary(database).catch(() => undefined);
          updateSession(connectionId, (cur) => ({
            ...cur,
            info: nextInfo,
            activeDatabase: database,
            graphSchemaByDb: gSchema
              ? { ...(cur.graphSchemaByDb ?? {}), [database]: gSchema }
              : cur.graphSchemaByDb,
          }));
        } catch (err) {
          checkDisconnect(connectionId, err);
          notify('error', err instanceof Error ? err.message : String(err));
        }
      }
    },
    [checkDisconnect, loadSchemaForSession, notify, updateSession, updateTab],
  );

  // Execute SQL on a SQL Query Tab (with Read-Only guard, Destructive Confirm, Parameter Prompt & QueryError diagnostics!)
  const handleExecuteSqlTab = useCallback(
    async (
      tabId: string,
      sqlToRun: string,
      opts?: { skipParams?: boolean; skipConfirm?: boolean },
    ) => {
      const tab = tabsRef.current.find((item): item is SqlQueryTabState => item.id === tabId && item.kind === 'sql');
      if (!tab || !sqlToRun.trim()) return;
      const sess = sessionsRef.current[tab.connectionId];
      if (!sess || !isRelationalDriver(sess.driver)) return;

      // 1. Parameter prompt (P0-6)
      if (!opts?.skipParams) {
        const params = extractSqlParameters(sqlToRun, tab.dialect);
        if (params.length > 0) {
          setDrawer({
            kind: 'params',
            target: {
              tabId,
              sql: sqlToRun,
              dialect: tab.dialect,
              parameters: params,
              initialValues: tab.lastParamValues ?? {},
              onExecute: async (boundSql, savedValues) => {
                updateTab<SqlQueryTabState>(tabId, { lastParamValues: savedValues });
                await handleExecuteSqlTab(tabId, boundSql, { skipParams: true });
              },
            },
          });
          return;
        }
      }

      // 2. Risk classification: Read-Only block + Destructive confirmation (P0-2)
      const risk = classifySqlRisk(sqlToRun, tab.dialect);
      if (sess.connection.readOnly && risk.isWrite) {
        const blockedMsg = t('Read-only connection: write operation blocked');
        notify('warning', blockedMsg);
        updateTab<SqlQueryTabState>(tabId, {
          activeResultTab: 'messages',
          messages: [...tab.messages.slice(-40), { time: Date.now(), level: 'warning', text: blockedMsg, sql: sqlToRun }],
        });
        return;
      }
      if (!opts?.skipConfirm && risk.level === 'destructive') {
        setDrawer({
          kind: 'confirmSql',
          target: {
            title: `${sess.connection.name} · ${tab.database}`,
            sql: sqlToRun,
            dialect: tab.dialect,
            assessment: risk,
            onConfirm: async () => {
              await handleExecuteSqlTab(tabId, sqlToRun, { skipParams: true, skipConfirm: true });
            },
          },
        });
        return;
      }

      updateTab<SqlQueryTabState>(tabId, { running: true, diagnostics: [], serverDiagnostics: [] });
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
          resultSort: null,
          inTransaction: sess.driver.inTransaction,
          messages: [...tab.messages.slice(-40), ...newMsgs],
        });

        if (risk.isWrite) {
          markSqliteDirty(sess.connectionId);
        }

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

        if (/^\s*(?:CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(sqlToRun)) {
          void loadSchemaForSession(sess.connectionId, tab.database, tab.schema, true);
        }
      } catch (err) {
        checkDisconnect(sess.connectionId, err);
        const msg = err instanceof Error ? err.message : String(err);
        const qErr = err instanceof QueryError ? err : null;
        const line = qErr?.line ?? 1;
        const col = qErr?.column ?? 1;
        updateTab<SqlQueryTabState>(tabId, {
          running: false,
          activeResultTab: 'messages',
          serverDiagnostics: [
            {
              line,
              column: col,
              endLine: line,
              endColumn: col + 24,
              message: qErr?.hint ? `${msg} (Hint: ${qErr.hint})` : msg,
              severity: 'error',
            },
          ],
          messages: [
            ...tab.messages.slice(-40),
            {
              time: Date.now(),
              level: 'error',
              text: msg,
              line: qErr?.line,
              column: qErr?.column,
              hint: qErr?.hint,
              sql: sqlToRun,
            },
          ],
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
    [checkDisconnect, loadSchemaForSession, markSqliteDirty, notify, storage, t, updateTab],
  );

  // Export helper
  const handleExportDataset = useCallback(
    async (
      name: string,
      columns: string[],
      rows: CellValue[][],
      dialect: SqlDialect,
      format: ExportFormat,
      schema?: string,
    ) => {
      try {
        const {
          exportCsv,
          exportTsv,
          exportJson,
          exportMarkdown,
          exportSqlInserts,
          exportXlsx,
        } = await import('../sql/exportImport');
        if (format === 'copy-csv') {
          await copyText(exportCsv(columns, rows), `${name}.csv`);
          return;
        }
        if (format === 'copy-tsv') {
          await copyText(exportTsv(columns, rows), `${name}.tsv`);
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
            : format === 'tsv'
              ? exportTsv(columns, rows)
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

  // Commit pending edits for a table tab
  const commitTableChanges = useCallback(
    async (tab: TableDataTabState, sess: ActiveSession) => {
      if (sess.connection.readOnly) {
        notify('warning', t('Read-only connection: write operation blocked'));
        return;
      }
      const preview = buildTableBatchPreview(tab, sess);
      if (!preview || preview.statements.length === 0) return;
      try {
        await (sess.driver as RelationalDriver).applyBatchMutations(preview.statements);
        markSqliteDirty(sess.connectionId);
        notify('success', `Committed ${preview.statements.length} changes`);
        await reloadTableTab(tab.id);
      } catch (err) {
        checkDisconnect(sess.connectionId, err);
        notify('error', err instanceof Error ? err.message : String(err));
      }
    },
    [buildTableBatchPreview, checkDisconnect, markSqliteDirty, notify, reloadTableTab, t],
  );

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
  const connById = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections]);

  const activeCompletionSchema = useMemo(() => {
    if (!activeTab || activeTab.kind !== 'sql' || !activeSession) return undefined;
    return buildCompletionSchemaForSession(activeSession, activeTab.database, activeTab.schema);
  }, [activeTab, activeSession]);

  const closeTab = useCallback((tabId: string) => {
    const closing = tabsRef.current.find((item) => item.id === tabId);
    if (closing) {
      setRecentlyClosedTabs((prev) => [closing, ...prev.filter((t) => t.id !== closing.id)].slice(0, 12));
    }
    setPinnedTabIds((prev) => prev.filter((id) => id !== tabId));
    const idx = tabsRef.current.findIndex((item) => item.id === tabId);
    const next = tabsRef.current.filter((item) => item.id !== tabId);
    tabsRef.current = next;
    setTabs(next);
    setActiveTabId((cur) => {
      if (cur !== tabId) return cur;
      const fallback = next[Math.max(0, idx - 1)]?.id ?? null;
      activeTabIdRef.current = fallback;
      return fallback;
    });
  }, []);

  const togglePinTab = useCallback((tabId: string) => {
    setPinnedTabIds((prev) =>
      prev.includes(tabId) ? prev.filter((id) => id !== tabId) : [...prev, tabId],
    );
  }, []);

  const reopenClosedTab = useCallback((tab: WorkspaceTab) => {
    setRecentlyClosedTabs((prev) => prev.filter((item) => item.id !== tab.id));
    appendTab({ ...tab, id: uid(tab.kind) } as WorkspaceTab);
  }, [appendTab]);

  const closeOtherTabs = useCallback((keepTabId: string) => {
    const pinSet = new Set(pinnedTabIds);
    const kept = tabsRef.current.filter((item) => item.id === keepTabId || pinSet.has(item.id));
    tabsRef.current = kept;
    setTabs(kept);
    activeTabIdRef.current = keepTabId;
    setActiveTabId(keepTabId);
  }, [pinnedTabIds]);

  const closeAllTabs = useCallback(() => {
    const pinSet = new Set(pinnedTabIds);
    const kept = tabsRef.current.filter((item) => pinSet.has(item.id));
    tabsRef.current = kept;
    setTabs(kept);
    const nextActive = kept[0]?.id ?? null;
    activeTabIdRef.current = nextActive;
    setActiveTabId(nextActive);
  }, [pinnedTabIds]);

  const duplicateTab = useCallback(
    (tab: WorkspaceTab) => {
      if (tab.kind === 'sql') {
        openSqlTab(tab.connectionId, tab.sql, `${tab.title} (Copy)`);
      } else if (tab.kind === 'table') {
        const clone: TableDataTabState = {
          ...tab,
          id: uid('tbl'),
          title: `${tab.table} (2)`,
          dirtyCells: {},
          insertedRows: [],
          deletedRowIndices: [],
          selectedRowIndices: [],
          undoStack: [],
          redoStack: [],
          dirty: false,
        };
        appendTab(clone);
      }
    },
    [appendTab, openSqlTab],
  );

  // Global keyboard shortcuts handler (P0-3)
  const handleGlobalShortcut = useCallback(
    (shortcut: PluginWorkbenchShortcut) => {
      if (shortcut === 'mod+k') {
        setPaletteOpen((v) => !v);
        return;
      }
      if (shortcut === 'escape') {
        if (paletteOpen) {
          setPaletteOpen(false);
        } else if (contextMenu) {
          setContextMenu(null);
        } else if (drawer.kind !== 'none') {
          setDrawer({ kind: 'none' });
        }
        return;
      }
      const curTab = tabsRef.current.find((tb) => tb.id === activeTabIdRef.current) ?? null;
      const curSess = curTab
        ? sessionsRef.current[curTab.connectionId]
        : activeConnectionId
          ? sessionsRef.current[activeConnectionId]
          : undefined;

      if (shortcut === 'mod+t') {
        if (curSess && isRelationalDriver(curSess.driver)) {
          openSqlTab(curSess.connectionId);
        }
        return;
      }
      if (shortcut === 'mod+w') {
        if (curTab) closeTab(curTab.id);
        return;
      }
      if (shortcut === 'mod+s') {
        if (curTab?.kind === 'table' && curSess && hasPendingGridEdits(curTab)) {
          void commitTableChanges(curTab, curSess);
          return;
        }
        if (curSess?.family === 'sqlite' && curSess.sqliteDirty) {
          void handleSaveSqliteFile(curSess.connectionId, false);
          return;
        }
        if (curTab?.kind === 'sql') {
          void (async () => {
            const res = await context.ui.saveFile({
              title: 'Save SQL Script',
              defaultName: curTab.fileName || `${curTab.title.replace(/\s+/g, '_')}.sql`,
              filters: [{ name: 'SQL Script', extensions: ['sql'] }],
              data: curTab.sql,
              encoding: 'utf8',
            });
            if (!res.cancelled) {
              updateTab<SqlQueryTabState>(curTab.id, { title: res.name, fileName: res.name, dirty: false });
              notify('success', `Saved ${res.name}`);
            }
          })();
        }
        return;
      }
      if (shortcut === 'mod+z' && curTab?.kind === 'table') {
        const res = undoGridEdit(
          { dirtyCells: curTab.dirtyCells, insertedRows: curTab.insertedRows, deletedRowIndices: curTab.deletedRowIndices },
          curTab.undoStack ?? [],
          curTab.redoStack ?? [],
        );
        if (res) {
          updateTab<TableDataTabState>(curTab.id, {
            ...res.current,
            undoStack: res.undoStack,
            redoStack: res.redoStack,
            dirty: res.dirty,
          });
        }
        return;
      }
      if (shortcut === 'mod+shift+z' && curTab?.kind === 'table') {
        const res = redoGridEdit(
          { dirtyCells: curTab.dirtyCells, insertedRows: curTab.insertedRows, deletedRowIndices: curTab.deletedRowIndices },
          curTab.undoStack ?? [],
          curTab.redoStack ?? [],
        );
        if (res) {
          updateTab<TableDataTabState>(curTab.id, {
            ...res.current,
            undoStack: res.undoStack,
            redoStack: res.redoStack,
            dirty: res.dirty,
          });
        }
      }
    },
    [
      activeConnectionId,
      closeTab,
      commitTableChanges,
      context.ui,
      contextMenu,
      drawer.kind,
      handleSaveSqliteFile,
      notify,
      openSqlTab,
      paletteOpen,
      updateTab,
    ],
  );

  usePluginShortcuts(handleGlobalShortcut);

  const handleWidgetShortcut = useCallback(
    ({ shortcut }: { shortcut: PluginWorkbenchShortcut }) => handleGlobalShortcut(shortcut),
    [handleGlobalShortcut],
  );

  // Command Palette items (Actions, Open Tabs, Connections, Loaded Tables/Views/Collections)
  const paletteItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      {
        id: 'act:new-conn',
        group: 'action',
        title: t('New Connection'),
        icon: 'plus',
        onSelect: () => {
          setEditingPassword(undefined);
          setDrawer({ kind: 'connection', editingId: null });
        },
      },
      {
        id: 'act:open-sqlite',
        group: 'action',
        title: t('Open Local SQLite File'),
        icon: 'folder',
        onSelect: () => void handleQuickOpenSqliteFile(),
      },
      {
        id: 'act:ai',
        group: 'action',
        title: t('AI Assistant'),
        icon: 'sparkles',
        onSelect: () => openAiAssistant(),
      },
      {
        id: 'act:history',
        group: 'action',
        title: t('Query History & Snippets'),
        icon: 'history',
        onSelect: () => setDrawer({ kind: 'history', initialTab: 'history' }),
      },
      {
        id: 'act:import-conns',
        group: 'action',
        title: t('Import Connections'),
        icon: 'folder',
        onSelect: () => void handleImportConnections(),
      },
      {
        id: 'act:export-conns',
        group: 'action',
        title: t('Export Connections'),
        icon: 'file-code',
        onSelect: () => void handleExportConnections(),
      },
    ];

    if (activeSession && isRelationalDriver(activeSession.driver)) {
      items.unshift(
        {
          id: 'act:new-query',
          group: 'action',
          title: t('New Query'),
          subtitle: activeSession.connection.name,
          shortcut: '⌘T',
          icon: 'file-code',
          onSelect: () => openSqlTab(activeSession.connectionId),
        },
        {
          id: 'act:er',
          group: 'action',
          title: t('ER Diagram'),
          subtitle: `${activeSession.activeDatabase}.${activeSession.activeSchema}`,
          icon: 'database',
          onSelect: () => openErTab(activeSession.connectionId, activeSession.activeDatabase, activeSession.activeSchema),
        },
        {
          id: 'act:ai',
          group: 'action',
          title: t('AI Assistant'),
          subtitle: activeSession.connection.name,
          icon: 'sparkles',
          onSelect: () => openAiAssistant(),
        },
        {
          id: 'act:diff',
          group: 'action',
          title: t('Schema Diff'),
          icon: 'book-open',
          onSelect: () => openSchemaDiffTab(activeSession.connectionId),
        },
        {
          id: 'act:transfer',
          group: 'action',
          title: t('Data Transfer'),
          icon: 'arrow-right',
          onSelect: () => openSchemaDiffTab(activeSession.connectionId, '', 'transfer'),
        },
      );
    }

    if (activeSession && isBiSupportedDriver(activeSession.driver)) {
      items.push({
        id: 'act:bi',
        group: 'action',
        title: t('BI Dashboard'),
        subtitle: `${activeSession.connection.name} · ${t('Pinned Charts & Cross-Filtering')}`,
        icon: 'bar-chart-2',
        onSelect: () => void openBiTab(activeSession.connectionId),
      });
    }

    for (const tb of tabs) {
      items.push({
        id: `tab:${tb.id}`,
        group: 'tab',
        title: tb.title,
        subtitle: connById.get(tb.connectionId)?.name,
        badge: tb.kind.toUpperCase(),
        icon: TAB_ICON[tb.kind],
        onSelect: () => {
          activeTabIdRef.current = tb.id;
          setActiveTabId(tb.id);
          setActiveConnectionId(tb.connectionId);
        },
      });
    }

    for (const conn of connections) {
      const online = Boolean(sessions[conn.id]);
      items.push({
        id: `conn:${conn.id}`,
        group: 'connection',
        title: conn.name,
        subtitle: conn.engine === 'sqlite' ? conn.sqliteFileName || 'SQLite' : `${conn.host}:${conn.port}/${conn.database}`,
        badge: online ? t('Online') : conn.engine,
        icon: 'server',
        onSelect: () => {
          if (online) setActiveConnectionId(conn.id);
          else void connectTo(conn);
        },
      });
    }

    for (const sess of Object.values(sessions)) {
      if (isRelationalDriver(sess.driver)) {
        for (const [key, cache] of Object.entries(sess.objectsBySchema)) {
          const [db, sch] = key.split('::');
          for (const tbl of cache.tables) {
            items.push({
              id: `tbl:${sess.connectionId}:${key}:${tbl.name}`,
              group: 'object',
              title: tbl.name,
              subtitle: `${sess.connection.name} · ${sch || db}`,
              badge: 'TABLE',
              icon: 'table',
              onSelect: () => openTableDataTab(sess.connectionId, db, sch, tbl.name),
            });
          }
          for (const vw of cache.views) {
            items.push({
              id: `vw:${sess.connectionId}:${key}:${vw.name}`,
              group: 'object',
              title: vw.name,
              subtitle: `${sess.connection.name} · ${sch || db}`,
              badge: 'VIEW',
              icon: 'eye',
              onSelect: () =>
                openObjectDefTab(sess.connectionId, {
                  objectKind: 'view',
                  database: db,
                  schema: sch,
                  name: vw.name,
                  definition: vw.definition || '',
                }),
            });
          }
        }
      } else if (isMongoDriver(sess.driver)) {
        for (const [db, cols] of Object.entries(sess.mongoCollectionsByDb)) {
          for (const col of cols) {
            items.push({
              id: `mcol:${sess.connectionId}:${db}:${col.name}`,
              group: 'object',
              title: col.name,
              subtitle: `${sess.connection.name} · ${db}`,
              badge: 'COLLECTION',
              icon: 'folder',
              onSelect: () => openMongoCollectionTab(sess.connectionId, db, col.name),
            });
          }
        }
      }
    }

    return items;
  }, [
    activeSession,
    connById,
    connections,
    connectTo,
    handleExportConnections,
    handleImportConnections,
    handleQuickOpenSqliteFile,
    openAiAssistant,
    openBiTab,
    openErTab,
    openMongoCollectionTab,
    openObjectDefTab,
    openSchemaDiffTab,
    openSqlTab,
    openTableDataTab,
    sessions,
    t,
    tabs,
  ]);

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
      className="ndb-workbench database-workbench"
      data-plugin-chrome="full-bleed"
      data-theme={resolveThemeVariant(theme)}
    >
      {/* Sleek Full-Bleed Top Chrome Bar (zero-overflow at 820px..1440px+) */}
      <header className="ndb-topbar">
        <div className="ndb-topbar-left">
          <button
            type="button"
            className="ndb-icon-btn"
            aria-label="Toggle explorer"
            aria-pressed={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            <Icon name="panel-left" />
          </button>

          {activeSession ? (
            <div className="ndb-active-conn-pill" title={`${activeSession.connection.name} · ${activeSession.activeDatabase}`}>
              <EngineIcon engine={activeSession.connection.engine} theme={theme} size={16} />
              <strong className="ndb-conn-name">{activeSession.connection.name}</strong>
              <span className={activeSession.disconnected ? 'ndb-offline-dot' : 'ndb-online-dot'} />
              <span className="ndb-conn-db ndb-muted ndb-mono">{activeSession.activeDatabase}</span>
              {activeSession.info.tlsActive && <span className="ndb-tag ndb-tag-ok">TLS</span>}
              {activeSession.connection.sshTunnel.enabled && <span className="ndb-tag ndb-tag-ssh">SSH</span>}
              {activeSession.family === 'sqlite' && activeSession.sqliteDirty && (
                <span className="ndb-tag ndb-tag-warn">{t('Unsaved')}</span>
              )}
            </div>
          ) : (
            <span className="ndb-brand-title">
              <Icon name="database" />
              <strong>{t('Database')}</strong>
            </span>
          )}

          {/* Read-Only Safe Mode compact toggle */}
          {activeSession && (
            <button
              type="button"
              className={`ndb-btn ndb-btn-sm ndb-topbar-compact-btn ${activeSession.connection.readOnly ? 'ndb-btn-amber' : 'ndb-btn-ghost'}`}
              title={activeSession.connection.readOnly ? t('Read-Only Mode') : t('Writable')}
              aria-label={activeSession.connection.readOnly ? t('Read-Only Mode') : t('Writable')}
              onClick={() => handleToggleReadOnly(activeSession.connectionId)}
            >
              <Icon name="shield" />
              {activeSession.connection.readOnly ? 'RO' : 'RW'}
            </button>
          )}

          {/* SQLite quick Save pill (only inline when dirty; Save & Save As always in Tools menu) */}
          {activeSession?.family === 'sqlite' && activeSession.sqliteDirty && (
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm ndb-topbar-compact-btn"
              title={t('Save SQLite File')}
              onClick={() => void handleSaveSqliteFile(activeSession.connectionId, false)}
            >
              {t('Save')}
            </button>
          )}
        </div>

        <div className="ndb-topbar-right">
          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-sm ndb-palette-trigger"
            title={`${t('Command Palette')} (Cmd/Ctrl+K)`}
            onClick={() => setPaletteOpen(true)}
          >
            <Icon name="search" />
            <span className="ndb-kbd ndb-mono">⌘K</span>
          </button>

          {activeSession && isRelationalDriver(activeSession.driver) && (
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              onClick={() => openSqlTab(activeSession.connectionId)}
            >
              <Icon name="plus" />
              {t('New Query')}
            </button>
          )}

          {/* Secondary Workbench Tools consolidated into a clean borderless popover */}
          <button
            id="ndb-topbar-tools-btn"
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-sm"
            aria-expanded={toolsMenuOpen}
            aria-haspopup="menu"
            title={t('Workbench Tools')}
            onClick={() => setToolsMenuOpen((v) => !v)}
          >
            <span>{t('Tools')}</span>
            <Icon name="chevron-down" />
          </button>
          <PluginPopover
            anchor="ndb-topbar-tools-btn"
            open={toolsMenuOpen}
            width={220}
            maxHeight={420}
            onClose={() => setToolsMenuOpen(false)}
          >
            <div className="ndb-menu-list" role="menu">
              {activeSession && isBiSupportedDriver(activeSession.driver) && (
                <button
                  type="button"
                  role="menuitem"
                  className="ndb-menu-item"
                  onClick={() => {
                    setToolsMenuOpen(false);
                    void openBiTab(activeSession.connectionId);
                  }}
                >
                  <Icon name="bar-chart-2" />
                  <span>{t('BI Dashboard')}</span>
                </button>
              )}
              {activeSession && isRelationalDriver(activeSession.driver) && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      openErTab(
                        activeSession.connectionId,
                        activeSession.activeDatabase,
                        activeSession.activeSchema,
                      );
                    }}
                  >
                    <Icon name="table" />
                    <span>{t('ER Diagram')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      openSchemaDiffTab(activeSession.connectionId, '', 'diff');
                    }}
                  >
                    <Icon name="file-code" />
                    <span>{t('Schema Diff')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      openSchemaDiffTab(activeSession.connectionId, '', 'dump');
                    }}
                  >
                    <Icon name="database" />
                    <span>{t('SQL Dump')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      openSchemaDiffTab(activeSession.connectionId, '', 'restore');
                    }}
                  >
                    <Icon name="refresh" />
                    <span>{t('SQL Restore')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      openSchemaDiffTab(activeSession.connectionId, '', 'transfer');
                    }}
                  >
                    <Icon name="arrow-right" />
                    <span>{t('Data Transfer')}</span>
                  </button>
                  <div className="ndb-menu-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      appendTab({
                        id: uid('monitor'),
                        connectionId: activeSession.connectionId,
                        kind: 'monitor',
                        title: t('Server Monitor'),
                        activeSubTab: 'dashboard',
                        autoRefreshSec: 0,
                        status: null,
                        history: [],
                        processes: [],
                        loading: false,
                      });
                    }}
                  >
                    <Icon name="server" />
                    <span>{t('Server Monitor')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      appendTab({
                        id: uid('users'),
                        connectionId: activeSession.connectionId,
                        kind: 'users',
                        title: t('Users & Roles'),
                        users: [],
                        selectedUserKey: null,
                        selectedGrants: [],
                        loading: false,
                      });
                    }}
                  >
                    <Icon name="shield" />
                    <span>{t('Users & Roles')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      appendTab({
                        id: uid('cmp'),
                        connectionId: activeSession.connectionId,
                        kind: 'dataCompare',
                        title: t('Data Compare'),
                      });
                    }}
                  >
                    <Icon name="book-open" />
                    <span>{t('Data Compare')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      setDrawer({ kind: 'mockData', connectionId: activeSession.connectionId });
                    }}
                  >
                    <Icon name="sparkles" />
                    <span>{t('Mock Data Generator')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      setDrawer({ kind: 'docsModel', connectionId: activeSession.connectionId, initialTab: 'dictionary' });
                    }}
                  >
                    <Icon name="file-code" />
                    <span>{t('Data Dictionary & Models')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      setDrawer({ kind: 'globalSearch', connectionId: activeSession.connectionId, initialTab: 'objects' });
                    }}
                  >
                    <Icon name="search" />
                    <span>{t('Global Search')}</span>
                  </button>
                  {activeSession.connection.engine === 'dolt' && (
                    <button
                      type="button"
                      role="menuitem"
                      className="ndb-menu-item"
                      onClick={() => {
                        setToolsMenuOpen(false);
                        appendTab({
                          id: uid('dolt'),
                          connectionId: activeSession.connectionId,
                          kind: 'dolt',
                          title: t('Dolt Version Control'),
                        });
                      }}
                    >
                      <Icon name="history" />
                      <span>{t('Dolt Version Control')}</span>
                    </button>
                  )}
                  <div className="ndb-menu-sep" />
                </>
              )}

              {activeSession?.family === 'sqlite' && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      void handleSaveSqliteFile(activeSession.connectionId, false);
                    }}
                  >
                    <Icon name="database" />
                    <span>{t('Save SQLite File')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="ndb-menu-item"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      void handleSaveSqliteFile(activeSession.connectionId, true);
                    }}
                  >
                    <Icon name="folder" />
                    <span>{t('Save SQLite As...')}</span>
                  </button>
                  <div className="ndb-menu-sep" />
                </>
              )}

              <button
                type="button"
                role="menuitem"
                className="ndb-menu-item"
                onClick={() => {
                  setToolsMenuOpen(false);
                  setDrawer((d) =>
                    d.kind === 'history' && d.initialTab === 'history'
                      ? { kind: 'none' }
                      : { kind: 'history', initialTab: 'history' },
                  );
                }}
              >
                <Icon name="history" />
                <span>{t('Query History')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ndb-menu-item"
                onClick={() => {
                  setToolsMenuOpen(false);
                  setDrawer((d) =>
                    d.kind === 'history' && d.initialTab === 'snippets'
                      ? { kind: 'none' }
                      : { kind: 'history', initialTab: 'snippets' },
                  );
                }}
              >
                <Icon name="book-open" />
                <span>{t('Snippets')}</span>
              </button>
              <div className="ndb-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="ndb-menu-item"
                onClick={() => {
                  setToolsMenuOpen(false);
                  void handleImportConnections();
                }}
              >
                <Icon name="folder" />
                <span>{t('Import Connections')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ndb-menu-item"
                onClick={() => {
                  setToolsMenuOpen(false);
                  void handleExportConnections();
                }}
              >
                <Icon name="file-code" />
                <span>{t('Export Connections')}</span>
              </button>
            </div>
          </PluginPopover>

          {!sidebarAiSupported && (
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-sm ndb-topbar-ai-btn"
              title={t('AI Assistant')}
              aria-label={t('AI Assistant')}
              onClick={() => openAiAssistant()}
            >
              <Icon name="sparkles" />
              <span>AI</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Flex Area: Split Workspace + Docked Right Drawer (P1-1 — zero overlap!) */}
      <div className="ndb-main-area">
        <div className="ndb-main-split">
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
              onExportConnections={() => void handleExportConnections()}
              onImportConnections={() => void handleImportConnections()}
              onConnect={(conn) => void connectTo(conn)}
              onDisconnect={(id) => void disconnectConnection(id)}
              onSelectConnection={(id) => setActiveConnectionId(id)}
              onSwitchDatabase={(id, db) => void handleSwitchDatabase(id, db)}
              onExpandSchema={(id, db, sch) => void loadSchemaForSession(id, db, sch)}
              onExpandTable={(id, db, sch, tbl) => void loadTableStructureForCache(id, db, sch, tbl)}
              onOpenTableData={(id, db, sch, tbl) => openTableDataTab(id, db, sch, tbl)}
              onOpenTableStructure={openStructureTab}
              onOpenObjectDef={openObjectDefTab}
              onRefreshMaterializedView={(connId, db, sch, name) => {
                const sess = sessionsRef.current[connId];
                if (!sess || !isRelationalDriver(sess.driver) || !sess.driver.refreshMaterializedView) return;
                void sess.driver
                  .refreshMaterializedView(db, sch, name)
                  .then(() => notify('success', `Refreshed materialized view ${name}`))
                  .catch((err) => notify('error', err instanceof Error ? err.message : String(err)));
              }}
              onCreateDatabase={(connId) => {
                const sess = sessionsRef.current[connId];
                if (!sess || !isRelationalDriver(sess.driver)) return;
                if (sess.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                const dialect = engineToSqlDialect(sess.connection.engine);
                const tpl = `-- Edit database name and run to create\nCREATE DATABASE ${quoteIdent('new_database', dialect)};`;
                openSqlTab(connId, tpl, t('Create Database'));
              }}
              onCreateSchema={(connId) => {
                const sess = sessionsRef.current[connId];
                if (!sess || !isRelationalDriver(sess.driver)) return;
                if (sess.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                const dialect = engineToSqlDialect(sess.connection.engine);
                const tpl = `-- Edit schema name and run to create\nCREATE SCHEMA ${quoteIdent('new_schema', dialect)};`;
                openSqlTab(connId, tpl, t('Create Schema'));
              }}
              onInstallExtension={(connId, db, sch, name) => {
                const sess = sessionsRef.current[connId];
                if (!sess || !isRelationalDriver(sess.driver)) return;
                if (sess.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                const sql = `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name, 'postgres')};`;
                setDrawer({
                  kind: 'sqlPreview',
                  target: {
                    title: `${t('Install Extension')} ${name}`,
                    subtitle: 'Confirm before installing PostgreSQL extension',
                    sql,
                    dialect: 'postgres',
                    confirmLabel: t('Install Extension'),
                    onConfirm: async () => {
                      await (sess.driver as RelationalDriver).query(sql);
                      notify('success', `Installed extension ${name}`);
                      void loadSchemaForSession(connId, db, sch, true);
                    },
                  },
                });
              }}
              onToggleEvent={(connId, db, sch, name, enable) => {
                const sess = sessionsRef.current[connId];
                if (!sess || !isRelationalDriver(sess.driver)) return;
                if (sess.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                const drv = sess.driver;
                void import('../sql/routineSql')
                  .then(({ buildMysqlEventToggleSql }) => drv.query(buildMysqlEventToggleSql(db, name, enable)))
                  .then(() => {
                    notify('success', `${enable ? t('Enable Event') : t('Disable Event')}: ${name}`);
                    void loadSchemaForSession(connId, db, sch, true);
                  })
                  .catch((err) => notify('error', err instanceof Error ? err.message : String(err)));
              }}
              onToggleTrigger={(connId, db, sch, tableName, name, enable) => {
                const sess = sessionsRef.current[connId];
                if (!sess || !isRelationalDriver(sess.driver)) return;
                if (sess.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                const drv = sess.driver;
                const dialect = engineToSqlDialect(sess.connection.engine);
                void import('../sql/routineSql')
                  .then(({ buildTriggerToggleSql }) =>
                    drv.query(
                      buildTriggerToggleSql({ dialect, db, schema: sch, tableName, triggerName: name, enable }),
                    ),
                  )
                  .then(() => {
                    notify('success', `${enable ? t('Enable Trigger') : t('Disable Trigger')}: ${name}`);
                    void loadSchemaForSession(connId, db, sch, true);
                  })
                  .catch((err) => notify('error', err instanceof Error ? err.message : String(err)));
              }}
              onOpenErDiagram={openErTab}
              onOpenBiStudio={(id, initialTable) =>
                void openBiTab(id, initialTable ? { xrayTable: initialTable } : undefined)
              }
              onOpenNewQuery={openSqlTab}
              onOpenRedisTab={openRedisTab}
              onOpenGraphTab={openGraphTab}
              onOpenSearchIndex={openSearchIndexTab}
              onOpenKvTab={openKvTab}
              onOpenMqTab={openMqTab}
              onOpenMongoCollection={openMongoCollectionTab}
              onCreateMongoCollection={(connectionId, database) => {
                const sess = sessionsRef.current[connectionId];
                if (sess?.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                setDrawer({ kind: 'createCollection', connectionId, database });
              }}
              onDropMongoCollection={async (connectionId, database, collection) => {
                const sess = sessionsRef.current[connectionId];
                if (!sess || !isMongoDriver(sess.driver)) return;
                if (sess.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                try {
                  await sess.driver.dropCollection(database, collection);
                  const cols = await sess.driver.listCollections(database);
                  updateSession(connectionId, (cur) => ({
                    ...cur,
                    mongoCollectionsByDb: { ...cur.mongoCollectionsByDb, [database]: cols },
                  }));
                  notify('success', `Dropped collection ${collection}`);
                } catch (err) {
                  notify('error', err instanceof Error ? err.message : String(err));
                }
              }}
              onOpenCreateTable={(connectionId, database, schema) => {
                if (sessionsRef.current[connectionId]?.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                setDrawer({ kind: 'createTable', target: { connectionId, database, schema } });
              }}
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
                  openSchemaDiffTab(connectionId, sql, 'dump');
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
              onTruncateTable={(connectionId, database, schema, table) => {
                const sess = sessionsRef.current[connectionId];
                if (!sess || !isRelationalDriver(sess.driver)) return;
                if (sess.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                setDrawer({
                  kind: 'sqlPreview',
                  target: {
                    title: `Truncate ${table}`,
                    subtitle: 'Confirm before removing all rows',
                    sql: sess.family === 'sqlite' ? `DELETE FROM "${table}";` : `TRUNCATE TABLE "${schema}"."${table}";`,
                    dialect: engineToSqlDialect(sess.connection.engine),
                    confirmLabel: t('Truncate Table'),
                    danger: true,
                    onConfirm: async () => {
                      await (sess.driver as RelationalDriver).truncateTable(database, schema, table);
                      markSqliteDirty(connectionId);
                      notify('success', `Truncated ${table}`);
                      void loadSchemaForSession(connectionId, database, schema, true);
                    },
                  },
                });
              }}
              onDropObject={(connectionId, database, schema, name, kind, tableName) => {
                const sess = sessionsRef.current[connectionId];
                if (!sess || !isRelationalDriver(sess.driver)) return;
                if (sess.connection.readOnly) {
                  notify('warning', t('Read-only connection: write operation blocked'));
                  return;
                }
                const dialect = engineToSqlDialect(sess.connection.engine);
                const dropSql = buildDropObjectSql(dialect, database, schema, name, kind, false, tableName);
                setDrawer({
                  kind: 'sqlPreview',
                  target: {
                    title: `Drop ${kind.replaceAll('_', ' ')} ${name}`,
                    subtitle: 'Destructive DDL — review carefully before executing',
                    sql: dropSql,
                    dialect,
                    confirmLabel: t('Drop Object'),
                    danger: true,
                    onConfirm: async () => {
                      const drv = sess.driver as RelationalDriver;
                      await drv.dropObject(database, schema, name, kind, false, tableName);
                      markSqliteDirty(connectionId);
                      notify('success', `Dropped ${kind.replaceAll('_', ' ')} ${name}`);
                      if (kind === 'database') {
                        const dbs = await drv.listDatabases().catch(() => sess.databases);
                        updateSession(connectionId, (cur) => ({ ...cur, databases: dbs }));
                      } else if (kind === 'schema') {
                        const schs = await drv.listSchemas(database).catch(() => sess.schemas);
                        updateSession(connectionId, (cur) => ({ ...cur, schemas: schs }));
                      } else {
                        void loadSchemaForSession(connectionId, database, schema, true);
                      }
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
                await storage.deleteBiDashboard(conn.id);
                const next = connectionsRef.current.filter((c) => c.id !== conn.id);
                setConnections(next);
                await storage.saveConnections(next);
                notify('info', `Deleted ${conn.name}`);
              }}
              onSaveSqlite={(id, saveAs) => void handleSaveSqliteFile(id, saveAs)}
              onCopyText={(text, label) => void copyText(text, label)}
              onRefreshSchema={(id, db, sch) => void loadSchemaForSession(id, db, sch, true)}
              onOpenContextMenu={(x, y, items) => setContextMenu({ x, y, items })}
            />

            {/* Right Pane: Tabbed IDE Workspace */}
            <section className="ndb-workspace">
              {tabs.length > 0 && (
                <nav className="ndb-tabbar" aria-label="Workspace tabs">
                  {[...tabs].sort((a, b) => Number(pinnedTabIds.includes(b.id)) - Number(pinnedTabIds.includes(a.id))).map((tab) => {
                    const isActive = tab.id === activeTabId;
                    const isPinned = pinnedTabIds.includes(tab.id);
                    const tabConn = connById.get(tab.connectionId);
                    return (
                      <div
                        key={tab.id}
                        className={`ndb-tab ${isActive ? 'is-active' : ''} ${isPinned ? 'is-pinned' : ''}`}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          const menuItems: ContextMenuItem[] = [
                            {
                              id: 'pin',
                              label: isPinned ? t('Unpin Tab') : t('Pin Tab'),
                              onSelect: () => togglePinTab(tab.id),
                            },
                            { id: 'close', label: t('Close Tab'), dividerBefore: true, onSelect: () => closeTab(tab.id) },
                            { id: 'close-others', label: t('Close Others'), disabled: tabs.length <= 1, onSelect: () => closeOtherTabs(tab.id) },
                            { id: 'close-all', label: t('Close All'), onSelect: () => closeAllTabs() },
                          ];
                          if (tab.kind === 'sql' || tab.kind === 'table') {
                            menuItems.push({
                              id: 'dup',
                              label: t('Duplicate Tab'),
                              dividerBefore: true,
                              onSelect: () => duplicateTab(tab),
                            });
                          }
                          if (recentlyClosedTabs.length > 0) {
                            menuItems.push({
                              id: 'reopen-last',
                              label: `${t('Recently Closed Tabs')}: ${recentlyClosedTabs[0].title}`,
                              dividerBefore: true,
                              onSelect: () => reopenClosedTab(recentlyClosedTabs[0]),
                            });
                          }
                          setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
                        }}
                      >
                        <button
                          type="button"
                          className="ndb-tab-btn"
                          aria-pressed={isActive}
                          title={tabConn ? `${tabConn.name} — ${tab.title}` : tab.title}
                          onClick={() => {
                            activeTabIdRef.current = tab.id;
                            setActiveTabId(tab.id);
                            setActiveConnectionId(tab.connectionId);
                          }}
                        >
                          {tabConn && tabConn.color !== 'none' && <EnvColorDot color={tabConn.color} />}
                          <Icon name={TAB_ICON[tab.kind]} />
                          <span className="ndb-truncate">{tab.title}</span>
                          {tab.dirty && <span className="ndb-dirty-dot" aria-label="Unsaved changes" />}
                        </button>
                        <button
                          type="button"
                          className="ndb-tab-close"
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
                      className="ndb-tab-add"
                      title={t('New Query')}
                      aria-label={t('New Query')}
                      onClick={() => openSqlTab(activeSession.connectionId)}
                    >
                      <Icon name="plus" />
                    </button>
                  )}
                </nav>
              )}

              {/* Connection Dropped 1-Click Reconnect Banner (P1-5) */}
              {activeSession?.disconnected && (
                <div className="ndb-reconnect-banner" role="alert">
                  <Icon name="alert-circle" />
                  <span>{`${t('Connection lost')} (${activeSession.connection.name})`}</span>
                  <div className="ndb-spacer" />
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-primary ndb-btn-xs"
                    disabled={connectingId === activeSession.connectionId}
                    onClick={() => void connectTo(activeSession.connection)}
                  >
                    <Icon name={connectingId === activeSession.connectionId ? 'loader' : 'refresh'} />
                    {t('Reconnect')}
                  </button>
                </div>
              )}

              <div className="ndb-workspace-stage">
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
                    onImportConnections={() => void handleImportConnections()}
                    onExportConnections={() => void handleExportConnections()}
                    onConnect={(conn) => void connectTo(conn)}
                    onEdit={(conn) => void openEditDrawer(conn)}
                  />
                ) : (
                  <Suspense
                    fallback={
                      <div className="ndb-lazy-loading">
                        <Icon name="loader" />
                        <span>{t('Loading...')}</span>
                      </div>
                    }
                  >
                {activeTab.kind === 'sql' ? (
                  <SqlQueryTab
                    tab={activeTab}
                    session={activeSession}
                    completionSchema={activeCompletionSchema}
                    t={t}
                    onUpdateTab={(patch) => updateTab<SqlQueryTabState>(activeTab.id, patch)}
                    onExecute={(sql) => void handleExecuteSqlTab(activeTab.id, sql)}
                    onExecuteMultiDb={async (sql, databases) => {
                      if (!isRelationalDriver(activeSession.driver)) return;
                      if (activeSession.connection.readOnly && classifySqlRisk(sql, activeTab.dialect).isWrite) {
                        notify('warning', t('Read-only connection: write operation blocked'));
                        return;
                      }
                      const origDb = activeSession.activeDatabase;
                      const combinedResults: QueryResultSet[] = [];
                      const msgs = [...activeTab.messages];
                      updateTab<SqlQueryTabState>(activeTab.id, { running: true });
                      try {
                        for (const targetDb of databases) {
                          if (activeSession.driver.switchDatabase && targetDb !== activeSession.activeDatabase) {
                            await activeSession.driver.switchDatabase(targetDb);
                          }
                          const res = await activeSession.driver.query(sql, { database: targetDb });
                          for (const r of res.results) {
                            combinedResults.push({ ...r, sql: `[${targetDb}] ${r.sql}` });
                          }
                          msgs.push({
                            time: Date.now(),
                            level: 'success',
                            text: `[${targetDb}] ${res.results.length} result set(s) in ${res.totalExecutionMs} ms`,
                          });
                        }
                        if (activeSession.driver.switchDatabase && origDb) {
                          await activeSession.driver.switchDatabase(origDb).catch(() => {});
                        }
                        updateTab<SqlQueryTabState>(activeTab.id, {
                          running: false,
                          results: combinedResults,
                          activeResultTab: combinedResults.length > 0 ? 0 : 'messages',
                          messages: msgs,
                        });
                      } catch (err) {
                        updateTab<SqlQueryTabState>(activeTab.id, {
                          running: false,
                          activeResultTab: 'messages',
                          messages: [
                            ...msgs,
                            { time: Date.now(), level: 'error', text: err instanceof Error ? err.message : String(err), sql },
                          ],
                        });
                      }
                    }}
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
                        checkDisconnect(activeSession.connectionId, err);
                        updateTab<SqlQueryTabState>(activeTab.id, {
                          running: false,
                          activeResultTab: 'messages',
                          messages: [
                            ...activeTab.messages,
                            { time: Date.now(), level: 'error', text: err instanceof Error ? err.message : String(err), sql },
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
                      markSqliteDirty(activeSession.connectionId);
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
                    onOpenAi={() => openAiAssistant()}
                    onFixWithAi={(errorText, failedSql) =>
                      openAiAssistant({
                        initialMode: 'fix',
                        initialPrompt: `Fix this SQL error and open the corrected SQL in a new tab (or verify if read-only):\n\nError: ${errorText}\n\nFailed SQL:\n${failedSql}`,
                        autoSend: true,
                      })
                    }
                    onExportResult={(res: QueryResultSet, fmt: ExportFormat) =>
                      void handleExportDataset(
                        activeTab.title.replace(/\s+/g, '_'),
                        res.columns.map((c) => c.name),
                        res.rows,
                        activeTab.dialect,
                        fmt,
                      )
                    }
                    onPinChartToBi={(payload) =>
                      void openBiTab(activeTab.connectionId, { pinChart: payload })
                    }
                    onExportChartSvg={(detail) => void handleExportBiChartSvg(detail)}
                    onExportChartPng={(detail) => void handleExportBiChartPng(detail)}
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
                    onCopyText={(text, label) => void copyText(text, label)}
                    onOpenContextMenu={(x, y, items) => setContextMenu({ x, y, items })}
                    onShortcut={handleWidgetShortcut}
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
                    onAnalyzeInBi={() =>
                      void openBiTab(activeTab.connectionId, {
                        xrayTable: {
                          database: activeTab.database,
                          schema: activeTab.schema,
                          table: activeTab.table,
                        },
                      })
                    }
                    onOpenImport={() => {
                      if (activeSession.connection.readOnly) {
                        notify('warning', t('Read-only connection: write operation blocked'));
                        return;
                      }
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
                      });
                    }}
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
                            markSqliteDirty(activeSession.connectionId);
                            notify('success', `Committed ${preview.statements.length} changes to ${activeTab.table}`);
                            await reloadTableTab(activeTab.id);
                          },
                        },
                      });
                    }}
                    onCommitChanges={() => void commitTableChanges(activeTab, activeSession)}
                    onDiscardChanges={() =>
                      updateTab<TableDataTabState>(activeTab.id, {
                        dirtyCells: {},
                        insertedRows: [],
                        deletedRowIndices: [],
                        undoStack: [],
                        redoStack: [],
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
                          editable: !activeSession.connection.readOnly && activeSession.family !== 'clickhouse',
                        },
                      })
                    }
                    onCopyText={(text, label) => void copyText(text, label)}
                    onCopyRowAsSql={async (rowObj) => {
                      const { exportSqlInserts } = await import('../sql/exportImport');
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
                    onFkJump={({ table, column, schema, value }) => {
                      const dialect = engineToSqlDialect(activeSession.connection.engine);
                      const whereExpr = `${quoteIdent(column, dialect)} = ${quoteSqlLiteral(value as CellValue, dialect)}`;
                      openTableDataTab(
                        activeTab.connectionId,
                        activeTab.database,
                        schema || activeTab.schema,
                        table,
                        whereExpr,
                      );
                    }}
                    onSaveSqliteFile={
                      activeSession.family === 'sqlite'
                        ? () => void handleSaveSqliteFile(activeSession.connectionId, false)
                        : undefined
                    }
                    onOpenContextMenu={(x, y, items) => setContextMenu({ x, y, items })}
                    onShortcut={handleWidgetShortcut}
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
                        isSqliteExportableDriver(activeSession.driver)
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
                            markSqliteDirty(activeSession.connectionId);
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
                      if (activeSession.connection.readOnly) {
                        notify('warning', t('Read-only connection: write operation blocked'));
                        return;
                      }
                      updateTab<StructureDesignerTabState>(activeTab.id, { applying: true, error: undefined });
                      try {
                        const stmts =
                          isSqliteExportableDriver(activeSession.driver)
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
                        markSqliteDirty(activeSession.connectionId);
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
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'objectDef' ? (
                  <ObjectDefTab
                    tab={activeTab}
                    session={activeSession}
                    t={t}
                    onOpenInQuery={(sql) => openSqlTab(activeTab.connectionId, sql, activeTab.name)}
                    onRunInQuery={(sql, title) => {
                      const newId = openSqlTab(activeTab.connectionId, sql, title || activeTab.name);
                      if (newId) setTimeout(() => void handleExecuteSqlTab(newId, sql), 0);
                    }}
                    onCopyDdl={(sql) => void copyText(sql, `${activeTab.name} DDL`)}
                    onOpenViewData={
                      activeTab.objectKind === 'view' || activeTab.objectKind === 'materialized_view'
                        ? () => openTableDataTab(activeTab.connectionId, activeTab.database, activeTab.schema, activeTab.name)
                        : undefined
                    }
                    onExecuteSql={async (sql, label) => {
                      if (!isRelationalDriver(activeSession.driver)) return;
                      if (activeSession.connection.readOnly) {
                        throw new Error(t('Read-only connection: write operation blocked'));
                      }
                      await activeSession.driver.query(sql);
                      markSqliteDirty(activeSession.connectionId);
                      notify('success', label || t('Executed'));
                      void loadSchemaForSession(activeTab.connectionId, activeTab.database, activeTab.schema, true);
                    }}
                    onUpdateTab={(patch) => updateTab<ObjectDefTabState>(activeTab.id, patch)}
                    onShortcut={handleGlobalShortcut}
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
                        openSchemaDiffTab(activeTab.connectionId, sql, 'dump');
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
                    onExportSvg={async (svg) => {
                      try {
                        const res = await context.ui.saveFile({
                          title: t('Export SVG'),
                          defaultName: `er_${activeTab.schema || activeTab.database}.svg`,
                          filters: [{ name: 'SVG Image', extensions: ['svg'] }],
                          data: svg,
                          encoding: 'utf8',
                        });
                        if (!res.cancelled) notify('success', `Exported ${res.name}`);
                      } catch (err) {
                        notify('error', err instanceof Error ? err.message : String(err));
                      }
                    }}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'bi' ? (
                  <BiAnalyticsTab
                    tab={activeTab}
                    session={activeSession}
                    context={context}
                    t={t}
                    onUpdateTab={(patch) => updateTab<BiAnalyticsTabState>(activeTab.id, patch)}
                    onPersistCards={(connId, cards) => void storage.saveBiDashboard(connId, cards)}
                    onOpenSqlInQuery={(sql, title) => openSqlTab(activeTab.connectionId, sql, title)}
                    onOpenAiSidebar={(prompt) => openAiAssistant(prompt ? { initialPrompt: prompt } : undefined)}
                    onNewSqlQuery={() => openSqlTab(activeTab.connectionId)}
                    onSaveExportFile={async (opts) => {
                      try {
                        const res = await context.ui.saveFile({
                          title: opts.title,
                          defaultName: opts.defaultName,
                          filters: [{ name: opts.filterName, extensions: [opts.extension] }],
                          data: opts.data,
                          encoding: opts.encoding ?? 'utf8',
                        });
                        if (!res.cancelled) notify('success', `${t('Exported')} ${res.name}`);
                      } catch (err) {
                        notify('error', err instanceof Error ? err.message : String(err));
                      }
                    }}
                    onNotify={notify}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'redis' && isRedisDriver(activeSession.driver) ? (
                  <RedisWorkbenchTab
                    tab={activeTab}
                    driver={activeSession.driver as RedisDriver}
                    readOnly={Boolean(activeSession.connection.readOnly)}
                    t={t}
                    onUpdateTab={(patch) => updateTab<RedisWorkbenchTabState>(activeTab.id, patch)}
                    onScan={(opts) => scanRedisTab(activeTab.id, opts)}
                    onSelectKey={async (key) => {
                      updateTab<RedisWorkbenchTabState>(activeTab.id, { selectedKey: key });
                      try {
                        const drv = activeSession.driver as RedisDriver;
                        const [detail, mem] = await Promise.all([
                          drv.getKeyDetail(key),
                          drv.memoryUsage(key).catch(() => null),
                        ]);
                        updateTab<RedisWorkbenchTabState>(activeTab.id, {
                          keyDetail: mem !== null ? { ...detail, size: mem } : detail,
                        });
                      } catch (err) {
                        checkDisconnect(activeSession.connectionId, err);
                        notify('error', err instanceof Error ? err.message : String(err));
                      }
                    }}
                    onNotify={notify}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'mongo' && isMongoDriver(activeSession.driver) ? (
                  <MongoWorkbenchTab
                    tab={activeTab}
                    driver={activeSession.driver as MongoDriver}
                    readOnly={Boolean(activeSession.connection.readOnly)}
                    t={t}
                    onUpdateTab={(patch) => updateTab<MongoWorkbenchTabState>(activeTab.id, patch)}
                    onRun={(opts) => runMongoTab(activeTab.id, opts)}
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
                    onAnalyzeSchema={() => analyzeMongoSchemaTab(activeTab.id)}
                    onPinToBi={({ title, collection, pipelineJson, documents, executionMs }) => {
                      void (async () => {
                        try {
                          const [{ parseMongoEjson }, mongoTabular, { recommendChartConfig }] =
                            await Promise.all([
                              import('../drivers/mongoDriver'),
                              import('../bi/mongoTabular'),
                              import('../bi/autoChart'),
                            ]);
                          const parsedPipe: unknown = pipelineJson.trim() ? parseMongoEjson<unknown>(pipelineJson) : [];
                          const assertSafe: (p: unknown) => asserts p is Record<string, unknown>[] =
                            mongoTabular.assertReadOnlyMongoPipeline;
                          assertSafe(parsedPipe);
                          const queryText = mongoTabular.formatMongoBiQuery({
                            database: activeTab.database,
                            collection,
                            pipeline: parsedPipe,
                          });
                          const result = mongoTabular.flattenMongoDocsToResultSet(documents, executionMs, queryText);
                          if (result.columns.length === 0) {
                            notify('warning', t('Query returned no tabular columns to chart.'));
                            return;
                          }
                          const chartConfig = recommendChartConfig(result);
                          await openBiTab(activeTab.connectionId, {
                            pinChart: { title, sql: queryText, result, chartConfig },
                          });
                        } catch (err) {
                          notify('error', err instanceof Error ? err.message : String(err));
                        }
                      })();
                    }}
                    onCopyText={(text, label) => void copyText(text, label)}
                    onNotify={notify}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'graph' && isGraphDriver(activeSession.driver) ? (
                  <GraphWorkbenchTab
                    tab={activeTab}
                    driver={activeSession.driver as GraphDriver}
                    readOnly={Boolean(activeSession.connection.readOnly)}
                    t={t}
                    onUpdateTab={(patch) => updateTab<GraphWorkbenchTabState>(activeTab.id, patch)}
                    onRunCypher={(cypherOverride) => runGraphTab(activeTab.id, cypherOverride)}
                    onRefreshSchema={async () => {
                      try {
                        const gSchema = await (activeSession.driver as GraphDriver).getSchemaSummary(activeTab.database);
                        updateTab<GraphWorkbenchTabState>(activeTab.id, { schema: gSchema });
                        updateSession(activeSession.connectionId, (cur) => ({
                          ...cur,
                          graphSchemaByDb: { ...(cur.graphSchemaByDb ?? {}), [activeTab.database]: gSchema },
                        }));
                      } catch (err) {
                        notify('error', err instanceof Error ? err.message : String(err));
                      }
                    }}
                    onExportSvg={async (svg) => {
                      const res = await context.ui.saveFile({
                        title: t('Export SVG'),
                        defaultName: `graph_${activeTab.database || 'neo4j'}.svg`,
                        filters: [{ name: 'SVG Image', extensions: ['svg'] }],
                        data: svg,
                        encoding: 'utf8',
                      });
                      if (!res.cancelled) notify('success', `Exported ${res.name}`);
                    }}
                    onCopyText={(text, label) => void copyText(text, label)}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'search' && isSearchDriver(activeSession.driver) ? (
                  <SearchWorkbenchTab
                    tab={activeTab}
                    driver={activeSession.driver as SearchDriver}
                    readOnly={Boolean(activeSession.connection.readOnly)}
                    t={t}
                    onUpdateTab={(patch) => updateTab<SearchWorkbenchTabState>(activeTab.id, patch)}
                    onRunSearch={(opts) => runSearchTab(activeTab.id, opts)}
                    onLoadMapping={async () => {
                      try {
                        const mapping = await (activeSession.driver as SearchDriver).getIndexSchema(activeTab.index);
                        updateTab<SearchWorkbenchTabState>(activeTab.id, { mapping });
                      } catch (err) {
                        notify('error', err instanceof Error ? err.message : String(err));
                      }
                    }}
                    onNotify={notify}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'kv' && isKvDriver(activeSession.driver) ? (
                  <KvWorkbenchTab
                    tab={activeTab}
                    driver={activeSession.driver as KvDriver}
                    readOnly={Boolean(activeSession.connection.readOnly)}
                    t={t}
                    onUpdateTab={(patch) => updateTab<KvWorkbenchTabState>(activeTab.id, patch)}
                    onReload={(prefixOverride) => reloadKvTab(activeTab.id, prefixOverride)}
                    onSelectKey={async (entry: KvEntry) => {
                      updateTab<KvWorkbenchTabState>(activeTab.id, { selectedKey: entry.key, selectedEntry: entry });
                      try {
                        const full = await (activeSession.driver as KvDriver).getKey(entry.key, {
                          namespace: activeTab.namespace || undefined,
                          group: entry.group,
                        });
                        if (full) updateTab<KvWorkbenchTabState>(activeTab.id, { selectedEntry: full });
                      } catch (err) {
                        notify('error', err instanceof Error ? err.message : String(err));
                      }
                    }}
                    onNotify={notify}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'diff' && isRelationalDriver(activeSession.driver) ? (
                  <SchemaDiffTab
                    tab={activeTab}
                    session={activeSession}
                    sessions={sessions}
                    t={t}
                    onUpdateTab={(patch) => updateTab<SchemaDiffTabState>(activeTab.id, patch)}
                    onRunDiff={async () => {
                      const leftSess = sessionsRef.current[activeTab.leftConnectionId] ?? activeSession;
                      const rightSess = sessionsRef.current[activeTab.rightConnectionId] ?? activeSession;
                      if (!isRelationalDriver(leftSess.driver) || !isRelationalDriver(rightSess.driver)) return;
                      updateTab<SchemaDiffTabState>(activeTab.id, { loading: true, error: undefined });
                      try {
                        const loadSnap = async (sess: ActiveSession, db: string, sch: string): Promise<SchemaSnapshot> => {
                          const drv = sess.driver as RelationalDriver;
                          const [tbls, views, routines, triggers, sequences] = await Promise.all([
                            drv.listTables(db, sch),
                            drv.listViews(db, sch).catch(() => []),
                            drv.listRoutines(db, sch).catch(() => []),
                            drv.listTriggers(db, sch).catch(() => []),
                            drv.listSequences ? drv.listSequences(db, sch).catch(() => []) : Promise.resolve([]),
                          ]);
                          const structs = await Promise.all(tbls.map((tb) => drv.getTableStructure(db, sch, tb.name)));
                          return {
                            dialect: engineToSqlDialect(sess.connection.engine),
                            database: db,
                            schema: sch,
                            tables: structs,
                            views,
                            routines,
                            triggers,
                            sequences,
                          };
                        };
                        const [leftSnap, rightSnap] = await Promise.all([
                          loadSnap(leftSess, activeTab.leftDatabase || leftSess.activeDatabase, activeTab.leftSchema),
                          loadSnap(rightSess, activeTab.rightDatabase || rightSess.activeDatabase, activeTab.rightSchema),
                        ]);
                        const diffResult = (rightSess.driver as RelationalDriver).diffSchemas(leftSnap, rightSnap);
                        updateTab<SchemaDiffTabState>(activeTab.id, {
                          loading: false,
                          diffResult,
                          selectedItemIds: diffResult.items.map((item) => item.id),
                        });
                      } catch (err) {
                        updateTab<SchemaDiffTabState>(activeTab.id, {
                          loading: false,
                          error: err instanceof Error ? err.message : String(err),
                        });
                      }
                    }}
                    onApplySelectedDiff={(statements) => {
                      const targetSess = sessionsRef.current[activeTab.rightConnectionId] ?? activeSession;
                      if (!isRelationalDriver(targetSess.driver) || statements.length === 0) return;
                      if (targetSess.connection.readOnly) {
                        notify('warning', t('Read-only connection: write operation blocked'));
                        return;
                      }
                      setDrawer({
                        kind: 'sqlPreview',
                        target: {
                          title: `Apply Migration → ${targetSess.connection.name}`,
                          subtitle: `${statements.length} statement(s)`,
                          sql: statements.join('\n\n'),
                          dialect: engineToSqlDialect(targetSess.connection.engine),
                          confirmLabel: t('Apply Selected'),
                          danger: true,
                          onConfirm: async () => {
                            await (targetSess.driver as RelationalDriver).applyBatchMutations(statements);
                            markSqliteDirty(targetSess.connectionId);
                            notify('success', `Applied ${statements.length} migration statement(s)`);
                            void loadSchemaForSession(
                              targetSess.connectionId,
                              activeTab.rightDatabase || targetSess.activeDatabase,
                              activeTab.rightSchema,
                              true,
                            );
                          },
                        },
                      });
                    }}
                    onRunDump={async () => {
                      const leftSess = sessionsRef.current[activeTab.leftConnectionId] ?? activeSession;
                      if (!isRelationalDriver(leftSess.driver)) return;
                      updateTab<SchemaDiffTabState>(activeTab.id, { loading: true, error: undefined });
                      try {
                        const dumpSql = await leftSess.driver.dumpDatabaseSql(
                          activeTab.leftDatabase || leftSess.activeDatabase,
                          activeTab.leftSchema,
                          activeTab.dumpTables.length > 0 ? activeTab.dumpTables : undefined,
                          activeTab.includeData,
                        );
                        updateTab<SchemaDiffTabState>(activeTab.id, {
                          loading: false,
                          dumpSql,
                        });
                      } catch (err) {
                        updateTab<SchemaDiffTabState>(activeTab.id, {
                          loading: false,
                          error: err instanceof Error ? err.message : String(err),
                        });
                      }
                    }}
                    onPickRestoreFile={async () => {
                      const res = await context.ui.openFile({
                        title: t('Choose SQL File...'),
                        filters: [{ name: 'SQL Dump', extensions: ['sql', 'txt'] }],
                        readAs: 'utf8',
                      });
                      if (!res.cancelled) {
                        updateTab<SchemaDiffTabState>(activeTab.id, {
                          restoreFileName: res.name,
                          restoreSql: String(res.data),
                          restoreProgress: null,
                          restoreResult: null,
                        });
                      }
                    }}
                    onRunRestore={async () => {
                      if (activeSession.connection.readOnly) {
                        notify('warning', t('Read-only connection: write operation blocked'));
                        return;
                      }
                      updateTab<SchemaDiffTabState>(activeTab.id, { loading: true, error: undefined, restoreResult: null });
                      try {
                        const { restoreSqlDump } = await import('../sql/dataTransfer');
                        const res = await restoreSqlDump(
                          activeSession.driver as RelationalDriver,
                          activeTab.restoreSql,
                          { continueOnError: activeTab.restoreContinueOnError },
                          (progress) => updateTab<SchemaDiffTabState>(activeTab.id, { restoreProgress: progress }),
                        );
                        markSqliteDirty(activeSession.connectionId);
                        updateTab<SchemaDiffTabState>(activeTab.id, { loading: false, restoreResult: res });
                        notify(res.failed > 0 ? 'warning' : 'success', `Restored ${res.succeeded}/${res.totalStatements} statements`);
                        void loadSchemaForSession(activeSession.connectionId, activeSession.activeDatabase, activeSession.activeSchema, true);
                      } catch (err) {
                        updateTab<SchemaDiffTabState>(activeTab.id, {
                          loading: false,
                          error: err instanceof Error ? err.message : String(err),
                        });
                      }
                    }}
                    onRunTransfer={async () => {
                      const srcSess = sessionsRef.current[activeTab.leftConnectionId] ?? activeSession;
                      const tgtSess = sessionsRef.current[activeTab.rightConnectionId] ?? activeSession;
                      if (!isRelationalDriver(srcSess.driver) || !isRelationalDriver(tgtSess.driver)) return;
                      if (tgtSess.connection.readOnly) {
                        notify('warning', t('Read-only connection: write operation blocked'));
                        return;
                      }
                      updateTab<SchemaDiffTabState>(activeTab.id, { loading: true, error: undefined, transferResult: null });
                      try {
                        const { transferTables } = await import('../sql/dataTransfer');
                        const res = await transferTables(
                          srcSess.driver,
                          tgtSess.driver,
                          activeTab.transferTables,
                          {
                            sourceDatabase: activeTab.leftDatabase || srcSess.activeDatabase,
                            sourceSchema: activeTab.leftSchema,
                            targetDatabase: activeTab.rightDatabase || tgtSess.activeDatabase,
                            targetSchema: activeTab.rightSchema,
                            createTables: activeTab.transferCreateTables,
                            dropTargetIfExists: activeTab.transferDropIfExists,
                            includeData: activeTab.transferIncludeData,
                          },
                          (progress) => updateTab<SchemaDiffTabState>(activeTab.id, { transferProgress: progress }),
                        );
                        markSqliteDirty(tgtSess.connectionId);
                        updateTab<SchemaDiffTabState>(activeTab.id, { loading: false, transferResult: res });
                        notify('success', `Transferred ${res.totalRowsCopied} rows across ${res.tables.length} table(s)`);
                        void loadSchemaForSession(
                          tgtSess.connectionId,
                          activeTab.rightDatabase || tgtSess.activeDatabase,
                          activeTab.rightSchema,
                          true,
                        );
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
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'mq' && isMqDriver(activeSession.driver) ? (
                  <MqWorkbenchTab
                    tab={activeTab}
                    driver={activeSession.driver}
                    readOnly={Boolean(activeSession.connection.readOnly)}
                    t={t}
                    onUpdateTab={(patch) => updateTab<MqWorkbenchTabState>(activeTab.id, patch)}
                    onNotify={notify}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'monitor' ? (
                  <ServerMonitorTab
                    session={activeSession}
                    t={t}
                    onOpenSqlInQuery={(sql, title) => openSqlTab(activeTab.connectionId, sql, title || 'Monitor Query')}
                    onNotify={notify}
                  />
                ) : activeTab.kind === 'users' ? (
                  <UserAdminTab
                    session={activeSession}
                    t={t}
                    onOpenSqlInQuery={(sql, title) => openSqlTab(activeTab.connectionId, sql, title || 'User Admin')}
                    onNotify={notify}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'dataCompare' ? (
                  <DataCompareTab
                    session={activeSession}
                    sessions={sessions}
                    t={t}
                    onOpenSqlInQuery={(sql, title) => openSqlTab(activeTab.connectionId, sql, title || 'Data Sync SQL')}
                    onSaveExportFile={async (opts) => {
                      const res = await context.ui.saveFile({
                        title: opts.title,
                        defaultName: opts.defaultName,
                        filters: [{ name: opts.filterName, extensions: [opts.extension] }],
                        data: opts.data,
                        encoding: opts.encoding ?? 'utf8',
                      });
                      if (!res.cancelled) notify('success', `Saved ${res.name}`);
                    }}
                    onNotify={notify}
                    onShortcut={handleWidgetShortcut}
                  />
                ) : activeTab.kind === 'dolt' ? (
                  <DoltVersionTab
                    session={activeSession}
                    t={t}
                    onOpenSqlInQuery={(sql, title) => openSqlTab(activeTab.connectionId, sql, title || 'Dolt')}
                    onNotify={notify}
                  />
                ) : null}
                  </Suspense>
                )}
              </div>
            </section>
          </PluginSplitPane>
        </div>

        {/* Docked Right Drawer (connection picker overlays AsidePanel-style; workspace drawers dock inline) */}
        {drawer.kind !== 'none' && (
          <div className={`ndb-drawer-layer ${drawer.kind === 'connection' ? 'is-overlay' : ''}`}>
            {drawer.kind === 'connection' && (
              <Suspense
                fallback={
                  <aside className="ndb-drawer">
                    <div className="ndb-lazy-loading">
                      <Icon name="loader" />
                      <span>{t('Loading...')}</span>
                    </div>
                  </aside>
                }
              >
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
              </Suspense>
            )}

            {drawer.kind !== 'connection' && (
              <Suspense
                fallback={
                  <aside className="ndb-drawer">
                    <div className="ndb-lazy-loading">
                      <Icon name="loader" />
                      <span>{t('Loading...')}</span>
                    </div>
                  </aside>
                }
              >
            {drawer.kind === 'ai' && (
              <AiAssistantDrawer
                context={context}
                session={activeSession}
                currentSql={activeTab?.kind === 'sql' ? activeTab.sql : ''}
                options={drawer.options}
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
                  const currentSnap = {
                    dirtyCells: targetTab.dirtyCells,
                    insertedRows: targetTab.insertedRows,
                    deletedRowIndices: targetTab.deletedRowIndices,
                  };
                  const nextSnap = {
                    ...currentSnap,
                    dirtyCells: { ...targetTab.dirtyCells, [key]: isNull ? null : value },
                  };
                  const res = pushGridUndo(currentSnap, nextSnap, targetTab.undoStack ?? []);
                  updateTab<TableDataTabState>(targetTab.id, {
                    ...res.current,
                    undoStack: res.undoStack,
                    redoStack: res.redoStack,
                    dirty: res.dirty,
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

            {drawer.kind === 'confirmSql' && (
              <ConfirmSqlDrawer
                target={drawer.target}
                t={t}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}

            {drawer.kind === 'params' && (
              <SqlParameterDrawer
                target={drawer.target}
                t={t}
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
                  markSqliteDirty(drawer.target.connectionId);
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
                  markSqliteDirty(drawer.target.connectionId);
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

            {drawer.kind === 'createCollection' &&
              sessions[drawer.connectionId] &&
              isMongoDriver(sessions[drawer.connectionId].driver) && (
                <CreateCollectionDrawer
                  database={drawer.database}
                  driver={sessions[drawer.connectionId].driver as MongoDriver}
                  t={t}
                  onCreated={async (name) => {
                    const drv = sessionsRef.current[drawer.connectionId]?.driver;
                    if (drv && isMongoDriver(drv)) {
                      const cols = await drv.listCollections(drawer.database).catch(() => []);
                      updateSession(drawer.connectionId, (cur) => ({
                        ...cur,
                        mongoCollectionsByDb: { ...cur.mongoCollectionsByDb, [drawer.database]: cols },
                      }));
                    }
                    notify('success', `Created collection ${name}`);
                    openMongoCollectionTab(drawer.connectionId, drawer.database, name);
                  }}
                  onClose={() => setDrawer({ kind: 'none' })}
                />
              )}

            {drawer.kind === 'mockData' && sessions[drawer.connectionId] && (
              <MockDataDrawer
                session={sessions[drawer.connectionId]}
                initialTable={drawer.initialTable}
                t={t}
                onOpenSqlInQuery={(sql, title) => openSqlTab(drawer.connectionId, sql, title || 'Mock Data')}
                onNotify={notify}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}

            {drawer.kind === 'docsModel' && sessions[drawer.connectionId] && (
              <DocsAndModelDrawer
                session={sessions[drawer.connectionId]}
                initialTab={drawer.initialTab}
                initialTable={drawer.initialTable}
                t={t}
                onSaveExportFile={async (opts) => {
                  const res = await context.ui.saveFile({
                    title: opts.title,
                    defaultName: opts.defaultName,
                    filters: [{ name: opts.filterName, extensions: [opts.extension] }],
                    data: opts.data,
                    encoding: opts.encoding ?? 'utf8',
                  });
                  if (!res.cancelled) notify('success', `Saved ${res.name}`);
                }}
                onNotify={notify}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}

            {drawer.kind === 'globalSearch' && sessions[drawer.connectionId] && (
              <GlobalSearchDrawer
                session={sessions[drawer.connectionId]}
                initialTab={drawer.initialTab}
                t={t}
                onJumpToTable={({ database, schema, table }) => {
                  setDrawer({ kind: 'none' });
                  openTableDataTab(drawer.connectionId, database, schema, table);
                }}
                onJumpToStructure={({ database, schema, table }) => {
                  setDrawer({ kind: 'none' });
                  openStructureTab(drawer.connectionId, database, schema, table);
                }}
                onOpenSqlInQuery={(sql, title) => {
                  setDrawer({ kind: 'none' });
                  openSqlTab(drawer.connectionId, sql, title || 'Search');
                }}
                onClose={() => setDrawer({ kind: 'none' })}
              />
            )}
              </Suspense>
            )}
          </div>
        )}
      </div>

      {/* Cmd/Ctrl+K Command Palette (P0-3) */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            items={paletteItems}
            t={t}
            onClose={() => setPaletteOpen(false)}
          />
        </Suspense>
      )}

      {/* Global Right-Click Context Menu */}
      <PluginPopover
        anchorX={contextMenu?.x}
        anchorY={contextMenu?.y}
        width={220}
        open={Boolean(contextMenu)}
        onClose={() => setContextMenu(null)}
      >
        <div className="ndb-menu-list" role="menu">
          {(contextMenu?.items ?? []).map((item: ContextMenuItem) => (
            <React.Fragment key={item.id}>
              {item.dividerBefore && <div className="ndb-menu-sep" />}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`ndb-menu-item ${item.danger ? 'is-danger' : ''}`}
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
        <div className="ndb-toast-stack" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`ndb-toast ndb-toast-${toast.level}`}>
              <span>{toast.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Compact Bottom Status Strip */}
      <footer className="ndb-statusbar ndb-mono">
        {activeSession ? (
          <>
            <span className="ndb-status-item">
              <span className={activeSession.disconnected ? 'ndb-offline-dot' : 'ndb-online-dot'} />
              {`${activeSession.connection.name} (${activeSession.info.serverVersion})`}
            </span>
            <span>{activeSession.info.tlsActive ? t('TLS encrypted') : t('Plain TCP / Local')}</span>
            {activeSession.connection.readOnly && <span className="ndb-text-amber">{t('Read-Only')}</span>}
            {activeSession.connection.sshTunnel.enabled && (
              <span>{`${t('SSH Tunnel')}: ${activeSession.connection.sshTunnel.hostLabel || 'Vault Host'}`}</span>
            )}
          </>
        ) : (
          <span>{t('Disconnected')}</span>
        )}
        <span className="ndb-spacer" />
        <span>{`${Object.keys(sessions).length} ${t('active')} · ${connections.length} ${t('saved')}`}</span>
      </footer>
    </main>
  );
}
