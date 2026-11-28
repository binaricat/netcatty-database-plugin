/**
 * Left Connection Hub & Multi-DB / Multi-Schema Lazy Object Explorer (v0.3.0).
 * - Folds system schemas (pg_catalog, pg_toast, information_schema, sys, performance_schema, mysql) under a collapsed "System Schemas" node (P1-4)
 * - Expandable Table -> Columns, Indexes, Foreign Keys tree nodes (P1-4)
 * - View/Routine/Trigger Object Definition viewer launch (P0-1, P0-7)
 * - Read-Only shield badge & SQLite Save / Save As context actions (P0-2, P0-10)
 * - MongoDB collection right-click menu + Create/Drop Collection & Analyze Schema (P1-4)
 * - Export / Import Connections JSON & DBeaver data-sources.json (P1-5)
 */

import React, { useMemo, useState } from 'react';
import { Icon } from '../../Icon';
import type { DropObjectKind, RoutineSummary, TriggerSummary } from '../../drivers/types';
import { schemaCacheKey } from '../sessionManager';
import type {
  ActiveSession,
  ContextMenuItem,
  SavedConnection,
  TableSummary,
  ViewSummary,
} from '../types';
import { EngineIcon, EnvColorDot } from './EngineBadge';

const SYSTEM_SCHEMA_RE = /^(pg_catalog|pg_toast|pg_temp.*|information_schema|sys|mysql|performance_schema|system|temp)$/i;

export function isSystemSchema(s: { name: string; isSystem?: boolean }): boolean {
  return Boolean(s.isSystem || SYSTEM_SCHEMA_RE.test(s.name));
}

export interface SidebarExplorerProps {
  connections: SavedConnection[];
  sessions: Record<string, ActiveSession>;
  activeConnectionId: string | null;
  connectingId: string | null;
  theme: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onNewConnection: () => void;
  onOpenSqliteFile: () => void;
  onExportConnections: () => void;
  onImportConnections: () => void;
  onConnect: (conn: SavedConnection) => void;
  onDisconnect: (connectionId: string) => void;
  onSelectConnection: (connectionId: string) => void;
  onSwitchDatabase: (connectionId: string, database: string) => void;
  onExpandSchema: (connectionId: string, database: string, schema: string) => void;
  onExpandTable: (connectionId: string, database: string, schema: string, table: string) => void;
  onOpenTableData: (connectionId: string, database: string, schema: string, table: string) => void;
  onOpenTableStructure: (connectionId: string, database: string, schema: string, table: string) => void;
  onOpenObjectDef: (
    connectionId: string,
    obj: {
      objectKind:
        | 'view'
        | 'materialized_view'
        | 'function'
        | 'procedure'
        | 'trigger'
        | 'sequence'
        | 'event'
        | 'custom_type'
        | 'extension'
        | 'synonym'
        | 'event_trigger'
        | 'rule'
        | 'dictionary'
        | 'index'
        | 'linked_server';
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
  ) => void;
  onRefreshMaterializedView?: (connectionId: string, database: string, schema: string, name: string) => void;
  onCreateDatabase?: (connectionId: string) => void;
  onCreateSchema?: (connectionId: string, database: string) => void;
  onInstallExtension?: (connectionId: string, database: string, schema: string, name: string) => void;
  onToggleEvent?: (connectionId: string, database: string, schema: string, name: string, enable: boolean) => void;
  onToggleTrigger?: (connectionId: string, database: string, schema: string, tableName: string, name: string, enable: boolean) => void;
  onOpenErDiagram: (connectionId: string, database: string, schema: string) => void;
  onOpenBiStudio?: (
    connectionId: string,
    initialTable?: { database: string; schema: string; table: string },
  ) => void;
  onOpenNewQuery: (connectionId: string, initialSql?: string) => void;
  onOpenRedisTab: (connectionId: string, db?: number) => void;
  onOpenGraphTab?: (connectionId: string, initialCypher?: string) => void;
  onOpenSearchIndex?: (connectionId: string, index: string) => void;
  onOpenKvTab?: (connectionId: string, namespace?: string) => void;
  onOpenMqTab?: (connectionId: string, vhost?: string) => void;
  onOpenMongoCollection: (connectionId: string, database: string, collection: string, initialSubTab?: 'documents' | 'indexes' | 'schema') => void;
  onCreateMongoCollection: (connectionId: string, database: string) => void;
  onDropMongoCollection: (connectionId: string, database: string, collection: string) => void;
  onOpenCreateTable: (connectionId: string, database: string, schema: string) => void;
  onDumpSchema: (connectionId: string, database: string, schema: string, table?: string) => void;
  onExportTable: (connectionId: string, database: string, schema: string, table: string) => void;
  onTruncateTable: (connectionId: string, database: string, schema: string, table: string) => void;
  onDropObject: (
    connectionId: string,
    database: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    tableName?: string,
  ) => void;
  onEditConnection: (conn: SavedConnection) => void;
  onDuplicateConnection: (conn: SavedConnection) => void;
  onExportUri: (conn: SavedConnection) => void;
  onDeleteConnection: (conn: SavedConnection) => void;
  onSaveSqlite?: (connectionId: string, saveAs?: boolean) => void;
  onCopyText: (text: string, label: string) => void;
  onRefreshSchema: (connectionId: string, database: string, schema: string) => void;
  onOpenContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
}

export function SidebarExplorer({
  connections,
  sessions,
  activeConnectionId,
  connectingId,
  theme,
  t,
  onNewConnection,
  onOpenSqliteFile,
  onExportConnections,
  onImportConnections,
  onConnect,
  onDisconnect,
  onSelectConnection,
  onSwitchDatabase,
  onExpandSchema,
  onExpandTable,
  onOpenTableData,
  onOpenTableStructure,
  onOpenObjectDef,
  onRefreshMaterializedView,
  onCreateDatabase,
  onCreateSchema,
  onInstallExtension,
  onToggleEvent,
  onToggleTrigger,
  onOpenErDiagram,
  onOpenBiStudio,
  onOpenNewQuery,
  onOpenRedisTab,
  onOpenGraphTab,
  onOpenSearchIndex,
  onOpenKvTab,
  onOpenMqTab,
  onOpenMongoCollection,
  onCreateMongoCollection,
  onDropMongoCollection,
  onOpenCreateTable,
  onDumpSchema,
  onExportTable,
  onTruncateTable,
  onDropObject,
  onEditConnection,
  onDuplicateConnection,
  onExportUri,
  onDeleteConnection,
  onSaveSqlite,
  onCopyText,
  onRefreshSchema,
  onOpenContextMenu,
}: SidebarExplorerProps) {
  const [search, setSearch] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const isExpanded = (key: string, defaultOpen = false) =>
    Object.prototype.hasOwnProperty.call(expandedNodes, key) ? expandedNodes[key] : defaultOpen;

  const toggleNode = (key: string, defaultOpen = false) => {
    setExpandedNodes((prev) => ({ ...prev, [key]: !isExpanded(key, defaultOpen) }));
  };

  const q = search.trim().toLowerCase();

  const groupedConnections = useMemo(() => {
    const groups = new Map<string, SavedConnection[]>();
    for (const conn of connections) {
      if (q) {
        const matchConn = `${conn.name} ${conn.host} ${conn.database} ${conn.group} ${conn.engine}`
          .toLowerCase()
          .includes(q);
        const sess = sessions[conn.id];
        const matchObj =
          sess &&
          (Object.values(sess.objectsBySchema).some(
            (c) =>
              c.tables.some((tbl) => tbl.name.toLowerCase().includes(q)) ||
              c.views.some((vw) => vw.name.toLowerCase().includes(q)) ||
              c.routines.some((rt) => rt.name.toLowerCase().includes(q)),
          ) ||
            Object.values(sess.mongoCollectionsByDb).some((cols) =>
              cols.some((col) => col.name.toLowerCase().includes(q)),
            ));
        if (!matchConn && !matchObj) continue;
      }
      const grp = conn.group || '';
      const arr = groups.get(grp) ?? [];
      arr.push(conn);
      groups.set(grp, arr);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === '') return 1;
      if (b === '') return -1;
      return a.localeCompare(b);
    });
  }, [connections, sessions, q]);

  const openConnMenu = (e: React.MouseEvent, conn: SavedConnection) => {
    e.preventDefault();
    e.stopPropagation();
    const sess = sessions[conn.id];
    const online = Boolean(sess);
    const items: ContextMenuItem[] = [
      online
        ? { id: 'disconnect', label: t('Disconnect'), onSelect: () => onDisconnect(conn.id) }
        : { id: 'connect', label: t('Connect'), onSelect: () => onConnect(conn) },
      {
        id: 'query',
        label: t('New Query'),
        disabled: !online || conn.engine === 'redis' || conn.engine === 'mongodb',
        onSelect: () => onOpenNewQuery(conn.id),
      },
      ...(online && onOpenBiStudio && conn.engine !== 'redis' && conn.engine !== 'neo4j'
        ? [
            {
              id: 'bi-studio',
              label: t('Open BI Dashboard'),
              onSelect: () => onOpenBiStudio(conn.id),
            },
          ]
        : []),
      ...(online && sess && sess.family !== 'redis' && sess.family !== 'mongodb' && sess.family !== 'graph' && sess.family !== 'search' && sess.family !== 'kv' && sess.family !== 'mq' && conn.engine !== 'sqlite'
        ? [
            ...(onCreateDatabase
              ? [
                  {
                    id: 'create-db',
                    label: t('Create Database'),
                    disabled: Boolean(conn.readOnly),
                    dividerBefore: true,
                    onSelect: () => onCreateDatabase(conn.id),
                  },
                ]
              : []),
            ...(sess.activeDatabase
              ? [
                  {
                    id: 'drop-db',
                    label: `${t('Drop Database')} (${sess.activeDatabase})`,
                    danger: true,
                    disabled: Boolean(conn.readOnly),
                    onSelect: () => onDropObject(conn.id, sess.activeDatabase, '', sess.activeDatabase, 'database'),
                  },
                ]
              : []),
          ]
        : []),
      ...(online && conn.engine === 'sqlite' && onSaveSqlite
        ? [
            {
              id: 'sqlite-save',
              label: t('Save SQLite File'),
              dividerBefore: true,
              onSelect: () => onSaveSqlite(conn.id, false),
            },
            {
              id: 'sqlite-save-as',
              label: t('Save SQLite As...'),
              onSelect: () => onSaveSqlite(conn.id, true),
            },
          ]
        : []),
      { id: 'edit', label: t('Edit'), dividerBefore: true, onSelect: () => onEditConnection(conn) },
      { id: 'dup', label: t('Duplicate'), onSelect: () => onDuplicateConnection(conn) },
      { id: 'uri', label: t('Export URI'), onSelect: () => onExportUri(conn) },
      {
        id: 'delete',
        label: t('Delete'),
        danger: true,
        dividerBefore: true,
        onSelect: () => onDeleteConnection(conn),
      },
    ];
    onOpenContextMenu(e.clientX, e.clientY, items);
  };

  const openSchemaMenu = (e: React.MouseEvent, connId: string, db: string, schema: string, readOnly: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenContextMenu(e.clientX, e.clientY, [
      { id: 'er', label: t('View ER Diagram'), onSelect: () => onOpenErDiagram(connId, db, schema) },
      ...(onOpenBiStudio
        ? [
            {
              id: 'bi-studio',
              label: t('Open BI Dashboard'),
              onSelect: () => onOpenBiStudio(connId),
            },
          ]
        : []),
      {
        id: 'create-table',
        label: t('Create Table'),
        disabled: readOnly,
        onSelect: () => onOpenCreateTable(connId, db, schema),
      },
      ...(onCreateSchema
        ? [
            {
              id: 'create-schema',
              label: t('Create Schema'),
              disabled: readOnly,
              onSelect: () => onCreateSchema(connId, db),
            },
          ]
        : []),
      { id: 'dump', label: t('Dump Schema SQL'), onSelect: () => onDumpSchema(connId, db, schema) },
      { id: 'copy', label: t('Copy Name'), dividerBefore: true, onSelect: () => onCopyText(schema, schema) },
      { id: 'refresh', label: t('Refresh'), onSelect: () => onRefreshSchema(connId, db, schema) },
      ...(!isSystemSchema({ name: schema })
        ? [
            {
              id: 'drop-schema',
              label: t('Drop Schema'),
              danger: true,
              disabled: readOnly,
              dividerBefore: true,
              onSelect: () => onDropObject(connId, db, schema, schema, 'schema'),
            },
          ]
        : []),
    ]);
  };

  const openTableMenu = (
    e: React.MouseEvent,
    connId: string,
    db: string,
    schema: string,
    obj: TableSummary | ViewSummary,
    kind: 'table' | 'view',
    readOnly: boolean,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const isTable = kind === 'table';
    const items: ContextMenuItem[] = [
      { id: 'open-data', label: t('Open Data'), onSelect: () => onOpenTableData(connId, db, schema, obj.name) },
      ...(isTable
        ? [
            {
              id: 'structure',
              label: t('Design Structure'),
              onSelect: () => onOpenTableStructure(connId, db, schema, obj.name),
            },
          ]
        : [
            {
              id: 'view-def',
              label: t('View Definition'),
              onSelect: () =>
                onOpenObjectDef(connId, {
                  objectKind: 'view',
                  database: db,
                  schema,
                  name: obj.name,
                  definition: (obj as ViewSummary).definition || `-- CREATE VIEW ${obj.name}`,
                }),
            },
          ]),
      { id: 'er', label: t('View ER Diagram'), onSelect: () => onOpenErDiagram(connId, db, schema) },
      ...(onOpenBiStudio
        ? [
            {
              id: 'bi-analyze',
              label: t('Analyze in BI Dashboard'),
              onSelect: () => onOpenBiStudio(connId, { database: db, schema, table: obj.name }),
            },
          ]
        : []),
      {
        id: 'copy-name',
        label: t('Copy Name'),
        dividerBefore: true,
        onSelect: () => onCopyText(obj.name, obj.name),
      },
      {
        id: 'gen-select',
        label: t('Generate SELECT'),
        onSelect: () =>
          onOpenNewQuery(
            connId,
            `SELECT * FROM ${schema && schema !== 'main' ? `"${schema}"."${obj.name}"` : `"${obj.name}"`} LIMIT 100;`,
          ),
      },
      {
        id: 'view-ddl',
        label: t('View DDL'),
        onSelect: () => {
          if (isTable) onOpenTableStructure(connId, db, schema, obj.name);
          else {
            onOpenObjectDef(connId, {
              objectKind: 'view',
              database: db,
              schema,
              name: obj.name,
              definition: (obj as ViewSummary).definition || `-- CREATE VIEW ${obj.name}`,
            });
          }
        },
      },
      {
        id: 'export',
        label: t('Export Table'),
        dividerBefore: true,
        onSelect: () => onExportTable(connId, db, schema, obj.name),
      },
      {
        id: 'dump',
        label: t('Dump Schema SQL'),
        onSelect: () => onDumpSchema(connId, db, schema, obj.name),
      },
      ...(isTable
        ? [
            {
              id: 'truncate',
              label: t('Truncate Table'),
              danger: true,
              disabled: readOnly,
              dividerBefore: true,
              onSelect: () => onTruncateTable(connId, db, schema, obj.name),
            },
          ]
        : []),
      {
        id: 'drop',
        label: t('Drop Object'),
        danger: true,
        disabled: readOnly,
        dividerBefore: !isTable,
        onSelect: () => onDropObject(connId, db, schema, obj.name, kind),
      },
      {
        id: 'refresh',
        label: t('Refresh'),
        dividerBefore: true,
        onSelect: () => onRefreshSchema(connId, db, schema),
      },
    ];
    onOpenContextMenu(e.clientX, e.clientY, items);
  };

  const openRoutineOrTriggerMenu = (
    e: React.MouseEvent,
    connId: string,
    db: string,
    schema: string,
    item: RoutineSummary | TriggerSummary,
    kind: 'routine' | 'trigger',
    readOnly: boolean,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const isRoutine = kind === 'routine';
    const routineItem = isRoutine ? (item as RoutineSummary) : null;
    const triggerItem = isRoutine ? null : (item as TriggerSummary);
    const dropKind: DropObjectKind = isRoutine ? routineItem!.kind : 'trigger';
    const def = item.definition || `-- ${dropKind.toUpperCase()} ${item.name}`;
    onOpenContextMenu(e.clientX, e.clientY, [
      {
        id: 'view-def',
        label: t('View Definition'),
        onSelect: () =>
          onOpenObjectDef(connId, {
            objectKind: isRoutine ? routineItem!.kind : 'trigger',
            database: db,
            schema,
            name: item.name,
            tableName: triggerItem?.tableName,
            returnType: routineItem?.returnType,
            arguments: routineItem?.arguments,
            language: routineItem?.language,
            timing: triggerItem?.timing,
            event: triggerItem?.event,
            enabled: triggerItem?.enabled,
            definition: def,
          }),
      },
      { id: 'open-query', label: t('Open in Query'), onSelect: () => onOpenNewQuery(connId, def) },
      ...(triggerItem && triggerItem.tableName && onToggleTrigger
        ? [
            {
              id: 'toggle-trigger',
              label: triggerItem.enabled === false ? t('Enable Trigger') : t('Disable Trigger'),
              disabled: readOnly,
              onSelect: () =>
                onToggleTrigger(
                  connId,
                  db,
                  schema,
                  triggerItem.tableName,
                  triggerItem.name,
                  triggerItem.enabled === false,
                ),
            },
          ]
        : []),
      { id: 'copy-name', label: t('Copy Name'), dividerBefore: true, onSelect: () => onCopyText(item.name, item.name) },
      {
        id: 'drop',
        label: t('Drop Object'),
        danger: true,
        disabled: readOnly,
        dividerBefore: true,
        onSelect: () => onDropObject(connId, db, schema, item.name, dropKind, triggerItem?.tableName),
      },
    ]);
  };

  const renderSchemaBranch = (session: ActiveSession, sch: { name: string; isSystem?: boolean }) => {
    const connId = session.connectionId;
    const readOnly = Boolean(session.connection.readOnly);
    const schKey = `sch:${connId}:${session.activeDatabase}:${sch.name}`;
    const open = isExpanded(schKey, sch.name === session.activeSchema && !isSystemSchema(sch));
    const cache = session.objectsBySchema[schemaCacheKey(session.activeDatabase, sch.name)];
    const tables = (cache?.tables ?? []).filter((tbl) => !q || tbl.name.toLowerCase().includes(q));
    const allViews = (cache?.views ?? []).filter((vw) => !q || vw.name.toLowerCase().includes(q));
    const views = allViews.filter((vw) => !vw.isMaterialized);
    const matViews = allViews.filter((vw) => vw.isMaterialized);
    const allRoutines = (cache?.routines ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
    const functions = allRoutines.filter((r) => r.kind === 'function');
    const procedures = allRoutines.filter((r) => r.kind === 'procedure');
    const triggers = (cache?.triggers ?? []).filter((tr) => !q || tr.name.toLowerCase().includes(q));
    const sequences = (cache?.sequences ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
    const events = (cache?.events ?? []).filter((ev) => !q || ev.name.toLowerCase().includes(q));
    const customTypes = (cache?.customTypes ?? []).filter((ct) => !q || ct.name.toLowerCase().includes(q));
    const installedExtensions = (cache?.extensions ?? []).filter((ex) => ex.installed && (!q || ex.name.toLowerCase().includes(q)));
    const availableExtensions = (cache?.extensions ?? []).filter((ex) => !ex.installed && (!q || ex.name.toLowerCase().includes(q)));
    const synonyms = (cache?.synonyms ?? []).filter((syn) => !q || syn.name.toLowerCase().includes(q));
    const eventTriggers = (cache?.eventTriggers ?? []).filter((et) => !q || et.name.toLowerCase().includes(q));
    const rules = (cache?.rules ?? []).filter((rl) => !q || rl.name.toLowerCase().includes(q));
    const dictionaries = (cache?.dictionaries ?? []).filter((d) => !q || d.name.toLowerCase().includes(q));
    const schemaIndexes = (cache?.schemaIndexes ?? []).filter((ix) => !q || ix.name.toLowerCase().includes(q));
    const linkedServers = (cache?.linkedServers ?? []).filter((ls) => !q || ls.name.toLowerCase().includes(q));

    const tablesKey = `${schKey}:tables`;
    const viewsKey = `${schKey}:views`;
    const matViewsKey = `${schKey}:matviews`;
    const functionsKey = `${schKey}:functions`;
    const proceduresKey = `${schKey}:procedures`;
    const triggersKey = `${schKey}:triggers`;
    const sequencesKey = `${schKey}:sequences`;
    const eventsKey = `${schKey}:events`;
    const typesKey = `${schKey}:types`;
    const extensionsKey = `${schKey}:extensions`;
    const availExtKey = `${schKey}:extensions:available`;
    const synonymsKey = `${schKey}:synonyms`;
    const eventTriggersKey = `${schKey}:event_triggers`;
    const rulesKey = `${schKey}:rules`;
    const dictionariesKey = `${schKey}:dictionaries`;
    const schemaIndexesKey = `${schKey}:schema_indexes`;
    const linkedServersKey = `${schKey}:linked_servers`;

    return (
      <div key={sch.name} className="ndb-tree-branch">
        <button
          type="button"
          className={`ndb-tree-row ndb-tree-schema ${sch.name === session.activeSchema ? 'is-active-schema' : ''}`}
          onClick={() => {
            const willOpen = !open;
            toggleNode(schKey, sch.name === session.activeSchema && !isSystemSchema(sch));
            if (willOpen && !cache?.loaded && !cache?.loading) {
              onExpandSchema(connId, session.activeDatabase, sch.name);
            }
          }}
          onContextMenu={(e) => openSchemaMenu(e, connId, session.activeDatabase, sch.name, readOnly)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <Icon name="database" />
          <span className="ndb-truncate">{sch.name}</span>
          {cache?.loading && <Icon name="loader" />}
        </button>

        {open && (
          <div className="ndb-tree-children">
            {/* Tables folder */}
            <button
              type="button"
              className="ndb-tree-row ndb-tree-folder"
              onClick={() => toggleNode(tablesKey, true)}
            >
              <Icon name={isExpanded(tablesKey, true) ? 'chevron-down' : 'chevron-right'} />
              <span>{t('Tables')}</span>
              <span className="ndb-count-pill">{cache?.tables.length ?? 0}</span>
            </button>
            {isExpanded(tablesKey, true) && (
              <div className="ndb-tree-children">
                {tables.map((tbl) => {
                  const tblKey = `${schKey}:tbl:${tbl.name}`;
                  const tblOpen = isExpanded(tblKey, false);
                  const struct = cache?.structures[tbl.name];
                  const idxKey = `${tblKey}:idx`;
                  const fkKey = `${tblKey}:fk`;
                  return (
                    <div key={tbl.name} className="ndb-tree-branch">
                      <div
                        className="ndb-tree-table-wrap"
                        onContextMenu={(e) =>
                          openTableMenu(e, connId, session.activeDatabase, sch.name, tbl, 'table', readOnly)
                        }
                      >
                        <button
                          type="button"
                          className="ndb-tree-expander"
                          aria-label={`Expand ${tbl.name}`}
                          onClick={() => {
                            const willOpen = !tblOpen;
                            toggleNode(tblKey, false);
                            if (willOpen && !struct) {
                              onExpandTable(connId, session.activeDatabase, sch.name, tbl.name);
                            }
                          }}
                        >
                          <Icon name={tblOpen ? 'chevron-down' : 'chevron-right'} />
                        </button>
                        <button
                          type="button"
                          className="ndb-tree-item ndb-tree-table-btn"
                          onClick={() => onOpenTableData(connId, session.activeDatabase, sch.name, tbl.name)}
                          title={tbl.name}
                        >
                          <Icon name="table" />
                          <span className="ndb-truncate">{tbl.name}</span>
                          {tbl.rowCountEstimate !== undefined && (
                            <span className="ndb-row-est ndb-mono">{tbl.rowCountEstimate}</span>
                          )}
                        </button>
                      </div>

                      {tblOpen && (
                        <div className="ndb-tree-children ndb-tree-cols">
                          {!struct ? (
                            <span className="ndb-tree-empty">{t('Loading...')}</span>
                          ) : (
                            <>
                              {struct.columns.map((col) => {
                                const isFk = struct.foreignKeys.some((fk) => fk.columns.includes(col.name));
                                return (
                                  <div key={col.name} className="ndb-tree-col-row">
                                    {col.isPrimaryKey && <span className="ndb-badge-pk">PK</span>}
                                    {isFk && <span className="ndb-badge-fk">FK</span>}
                                    <span className="ndb-tree-col-name ndb-truncate" title={col.name}>
                                      {col.name}
                                    </span>
                                    <span className="ndb-tree-col-type ndb-mono">{col.dataType}</span>
                                  </div>
                                );
                              })}

                              {/* Expandable Indexes (P1-4) */}
                              {struct.indexes.length > 0 && (
                                <div className="ndb-tree-subbranch">
                                  <button
                                    type="button"
                                    className="ndb-tree-row ndb-tree-submeta-btn"
                                    onClick={() => toggleNode(idxKey, false)}
                                  >
                                    <Icon name={isExpanded(idxKey, false) ? 'chevron-down' : 'chevron-right'} />
                                    <span>{`${t('Indexes')} (${struct.indexes.length})`}</span>
                                  </button>
                                  {isExpanded(idxKey, false) && (
                                    <div className="ndb-tree-sublist">
                                      {struct.indexes.map((ix) => (
                                        <div key={ix.name} className="ndb-tree-col-row" title={`${ix.name} (${ix.columns.join(', ')})`}>
                                          {ix.unique && <span className="ndb-badge-pk">UQ</span>}
                                          <span className="ndb-truncate ndb-mono">{ix.name}</span>
                                          <span className="ndb-tree-col-type ndb-mono">{ix.columns.join(',')}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Expandable Foreign Keys (P1-4) */}
                              {struct.foreignKeys.length > 0 && (
                                <div className="ndb-tree-subbranch">
                                  <button
                                    type="button"
                                    className="ndb-tree-row ndb-tree-submeta-btn"
                                    onClick={() => toggleNode(fkKey, false)}
                                  >
                                    <Icon name={isExpanded(fkKey, false) ? 'chevron-down' : 'chevron-right'} />
                                    <span>{`${t('Foreign Keys')} (${struct.foreignKeys.length})`}</span>
                                  </button>
                                  {isExpanded(fkKey, false) && (
                                    <div className="ndb-tree-sublist">
                                      {struct.foreignKeys.map((fk) => (
                                        <div
                                          key={fk.name}
                                          className="ndb-tree-col-row"
                                          title={`${fk.columns.join(',')} → ${fk.referencedTable}(${fk.referencedColumns.join(',')})`}
                                        >
                                          <span className="ndb-badge-fk">FK</span>
                                          <span className="ndb-truncate ndb-mono">
                                            {`${fk.columns.join(',')} → ${fk.referencedTable}`}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {tables.length === 0 && <p className="ndb-tree-empty">{t('No results')}</p>}
              </div>
            )}

            {/* Views folder (regular views only) */}
            {views.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(viewsKey, false)}
                >
                  <Icon name={isExpanded(viewsKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Views')}</span>
                  <span className="ndb-count-pill">{views.length}</span>
                </button>
                {isExpanded(viewsKey, false) && (
                  <div className="ndb-tree-children">
                    {views.map((vw) => (
                      <button
                        key={vw.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() => onOpenTableData(connId, session.activeDatabase, sch.name, vw.name)}
                        onContextMenu={(e) =>
                          openTableMenu(e, connId, session.activeDatabase, sch.name, vw, 'view', readOnly)
                        }
                      >
                        <Icon name="eye" />
                        <span className="ndb-truncate">{vw.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Materialized Views folder (full workbench parity: separate node + Refresh action) */}
            {matViews.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(matViewsKey, false)}
                >
                  <Icon name={isExpanded(matViewsKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Materialized Views')}</span>
                  <span className="ndb-count-pill">{matViews.length}</span>
                </button>
                {isExpanded(matViewsKey, false) && (
                  <div className="ndb-tree-children">
                    {matViews.map((mv) => (
                      <button
                        key={mv.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'materialized_view',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: mv.name,
                            definition: mv.definition || `-- MATERIALIZED VIEW ${mv.name}`,
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenContextMenu(e.clientX, e.clientY, [
                            { id: 'open-data', label: t('Open Data'), onSelect: () => onOpenTableData(connId, session.activeDatabase, sch.name, mv.name) },
                            {
                              id: 'view-def',
                              label: t('View Definition'),
                              onSelect: () =>
                                onOpenObjectDef(connId, {
                                  objectKind: 'materialized_view',
                                  database: session.activeDatabase,
                                  schema: sch.name,
                                  name: mv.name,
                                  definition: mv.definition || `-- MATERIALIZED VIEW ${mv.name}`,
                                }),
                            },
                            ...(onRefreshMaterializedView
                              ? [
                                  {
                                    id: 'refresh-mv',
                                    label: t('Refresh Materialized View'),
                                    disabled: readOnly,
                                    onSelect: () => onRefreshMaterializedView(connId, session.activeDatabase, sch.name, mv.name),
                                  },
                                ]
                              : []),
                            {
                              id: 'drop-mv',
                              label: t('Drop Object'),
                              danger: true,
                              disabled: readOnly,
                              dividerBefore: true,
                              onSelect: () => onDropObject(connId, session.activeDatabase, sch.name, mv.name, 'materialized_view'),
                            },
                          ]);
                        }}
                      >
                        <Icon name="eye" />
                        <span className="ndb-truncate">{mv.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Functions folder (full workbench parity: separate from Procedures) */}
            {functions.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(functionsKey, false)}
                >
                  <Icon name={isExpanded(functionsKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Functions')}</span>
                  <span className="ndb-count-pill">{functions.length}</span>
                </button>
                {isExpanded(functionsKey, false) && (
                  <div className="ndb-tree-children">
                    {functions.map((rt) => (
                      <button
                        key={`fn:${rt.name}:${rt.arguments ?? ''}`}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'function',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: rt.name,
                            returnType: rt.returnType,
                            arguments: rt.arguments,
                            language: rt.language,
                            definition: rt.definition || `-- FUNCTION ${rt.name}(${rt.arguments ?? ''})`,
                          })
                        }
                        onContextMenu={(e) =>
                          openRoutineOrTriggerMenu(e, connId, session.activeDatabase, sch.name, rt, 'routine', readOnly)
                        }
                      >
                        <Icon name="file-code" />
                        <span className="ndb-truncate">{rt.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Procedures folder (full workbench parity) */}
            {procedures.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(proceduresKey, false)}
                >
                  <Icon name={isExpanded(proceduresKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Procedures')}</span>
                  <span className="ndb-count-pill">{procedures.length}</span>
                </button>
                {isExpanded(proceduresKey, false) && (
                  <div className="ndb-tree-children">
                    {procedures.map((rt) => (
                      <button
                        key={`proc:${rt.name}:${rt.arguments ?? ''}`}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'procedure',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: rt.name,
                            returnType: rt.returnType,
                            arguments: rt.arguments,
                            language: rt.language,
                            definition: rt.definition || `-- PROCEDURE ${rt.name}(${rt.arguments ?? ''})`,
                          })
                        }
                        onContextMenu={(e) =>
                          openRoutineOrTriggerMenu(e, connId, session.activeDatabase, sch.name, rt, 'routine', readOnly)
                        }
                      >
                        <Icon name="play" />
                        <span className="ndb-truncate">{rt.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Triggers folder */}
            {triggers.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(triggersKey, false)}
                >
                  <Icon name={isExpanded(triggersKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Triggers')}</span>
                  <span className="ndb-count-pill">{triggers.length}</span>
                </button>
                {isExpanded(triggersKey, false) && (
                  <div className="ndb-tree-children">
                    {triggers.map((tr) => (
                      <button
                        key={`${tr.tableName}:${tr.name}`}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'trigger',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: tr.name,
                            tableName: tr.tableName,
                            timing: tr.timing,
                            event: tr.event,
                            enabled: tr.enabled,
                            definition: tr.definition || `-- TRIGGER ${tr.name} ON ${tr.tableName}`,
                          })
                        }
                        onContextMenu={(e) =>
                          openRoutineOrTriggerMenu(e, connId, session.activeDatabase, sch.name, tr, 'trigger', readOnly)
                        }
                      >
                        <Icon name="sparkles" />
                        <span className="ndb-truncate">{tr.name}</span>
                        <span className="ndb-row-est">{tr.tableName}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Sequences folder (PG / MSSQL) */}
            {sequences.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(sequencesKey, false)}
                >
                  <Icon name={isExpanded(sequencesKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Sequences')}</span>
                  <span className="ndb-count-pill">{sequences.length}</span>
                </button>
                {isExpanded(sequencesKey, false) && (
                  <div className="ndb-tree-children">
                    {sequences.map((seq) => (
                      <button
                        key={seq.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'sequence',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: seq.name,
                            definition: seq.definition || `-- SEQUENCE ${seq.name}`,
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenContextMenu(e.clientX, e.clientY, [
                            {
                              id: 'seq-def',
                              label: t('View Definition'),
                              onSelect: () =>
                                onOpenObjectDef(connId, {
                                  objectKind: 'sequence',
                                  database: session.activeDatabase,
                                  schema: sch.name,
                                  name: seq.name,
                                  definition: seq.definition || `-- SEQUENCE ${seq.name}`,
                                }),
                            },
                            {
                              id: 'seq-drop',
                              label: t('Drop Object'),
                              danger: true,
                              disabled: readOnly,
                              dividerBefore: true,
                              onSelect: () => onDropObject(connId, session.activeDatabase, sch.name, seq.name, 'sequence'),
                            },
                          ]);
                        }}
                      >
                        <Icon name="key" />
                        <span className="ndb-truncate">{seq.name}</span>
                        {seq.lastValue != null && <span className="ndb-row-est ndb-mono">{seq.lastValue}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* MySQL Scheduled Events folder */}
            {events.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(eventsKey, false)}
                >
                  <Icon name={isExpanded(eventsKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Events')}</span>
                  <span className="ndb-count-pill">{events.length}</span>
                </button>
                {isExpanded(eventsKey, false) && (
                  <div className="ndb-tree-children">
                    {events.map((ev) => {
                      const evEnabled = ev.status !== 'DISABLED';
                      return (
                        <button
                          key={ev.name}
                          type="button"
                          className="ndb-tree-item"
                          onClick={() =>
                            onOpenObjectDef(connId, {
                              objectKind: 'event',
                              database: session.activeDatabase,
                              schema: sch.name,
                              name: ev.name,
                              enabled: evEnabled,
                              definition: ev.definition || `-- EVENT ${ev.name}`,
                            })
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onOpenContextMenu(e.clientX, e.clientY, [
                              {
                                id: 'ev-def',
                                label: t('View Definition'),
                                onSelect: () =>
                                  onOpenObjectDef(connId, {
                                    objectKind: 'event',
                                    database: session.activeDatabase,
                                    schema: sch.name,
                                    name: ev.name,
                                    enabled: evEnabled,
                                    definition: ev.definition || `-- EVENT ${ev.name}`,
                                  }),
                              },
                              ...(onToggleEvent
                                ? [
                                    {
                                      id: 'ev-toggle',
                                      label: evEnabled ? t('Disable Event') : t('Enable Event'),
                                      disabled: readOnly,
                                      onSelect: () => onToggleEvent(connId, session.activeDatabase, sch.name, ev.name, !evEnabled),
                                    },
                                  ]
                                : []),
                              { id: 'ev-copy', label: t('Copy Name'), dividerBefore: true, onSelect: () => onCopyText(ev.name, ev.name) },
                              {
                                id: 'ev-drop',
                                label: t('Drop Object'),
                                danger: true,
                                disabled: readOnly,
                                dividerBefore: true,
                                onSelect: () => onDropObject(connId, session.activeDatabase, sch.name, ev.name, 'event'),
                              },
                            ]);
                          }}
                        >
                          <Icon name="history" />
                          <span className="ndb-truncate">{ev.name}</span>
                          {ev.status && <span className="ndb-row-est">{ev.status}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* PostgreSQL Custom Types folder */}
            {customTypes.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(typesKey, false)}
                >
                  <Icon name={isExpanded(typesKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Custom Types')}</span>
                  <span className="ndb-count-pill">{customTypes.length}</span>
                </button>
                {isExpanded(typesKey, false) && (
                  <div className="ndb-tree-children">
                    {customTypes.map((ct) => (
                      <button
                        key={ct.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'custom_type',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: ct.name,
                            definition: ct.definition || `-- TYPE ${ct.name} (${ct.kind})`,
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenContextMenu(e.clientX, e.clientY, [
                            {
                              id: 'ct-def',
                              label: t('View Definition'),
                              onSelect: () =>
                                onOpenObjectDef(connId, {
                                  objectKind: 'custom_type',
                                  database: session.activeDatabase,
                                  schema: sch.name,
                                  name: ct.name,
                                  definition: ct.definition || `-- TYPE ${ct.name} (${ct.kind})`,
                                }),
                            },
                            { id: 'ct-copy', label: t('Copy Name'), dividerBefore: true, onSelect: () => onCopyText(ct.name, ct.name) },
                            {
                              id: 'ct-drop',
                              label: t('Drop Object'),
                              danger: true,
                              disabled: readOnly,
                              dividerBefore: true,
                              onSelect: () => onDropObject(connId, session.activeDatabase, sch.name, ct.name, 'custom_type'),
                            },
                          ]);
                        }}
                      >
                        <Icon name="settings" />
                        <span className="ndb-truncate">{ct.name}</span>
                        <span className="ndb-row-est">{ct.kind}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* PostgreSQL Extensions folder (Installed + Available) */}
            {(installedExtensions.length > 0 || availableExtensions.length > 0) && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(extensionsKey, false)}
                >
                  <Icon name={isExpanded(extensionsKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Extensions')}</span>
                  <span className="ndb-count-pill">{installedExtensions.length}</span>
                </button>
                {isExpanded(extensionsKey, false) && (
                  <div className="ndb-tree-children">
                    {installedExtensions.map((ex) => (
                      <button
                        key={`inst:${ex.name}`}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'extension',
                            database: session.activeDatabase,
                            schema: ex.schema || sch.name,
                            name: ex.name,
                            definition: `CREATE EXTENSION IF NOT EXISTS "${ex.name}" VERSION '${ex.version}';\n-- ${ex.description ?? ''}`,
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenContextMenu(e.clientX, e.clientY, [
                            {
                              id: 'ex-def',
                              label: t('View Definition'),
                              onSelect: () =>
                                onOpenObjectDef(connId, {
                                  objectKind: 'extension',
                                  database: session.activeDatabase,
                                  schema: ex.schema || sch.name,
                                  name: ex.name,
                                  definition: `CREATE EXTENSION IF NOT EXISTS "${ex.name}" VERSION '${ex.version}';\n-- ${ex.description ?? ''}`,
                                }),
                            },
                            { id: 'ex-copy', label: t('Copy Name'), dividerBefore: true, onSelect: () => onCopyText(ex.name, ex.name) },
                            {
                              id: 'ex-drop',
                              label: t('Drop Object'),
                              danger: true,
                              disabled: readOnly,
                              dividerBefore: true,
                              onSelect: () => onDropObject(connId, session.activeDatabase, ex.schema || sch.name, ex.name, 'extension'),
                            },
                          ]);
                        }}
                      >
                        <Icon name="settings" />
                        <span className="ndb-truncate">{ex.name}</span>
                        <span className="ndb-row-est ndb-mono">{ex.version}</span>
                      </button>
                    ))}
                    {availableExtensions.length > 0 && (
                      <div className="ndb-tree-subbranch">
                        <button
                          type="button"
                          className="ndb-tree-row ndb-tree-submeta-btn"
                          onClick={() => toggleNode(availExtKey, false)}
                        >
                          <Icon name={isExpanded(availExtKey, false) ? 'chevron-down' : 'chevron-right'} />
                          <span>{`${t('Available')} (${availableExtensions.length})`}</span>
                        </button>
                        {isExpanded(availExtKey, false) && (
                          <div className="ndb-tree-children">
                            {availableExtensions.slice(0, 50).map((ex) => (
                              <button
                                key={`avail:${ex.name}`}
                                type="button"
                                className="ndb-tree-item"
                                title={ex.description || ex.name}
                                onClick={() =>
                                  onOpenObjectDef(connId, {
                                    objectKind: 'extension',
                                    database: session.activeDatabase,
                                    schema: sch.name,
                                    name: ex.name,
                                    definition: `CREATE EXTENSION IF NOT EXISTS "${ex.name}";\n-- Available v${ex.version}${ex.description ? `: ${ex.description}` : ''}`,
                                  })
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onOpenContextMenu(e.clientX, e.clientY, [
                                    ...(onInstallExtension
                                      ? [
                                          {
                                            id: 'ex-install',
                                            label: t('Install Extension'),
                                            disabled: readOnly,
                                            onSelect: () => onInstallExtension(connId, session.activeDatabase, sch.name, ex.name),
                                          },
                                        ]
                                      : []),
                                    { id: 'ex-copy', label: t('Copy Name'), onSelect: () => onCopyText(ex.name, ex.name) },
                                  ]);
                                }}
                              >
                                <Icon name="plus" />
                                <span className="ndb-truncate">{ex.name}</span>
                                <span className="ndb-row-est ndb-mono">{ex.version}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* SQL Server Synonyms folder */}
            {synonyms.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(synonymsKey, false)}
                >
                  <Icon name={isExpanded(synonymsKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Synonyms')}</span>
                  <span className="ndb-count-pill">{synonyms.length}</span>
                </button>
                {isExpanded(synonymsKey, false) && (
                  <div className="ndb-tree-children">
                    {synonyms.map((syn) => (
                      <button
                        key={syn.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'synonym',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: syn.name,
                            definition: `CREATE SYNONYM [${sch.name}].[${syn.name}] FOR ${syn.baseObject};`,
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenContextMenu(e.clientX, e.clientY, [
                            {
                              id: 'syn-def',
                              label: t('View Definition'),
                              onSelect: () =>
                                onOpenObjectDef(connId, {
                                  objectKind: 'synonym',
                                  database: session.activeDatabase,
                                  schema: sch.name,
                                  name: syn.name,
                                  definition: `CREATE SYNONYM [${sch.name}].[${syn.name}] FOR ${syn.baseObject};`,
                                }),
                            },
                            { id: 'syn-copy', label: t('Copy Name'), dividerBefore: true, onSelect: () => onCopyText(syn.name, syn.name) },
                            {
                              id: 'syn-drop',
                              label: t('Drop Object'),
                              danger: true,
                              disabled: readOnly,
                              dividerBefore: true,
                              onSelect: () => onDropObject(connId, session.activeDatabase, sch.name, syn.name, 'synonym'),
                            },
                          ]);
                        }}
                      >
                        <Icon name="arrow-right" />
                        <span className="ndb-truncate">{syn.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* PostgreSQL Event Triggers folder */}
            {eventTriggers.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(eventTriggersKey, false)}
                >
                  <Icon name={isExpanded(eventTriggersKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Event Triggers')}</span>
                  <span className="ndb-count-pill">{eventTriggers.length}</span>
                </button>
                {isExpanded(eventTriggersKey, false) && (
                  <div className="ndb-tree-children">
                    {eventTriggers.map((et) => (
                      <button
                        key={et.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'event_trigger',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: et.name,
                            event: et.event,
                            enabled: et.enabled,
                            definition: et.definition || `-- EVENT TRIGGER ${et.name} ON ${et.event}`,
                          })
                        }
                      >
                        <Icon name="sparkles" />
                        <span className="ndb-truncate">{et.name}</span>
                        <span className="ndb-row-est">{et.event}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* PostgreSQL Rules folder */}
            {rules.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(rulesKey, false)}
                >
                  <Icon name={isExpanded(rulesKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Rules')}</span>
                  <span className="ndb-count-pill">{rules.length}</span>
                </button>
                {isExpanded(rulesKey, false) && (
                  <div className="ndb-tree-children">
                    {rules.map((rl) => (
                      <button
                        key={`${rl.tableName}:${rl.name}`}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'rule',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: rl.name,
                            tableName: rl.tableName,
                            definition: rl.definition || `-- RULE ${rl.name} ON ${rl.tableName}`,
                          })
                        }
                      >
                        <Icon name="file-code" />
                        <span className="ndb-truncate">{rl.name}</span>
                        <span className="ndb-row-est">{rl.tableName}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ClickHouse Dictionaries folder */}
            {dictionaries.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(dictionariesKey, false)}
                >
                  <Icon name={isExpanded(dictionariesKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Dictionaries')}</span>
                  <span className="ndb-count-pill">{dictionaries.length}</span>
                </button>
                {isExpanded(dictionariesKey, false) && (
                  <div className="ndb-tree-children">
                    {dictionaries.map((d) => (
                      <button
                        key={d.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'dictionary',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: d.name,
                            definition: `-- ClickHouse Dictionary ${d.database}.${d.name}\n-- Type: ${d.type ?? 'n/a'} · Status: ${d.status ?? 'n/a'} · Elements: ${d.elementCount ?? 0}\n-- Source: ${d.source ?? 'n/a'}`,
                          })
                        }
                      >
                        <Icon name="database" />
                        <span className="ndb-truncate">{d.name}</span>
                        {d.status && <span className="ndb-row-est">{d.status}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* SQLite Schema-Level Indexes folder */}
            {schemaIndexes.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(schemaIndexesKey, false)}
                >
                  <Icon name={isExpanded(schemaIndexesKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Indexes')}</span>
                  <span className="ndb-count-pill">{schemaIndexes.length}</span>
                </button>
                {isExpanded(schemaIndexesKey, false) && (
                  <div className="ndb-tree-children">
                    {schemaIndexes.map((ix) => (
                      <button
                        key={ix.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'index',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: ix.name,
                            tableName: ix.tableName,
                            definition: ix.definition || `-- INDEX ${ix.name} ON ${ix.tableName}`,
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenContextMenu(e.clientX, e.clientY, [
                            {
                              id: 'ix-def',
                              label: t('View Definition'),
                              onSelect: () =>
                                onOpenObjectDef(connId, {
                                  objectKind: 'index',
                                  database: session.activeDatabase,
                                  schema: sch.name,
                                  name: ix.name,
                                  tableName: ix.tableName,
                                  definition: ix.definition || `-- INDEX ${ix.name} ON ${ix.tableName}`,
                                }),
                            },
                            { id: 'ix-copy', label: t('Copy Name'), dividerBefore: true, onSelect: () => onCopyText(ix.name, ix.name) },
                            {
                              id: 'ix-drop',
                              label: t('Drop Object'),
                              danger: true,
                              disabled: readOnly,
                              dividerBefore: true,
                              onSelect: () => onDropObject(connId, session.activeDatabase, sch.name, ix.name, 'index', ix.tableName),
                            },
                          ]);
                        }}
                      >
                        <Icon name="key" />
                        <span className="ndb-truncate">{ix.name}</span>
                        <span className="ndb-row-est">{ix.tableName}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* SQL Server Linked Servers folder */}
            {linkedServers.length > 0 && (
              <>
                <button
                  type="button"
                  className="ndb-tree-row ndb-tree-folder"
                  onClick={() => toggleNode(linkedServersKey, false)}
                >
                  <Icon name={isExpanded(linkedServersKey, false) ? 'chevron-down' : 'chevron-right'} />
                  <span>{t('Linked Servers')}</span>
                  <span className="ndb-count-pill">{linkedServers.length}</span>
                </button>
                {isExpanded(linkedServersKey, false) && (
                  <div className="ndb-tree-children">
                    {linkedServers.map((ls) => (
                      <button
                        key={ls.name}
                        type="button"
                        className="ndb-tree-item"
                        onClick={() =>
                          onOpenObjectDef(connId, {
                            objectKind: 'linked_server',
                            database: session.activeDatabase,
                            schema: sch.name,
                            name: ls.name,
                            definition: `-- Linked Server: ${ls.name}\n-- Product: ${ls.product ?? 'n/a'}\n-- Provider: ${ls.provider ?? 'n/a'}\n-- Data Source: ${ls.dataSource ?? 'n/a'}\n-- Catalog: ${ls.catalog ?? 'n/a'}`,
                          })
                        }
                      >
                        <Icon name="server" />
                        <span className="ndb-truncate">{ls.name}</span>
                        {ls.product && <span className="ndb-row-est">{ls.product}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderSessionExplorer = (session: ActiveSession) => {
    const connId = session.connectionId;
    const readOnly = Boolean(session.connection.readOnly);

    if (session.family === 'redis') {
      const ksMap = new Map((session.redisInfo?.keyspace ?? []).map((k) => [k.db, k.keys]));
      return (
        <div className="ndb-explorer-body">
          <div className="ndb-db-switcher">
            <select
              aria-label="Redis DB"
              value={session.activeDatabase}
              onChange={(e) => {
                const dbNum = Number(e.currentTarget.value.replace(/^DB\s*/i, '')) || 0;
                onSwitchDatabase(connId, `DB ${dbNum}`);
                onOpenRedisTab(connId, dbNum);
              }}
            >
              {Array.from({ length: 16 }, (_, i) => {
                const count = ksMap.get(i);
                return (
                  <option key={i} value={`DB ${i}`}>
                    {count !== undefined ? `DB ${i} (${count})` : `DB ${i}`}
                  </option>
                );
              })}
            </select>
          </div>
          <button
            type="button"
            className="ndb-tree-item ndb-tree-action"
            onClick={() => onOpenRedisTab(connId)}
          >
            <Icon name="key" />
            <span>{t('Open Redis Browser')}</span>
          </button>
        </div>
      );
    }

    if (session.family === 'mongodb') {
      const collections = session.mongoCollectionsByDb[session.activeDatabase] ?? [];
      const filteredCols = q
        ? collections.filter((c) => c.name.toLowerCase().includes(q))
        : collections;
      return (
        <div className="ndb-explorer-body">
          <div className="ndb-db-switcher">
            <select
              aria-label="MongoDB Database"
              value={session.activeDatabase}
              onChange={(e) => onSwitchDatabase(connId, e.currentTarget.value)}
            >
              {session.databases.map((db) => (
                <option key={db.name} value={db.name}>
                  {db.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ndb-tree-section-label">
            <span>{t('Collections')}</span>
            <div className="ndb-inline-row">
              <span className="ndb-count-pill">{collections.length}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="ndb-tree-expander"
                  title={t('Create Collection')}
                  aria-label={t('Create Collection')}
                  onClick={() => onCreateMongoCollection(connId, session.activeDatabase)}
                >
                  <Icon name="plus" />
                </button>
              )}
            </div>
          </div>
          {filteredCols.map((col) => (
            <button
              key={col.name}
              type="button"
              className="ndb-tree-item"
              onClick={() => onOpenMongoCollection(connId, session.activeDatabase, col.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenContextMenu(e.clientX, e.clientY, [
                  {
                    id: 'open',
                    label: t('Open Data'),
                    onSelect: () => onOpenMongoCollection(connId, session.activeDatabase, col.name, 'documents'),
                  },
                  {
                    id: 'schema',
                    label: t('Analyze Schema'),
                    onSelect: () => onOpenMongoCollection(connId, session.activeDatabase, col.name, 'schema'),
                  },
                  {
                    id: 'indexes',
                    label: t('Indexes'),
                    onSelect: () => onOpenMongoCollection(connId, session.activeDatabase, col.name, 'indexes'),
                  },
                  {
                    id: 'copy',
                    label: t('Copy Name'),
                    dividerBefore: true,
                    onSelect: () => onCopyText(col.name, col.name),
                  },
                  {
                    id: 'drop',
                    label: t('Drop Collection'),
                    danger: true,
                    disabled: readOnly,
                    dividerBefore: true,
                    onSelect: () => onDropMongoCollection(connId, session.activeDatabase, col.name),
                  },
                ]);
              }}
            >
              <Icon name="table" />
              <span className="ndb-truncate">{col.name}</span>
            </button>
          ))}
          {filteredCols.length === 0 && <p className="ndb-tree-empty">{t('No results')}</p>}
        </div>
      );
    }

    if (session.family === 'graph') {
      const gSchema = session.graphSchemaByDb?.[session.activeDatabase];
      const labels = gSchema?.labels ?? [];
      const rels = gSchema?.relationshipTypes ?? [];
      const filteredLabels = q ? labels.filter((l) => l.label.toLowerCase().includes(q)) : labels;
      const filteredRels = q ? rels.filter((r) => r.toLowerCase().includes(q)) : rels;
      return (
        <div className="ndb-explorer-body">
          {session.databases.length > 1 && (
            <div className="ndb-db-switcher">
              <select
                aria-label="Graph Database"
                value={session.activeDatabase}
                onChange={(e) => onSwitchDatabase(connId, e.currentTarget.value)}
              >
                {session.databases.map((db) => (
                  <option key={db.name} value={db.name}>
                    {db.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            className="ndb-tree-item ndb-tree-action"
            onClick={() => onOpenGraphTab?.(connId)}
          >
            <Icon name="sparkles" />
            <span>{t('Open Cypher Graph')}</span>
          </button>
          <div className="ndb-tree-section-label">
            <span>{t('Node Labels')}</span>
            <span className="ndb-count-pill">{labels.length}</span>
          </div>
          {filteredLabels.map((lbl) => (
            <button
              key={`lbl:${lbl.label}`}
              type="button"
              className="ndb-tree-item"
              onClick={() =>
                onOpenGraphTab?.(
                  connId,
                  `MATCH (n:\`${lbl.label.replaceAll('`', '``')}\`) OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 25`,
                )
              }
            >
              <Icon name="table" />
              <span className="ndb-truncate">{`:${lbl.label}`}</span>
              {lbl.count !== undefined && <span className="ndb-count-pill">{lbl.count}</span>}
            </button>
          ))}
          <div className="ndb-tree-section-label">
            <span>{t('Relationships')}</span>
            <span className="ndb-count-pill">{rels.length}</span>
          </div>
          {filteredRels.map((rel) => (
            <button
              key={`rel:${rel}`}
              type="button"
              className="ndb-tree-item"
              onClick={() =>
                onOpenGraphTab?.(
                  connId,
                  `MATCH (a)-[r:\`${rel.replaceAll('`', '``')}\`]->(b) RETURN a, r, b LIMIT 25`,
                )
              }
            >
              <Icon name="arrow-right" />
              <span className="ndb-truncate">{rel}</span>
            </button>
          ))}
        </div>
      );
    }

    if (session.family === 'search') {
      const indices = session.searchIndices ?? [];
      const filteredIdx = q ? indices.filter((i) => i.name.toLowerCase().includes(q)) : indices;
      return (
        <div className="ndb-explorer-body">
          <div className="ndb-tree-section-label">
            <span>{t('Indices / Collections')}</span>
            <span className="ndb-count-pill">{indices.length}</span>
          </div>
          {filteredIdx.map((idx) => (
            <button
              key={idx.name}
              type="button"
              className="ndb-tree-item"
              onClick={() => onOpenSearchIndex?.(connId, idx.name)}
            >
              <Icon name="table" />
              <span className="ndb-truncate">{idx.name}</span>
              {idx.docCount !== undefined && <span className="ndb-count-pill">{idx.docCount}</span>}
            </button>
          ))}
          {filteredIdx.length === 0 && (
            <button
              type="button"
              className="ndb-tree-item ndb-tree-action"
              onClick={() => onOpenSearchIndex?.(connId, '_all')}
            >
              <Icon name="search" />
              <span>{t('Open Search Console')}</span>
            </button>
          )}
        </div>
      );
    }

    if (session.family === 'kv') {
      const namespaces = session.kvNamespaces ?? [];
      return (
        <div className="ndb-explorer-body">
          <button
            type="button"
            className="ndb-tree-item ndb-tree-action"
            onClick={() => onOpenKvTab?.(connId, session.activeDatabase)}
          >
            <Icon name="key" />
            <span>{t('Open KV Browser')}</span>
          </button>
          {namespaces.length > 0 && (
            <>
              <div className="ndb-tree-section-label">
                <span>{t('Namespaces')}</span>
                <span className="ndb-count-pill">{namespaces.length}</span>
              </div>
              {namespaces.map((ns) => (
                <button
                  key={ns.id}
                  type="button"
                  className="ndb-tree-item"
                  onClick={() => onOpenKvTab?.(connId, ns.id)}
                >
                  <Icon name="folder" />
                  <span className="ndb-truncate">{ns.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      );
    }

    if (session.family === 'mq') {
      const vhosts = session.mqVhosts ?? ['/'];
      return (
        <div className="ndb-explorer-body">
          <button
            type="button"
            className="ndb-tree-item ndb-tree-action"
            onClick={() => onOpenMqTab?.(connId, session.activeDatabase || '/')}
          >
            <Icon name="server" />
            <span>{t('Open Broker Console')}</span>
          </button>
          <div className="ndb-tree-section-label">
            <span>{t('VHosts / Topics')}</span>
            <span className="ndb-count-pill">{vhosts.length}</span>
          </div>
          {vhosts.map((vh) => (
            <button
              key={vh}
              type="button"
              className="ndb-tree-item"
              onClick={() => onOpenMqTab?.(connId, vh)}
            >
              <Icon name="folder" />
              <span className="ndb-truncate">{vh}</span>
            </button>
          ))}
        </div>
      );
    }

    // Relational Explorer: separate User Schemas & folded System Schemas (P1-4)
    const rawSchemas = session.schemas.length > 0 ? session.schemas : [{ name: session.activeSchema || 'main' }];
    const userSchemas = rawSchemas
      .filter((s) => !isSystemSchema(s))
      .sort((a, b) => {
        if (a.name === session.activeSchema || a.name === 'public' || a.name === 'main') return -1;
        if (b.name === session.activeSchema || b.name === 'public' || b.name === 'main') return 1;
        return a.name.localeCompare(b.name);
      });
    const systemSchemas = rawSchemas
      .filter((s) => isSystemSchema(s))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sysGroupKey = `sys:${connId}:${session.activeDatabase}`;
    const sysOpen = isExpanded(sysGroupKey, false);

    return (
      <div className="ndb-explorer-body">
        {session.databases.length > 1 && (
          <div className="ndb-db-switcher">
            <select
              aria-label={t('Database')}
              value={session.activeDatabase}
              onChange={(e) => onSwitchDatabase(connId, e.currentTarget.value)}
            >
              {session.databases.map((db) => (
                <option key={db.name} value={db.name}>
                  {db.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {userSchemas.map((sch) => renderSchemaBranch(session, sch))}

        {systemSchemas.length > 0 && (
          <div className="ndb-tree-branch ndb-system-schemas-group">
            <button
              type="button"
              className="ndb-tree-row ndb-tree-folder"
              onClick={() => toggleNode(sysGroupKey, false)}
            >
              <Icon name={sysOpen ? 'chevron-down' : 'chevron-right'} />
              <span>{t('System Schemas')}</span>
              <span className="ndb-count-pill">{systemSchemas.length}</span>
            </button>
            {sysOpen && (
              <div className="ndb-tree-children">
                {systemSchemas.map((sch) => renderSchemaBranch(session, sch))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="ndb-sidebar" aria-label={t('Connections')}>
      <div className="ndb-sidebar-top">
        <div className="ndb-sidebar-search">
          <Icon name="search" />
          <input
            type="text"
            placeholder={t('Search connections or objects...')}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </div>
        <div className="ndb-sidebar-actions">
          <button
            type="button"
            className="ndb-btn ndb-btn-primary ndb-btn-sm ndb-flex-1"
            onClick={onNewConnection}
          >
            <Icon name="plus" />
            {t('New')}
          </button>
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary ndb-btn-sm"
            title={t('Open Local SQLite File')}
            onClick={onOpenSqliteFile}
          >
            <Icon name="folder" />
            SQLite
          </button>
          <button
            type="button"
            className="ndb-icon-btn"
            title={t('Import / Export Connections')}
            aria-label={t('Import / Export Connections')}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onOpenContextMenu(Math.round(rect.left), Math.round(rect.bottom + 4), [
                { id: 'import-conns', label: t('Import JSON / DBeaver'), onSelect: onImportConnections },
                {
                  id: 'export-conns',
                  label: t('Export Connections JSON'),
                  disabled: connections.length === 0,
                  onSelect: onExportConnections,
                },
              ]);
            }}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>

      <div className="ndb-sidebar-scroll">
        {groupedConnections.length === 0 ? (
          <div className="ndb-sidebar-empty">
            <Icon name="database" />
            <p>{t('No connections yet')}</p>
          </div>
        ) : (
          groupedConnections.map(([groupName, groupConns]) => {
            const grpCollapsed = Boolean(groupName && collapsedGroups[groupName]);
            return (
              <div key={groupName || '__ungrouped'} className="ndb-conn-group">
                {groupName && (
                  <button
                    type="button"
                    className="ndb-group-header"
                    onClick={() =>
                      setCollapsedGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }))
                    }
                  >
                    <Icon name={grpCollapsed ? 'chevron-right' : 'chevron-down'} />
                    <Icon name="folder" />
                    <span className="ndb-truncate">{groupName}</span>
                    <span className="ndb-count-pill">{groupConns.length}</span>
                  </button>
                )}

                {!grpCollapsed &&
                  groupConns.map((conn) => {
                    const session = sessions[conn.id];
                    const isOnline = Boolean(session);
                    const isActive = activeConnectionId === conn.id;
                    const isBusy = connectingId === conn.id;
                    const connExpanded = isOnline && isExpanded(`conn:${conn.id}`, true);
                    return (
                      <div
                        key={conn.id}
                        className={`ndb-conn-node ${isActive ? 'is-active' : ''} ${isOnline ? 'is-online' : ''}`}
                      >
                        <div
                          className="ndb-conn-row"
                          onContextMenu={(e) => openConnMenu(e, conn)}
                        >
                          <button
                            type="button"
                            className="ndb-conn-row-btn"
                            disabled={isBusy}
                            onClick={() => {
                              if (!isOnline) {
                                onConnect(conn);
                              } else {
                                onSelectConnection(conn.id);
                                toggleNode(`conn:${conn.id}`, true);
                              }
                            }}
                          >
                            <EnvColorDot color={conn.color} />
                            <EngineIcon engine={conn.engine} theme={theme} size={18} />
                            <span className="ndb-conn-row-name ndb-truncate" title={conn.name}>
                              {conn.name}
                            </span>
                            {conn.readOnly && <span className="ndb-ro-mini" title={t('Read-Only')}>RO</span>}
                            {conn.sshTunnel.enabled && <span className="ndb-ssh-mini">SSH</span>}
                            {isBusy ? (
                              <Icon name="loader" />
                            ) : isOnline ? (
                              <span className="ndb-online-dot" aria-label={t('Connected')} />
                            ) : null}
                          </button>
                          {isOnline && (
                            <button
                              type="button"
                              className="ndb-icon-btn ndb-conn-disconnect-btn"
                              title={t('Disconnect')}
                              aria-label={t('Disconnect')}
                              onClick={() => onDisconnect(conn.id)}
                            >
                              <Icon name="unplug" />
                            </button>
                          )}
                        </div>

                        {connExpanded && session && renderSessionExplorer(session)}
                      </div>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
