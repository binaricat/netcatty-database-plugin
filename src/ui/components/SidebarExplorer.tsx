/**
 * Left Connection Hub & Multi-DB / Multi-Schema Lazy Object Explorer.
 * Sits inside the left pane of the horizontal `PluginSplitPane`.
 */

import React, { useMemo, useState } from 'react';
import { Icon } from '../../Icon';
import { schemaCacheKey } from '../sessionManager';
import type {
  ActiveSession,
  ContextMenuItem,
  SavedConnection,
  TableSummary,
  ViewSummary,
} from '../types';
import { EngineIcon, EnvColorDot } from './EngineBadge';

export interface SidebarExplorerProps {
  connections: SavedConnection[];
  sessions: Record<string, ActiveSession>;
  activeConnectionId: string | null;
  connectingId: string | null;
  theme: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onNewConnection: () => void;
  onOpenSqliteFile: () => void;
  onConnect: (conn: SavedConnection) => void;
  onDisconnect: (connectionId: string) => void;
  onSelectConnection: (connectionId: string) => void;
  onSwitchDatabase: (connectionId: string, database: string) => void;
  onExpandSchema: (connectionId: string, database: string, schema: string) => void;
  onExpandTable: (connectionId: string, database: string, schema: string, table: string) => void;
  onOpenTableData: (connectionId: string, database: string, schema: string, table: string) => void;
  onOpenTableStructure: (connectionId: string, database: string, schema: string, table: string) => void;
  onOpenErDiagram: (connectionId: string, database: string, schema: string) => void;
  onOpenNewQuery: (connectionId: string, initialSql?: string) => void;
  onOpenRedisTab: (connectionId: string, db?: number) => void;
  onOpenMongoCollection: (connectionId: string, database: string, collection: string) => void;
  onOpenCreateTable: (connectionId: string, database: string, schema: string) => void;
  onDumpSchema: (connectionId: string, database: string, schema: string, table?: string) => void;
  onExportTable: (connectionId: string, database: string, schema: string, table: string) => void;
  onTruncateTable: (connectionId: string, database: string, schema: string, table: string) => void;
  onDropObject: (connectionId: string, database: string, schema: string, name: string, kind: 'table' | 'view' | 'trigger' | 'routine') => void;
  onEditConnection: (conn: SavedConnection) => void;
  onDuplicateConnection: (conn: SavedConnection) => void;
  onExportUri: (conn: SavedConnection) => void;
  onDeleteConnection: (conn: SavedConnection) => void;
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
  onConnect,
  onDisconnect,
  onSelectConnection,
  onSwitchDatabase,
  onExpandSchema,
  onExpandTable,
  onOpenTableData,
  onOpenTableStructure,
  onOpenErDiagram,
  onOpenNewQuery,
  onOpenRedisTab,
  onOpenMongoCollection,
  onOpenCreateTable,
  onDumpSchema,
  onExportTable,
  onTruncateTable,
  onDropObject,
  onEditConnection,
  onDuplicateConnection,
  onExportUri,
  onDeleteConnection,
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
          Object.values(sess.objectsBySchema).some(
            (c) =>
              c.tables.some((tbl) => tbl.name.toLowerCase().includes(q)) ||
              c.views.some((vw) => vw.name.toLowerCase().includes(q)),
          );
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
    const online = Boolean(sessions[conn.id]);
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

  const openSchemaMenu = (e: React.MouseEvent, connId: string, db: string, schema: string) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenContextMenu(e.clientX, e.clientY, [
      { id: 'er', label: t('View ER Diagram'), onSelect: () => onOpenErDiagram(connId, db, schema) },
      { id: 'create-table', label: t('Create Table'), onSelect: () => onOpenCreateTable(connId, db, schema) },
      { id: 'dump', label: t('Dump Schema SQL'), onSelect: () => onDumpSchema(connId, db, schema) },
      { id: 'copy', label: t('Copy Name'), dividerBefore: true, onSelect: () => onCopyText(schema, schema) },
      { id: 'refresh', label: t('Refresh'), onSelect: () => onRefreshSchema(connId, db, schema) },
    ]);
  };

  const openTableMenu = (
    e: React.MouseEvent,
    connId: string,
    db: string,
    schema: string,
    obj: TableSummary | ViewSummary,
    kind: 'table' | 'view',
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
        : []),
      { id: 'er', label: t('View ER Diagram'), onSelect: () => onOpenErDiagram(connId, db, schema) },
      {
        id: 'copy-name',
        label: t('Copy Name'),
        dividerBefore: true,
        onSelect: () => onCopyText(obj.name, obj.name),
      },
      {
        id: 'gen-select',
        label: t('Generate SELECT'),
        onSelect: () => onOpenNewQuery(connId, `SELECT * FROM ${schema && schema !== 'main' ? `"${schema}"."${obj.name}"` : `"${obj.name}"`} LIMIT 100;`),
      },
      {
        id: 'view-ddl',
        label: t('View DDL'),
        onSelect: () => onOpenTableStructure(connId, db, schema, obj.name),
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
              dividerBefore: true,
              onSelect: () => onTruncateTable(connId, db, schema, obj.name),
            },
          ]
        : []),
      {
        id: 'drop',
        label: t('Drop Object'),
        danger: true,
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

  const renderSessionExplorer = (session: ActiveSession) => {
    const connId = session.connectionId;

    if (session.family === 'redis') {
      const ksMap = new Map((session.redisInfo?.keyspace ?? []).map((k) => [k.db, k.keys]));
      return (
        <div className="dbx-explorer-body">
          <div className="dbx-db-switcher">
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
                    {count !== undefined ? `DB ${i} (${count} keys)` : `DB ${i}`}
                  </option>
                );
              })}
            </select>
          </div>
          <button
            type="button"
            className="dbx-tree-item dbx-tree-action"
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
        <div className="dbx-explorer-body">
          <div className="dbx-db-switcher">
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
          <div className="dbx-tree-section-label">
            <span>{t('Collections')}</span>
            <span className="dbx-count-pill">{collections.length}</span>
          </div>
          {filteredCols.map((col) => (
            <button
              key={col.name}
              type="button"
              className="dbx-tree-item"
              onClick={() => onOpenMongoCollection(connId, session.activeDatabase, col.name)}
            >
              <Icon name="table" />
              <span className="dbx-truncate">{col.name}</span>
            </button>
          ))}
          {filteredCols.length === 0 && <p className="dbx-tree-empty">{t('No results')}</p>}
        </div>
      );
    }

    // Relational Explorer (PG / MySQL / MariaDB / SQLite / ClickHouse / Domestic aliases)
    const rawSchemas = session.schemas.length > 0 ? session.schemas : [{ name: session.activeSchema || 'main' }];
    const schemas = [...rawSchemas].sort((a, b) => {
      const rank = (s: { name: string; isSystem?: boolean }) => {
        if (s.name === session.activeSchema || s.name === 'public' || s.name === 'main') return 0;
        if (!s.isSystem && !/^(pg_|information_schema|sys|mysql|performance_schema)/i.test(s.name)) return 1;
        return 2;
      };
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
    return (
      <div className="dbx-explorer-body">
        {session.databases.length > 1 && (
          <div className="dbx-db-switcher">
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

        {schemas.map((sch) => {
          const schKey = `sch:${connId}:${session.activeDatabase}:${sch.name}`;
          const open = isExpanded(schKey, sch.name === session.activeSchema);
          const cache = session.objectsBySchema[schemaCacheKey(session.activeDatabase, sch.name)];
          const tables = (cache?.tables ?? []).filter((tbl) => !q || tbl.name.toLowerCase().includes(q));
          const views = (cache?.views ?? []).filter((vw) => !q || vw.name.toLowerCase().includes(q));
          const routines = (cache?.routines ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
          const triggers = (cache?.triggers ?? []).filter((tr) => !q || tr.name.toLowerCase().includes(q));

          const tablesKey = `${schKey}:tables`;
          const viewsKey = `${schKey}:views`;
          const routinesKey = `${schKey}:routines`;
          const triggersKey = `${schKey}:triggers`;

          return (
            <div key={sch.name} className="dbx-tree-branch">
              <button
                type="button"
                className={`dbx-tree-row dbx-tree-schema ${sch.name === session.activeSchema ? 'is-active-schema' : ''}`}
                onClick={() => {
                  const willOpen = !open;
                  toggleNode(schKey, sch.name === session.activeSchema);
                  if (willOpen && !cache?.loaded && !cache?.loading) {
                    onExpandSchema(connId, session.activeDatabase, sch.name);
                  }
                }}
                onContextMenu={(e) => openSchemaMenu(e, connId, session.activeDatabase, sch.name)}
              >
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <Icon name="database" />
                <span className="dbx-truncate">{sch.name}</span>
                {cache?.loading && <Icon name="loader" />}
              </button>

              {open && (
                <div className="dbx-tree-children">
                  {/* Tables folder */}
                  <button
                    type="button"
                    className="dbx-tree-row dbx-tree-folder"
                    onClick={() => toggleNode(tablesKey, true)}
                  >
                    <Icon name={isExpanded(tablesKey, true) ? 'chevron-down' : 'chevron-right'} />
                    <span>{t('Tables')}</span>
                    <span className="dbx-count-pill">{cache?.tables.length ?? 0}</span>
                  </button>
                  {isExpanded(tablesKey, true) && (
                    <div className="dbx-tree-children">
                      {tables.map((tbl) => {
                        const tblKey = `${schKey}:tbl:${tbl.name}`;
                        const tblOpen = isExpanded(tblKey, false);
                        const struct = cache?.structures[tbl.name];
                        return (
                          <div key={tbl.name} className="dbx-tree-branch">
                            <div
                              className="dbx-tree-table-wrap"
                              onContextMenu={(e) =>
                                openTableMenu(e, connId, session.activeDatabase, sch.name, tbl, 'table')
                              }
                            >
                              <button
                                type="button"
                                className="dbx-tree-expander"
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
                                className="dbx-tree-item dbx-tree-table-btn"
                                onClick={() => onOpenTableData(connId, session.activeDatabase, sch.name, tbl.name)}
                                title={tbl.name}
                              >
                                <Icon name="table" />
                                <span className="dbx-truncate">{tbl.name}</span>
                                {tbl.rowCountEstimate !== undefined && (
                                  <span className="dbx-row-est dbx-mono">{tbl.rowCountEstimate}</span>
                                )}
                              </button>
                            </div>

                            {tblOpen && (
                              <div className="dbx-tree-children dbx-tree-cols">
                                {!struct ? (
                                  <span className="dbx-tree-empty">{t('Loading...')}</span>
                                ) : (
                                  <>
                                    {struct.columns.map((col) => {
                                      const isFk = struct.foreignKeys.some((fk) => fk.columns.includes(col.name));
                                      return (
                                        <div key={col.name} className="dbx-tree-col-row">
                                          {col.isPrimaryKey && <span className="dbx-badge-pk">PK</span>}
                                          {isFk && <span className="dbx-badge-fk">FK</span>}
                                          <span className="dbx-tree-col-name dbx-truncate" title={col.name}>
                                            {col.name}
                                          </span>
                                          <span className="dbx-tree-col-type dbx-mono">{col.dataType}</span>
                                        </div>
                                      );
                                    })}
                                    {struct.indexes.length > 0 && (
                                      <div className="dbx-tree-submeta">
                                        <span>{t('Indexes')} ({struct.indexes.length})</span>
                                      </div>
                                    )}
                                    {struct.foreignKeys.length > 0 && (
                                      <div className="dbx-tree-submeta">
                                        <span>{t('Foreign Keys')} ({struct.foreignKeys.length})</span>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {tables.length === 0 && <p className="dbx-tree-empty">{t('No results')}</p>}
                    </div>
                  )}

                  {/* Views folder */}
                  {(cache?.views.length ?? 0) > 0 && (
                    <>
                      <button
                        type="button"
                        className="dbx-tree-row dbx-tree-folder"
                        onClick={() => toggleNode(viewsKey, false)}
                      >
                        <Icon name={isExpanded(viewsKey, false) ? 'chevron-down' : 'chevron-right'} />
                        <span>{t('Views')}</span>
                        <span className="dbx-count-pill">{cache?.views.length ?? 0}</span>
                      </button>
                      {isExpanded(viewsKey, false) && (
                        <div className="dbx-tree-children">
                          {views.map((vw) => (
                            <button
                              key={vw.name}
                              type="button"
                              className="dbx-tree-item"
                              onClick={() => onOpenTableData(connId, session.activeDatabase, sch.name, vw.name)}
                              onContextMenu={(e) =>
                                openTableMenu(e, connId, session.activeDatabase, sch.name, vw, 'view')
                              }
                            >
                              <Icon name="eye" />
                              <span className="dbx-truncate">{vw.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* Functions / Routines folder */}
                  {(cache?.routines.length ?? 0) > 0 && (
                    <>
                      <button
                        type="button"
                        className="dbx-tree-row dbx-tree-folder"
                        onClick={() => toggleNode(routinesKey, false)}
                      >
                        <Icon name={isExpanded(routinesKey, false) ? 'chevron-down' : 'chevron-right'} />
                        <span>{t('Functions & Procedures')}</span>
                        <span className="dbx-count-pill">{cache?.routines.length ?? 0}</span>
                      </button>
                      {isExpanded(routinesKey, false) && (
                        <div className="dbx-tree-children">
                          {routines.map((rt) => (
                            <button
                              key={`${rt.name}:${rt.arguments ?? ''}`}
                              type="button"
                              className="dbx-tree-item"
                              onClick={() =>
                                onOpenNewQuery(
                                  connId,
                                  rt.definition || `-- ${rt.kind.toUpperCase()} ${rt.name}(${rt.arguments ?? ''})`,
                                )
                              }
                            >
                              <Icon name="file-code" />
                              <span className="dbx-truncate">{rt.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* Triggers folder */}
                  {(cache?.triggers.length ?? 0) > 0 && (
                    <>
                      <button
                        type="button"
                        className="dbx-tree-row dbx-tree-folder"
                        onClick={() => toggleNode(triggersKey, false)}
                      >
                        <Icon name={isExpanded(triggersKey, false) ? 'chevron-down' : 'chevron-right'} />
                        <span>{t('Triggers')}</span>
                        <span className="dbx-count-pill">{cache?.triggers.length ?? 0}</span>
                      </button>
                      {isExpanded(triggersKey, false) && (
                        <div className="dbx-tree-children">
                          {triggers.map((tr) => (
                            <button
                              key={`${tr.tableName}:${tr.name}`}
                              type="button"
                              className="dbx-tree-item"
                              onClick={() =>
                                onOpenNewQuery(
                                  connId,
                                  tr.definition || `-- TRIGGER ${tr.name} ON ${tr.tableName}`,
                                )
                              }
                            >
                              <Icon name="sparkles" />
                              <span className="dbx-truncate">{tr.name}</span>
                              <span className="dbx-row-est">{tr.tableName}</span>
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
        })}
      </div>
    );
  };

  return (
    <aside className="dbx-sidebar" aria-label={t('Connections')}>
      <div className="dbx-sidebar-top">
        <div className="dbx-sidebar-search">
          <Icon name="search" />
          <input
            type="text"
            placeholder={t('Search connections or objects...')}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </div>
        <div className="dbx-sidebar-actions">
          <button
            type="button"
            className="dbx-btn dbx-btn-primary dbx-btn-sm dbx-flex-1"
            onClick={onNewConnection}
          >
            <Icon name="plus" />
            {t('New')}
          </button>
          <button
            type="button"
            className="dbx-btn dbx-btn-secondary dbx-btn-sm"
            title={t('Open Local SQLite File')}
            onClick={onOpenSqliteFile}
          >
            <Icon name="folder" />
            SQLite
          </button>
        </div>
      </div>

      <div className="dbx-sidebar-scroll">
        {groupedConnections.length === 0 ? (
          <div className="dbx-sidebar-empty">
            <Icon name="database" />
            <p>{t('No connections yet')}</p>
          </div>
        ) : (
          groupedConnections.map(([groupName, groupConns]) => {
            const grpCollapsed = Boolean(groupName && collapsedGroups[groupName]);
            return (
              <div key={groupName || '__ungrouped'} className="dbx-conn-group">
                {groupName && (
                  <button
                    type="button"
                    className="dbx-group-header"
                    onClick={() =>
                      setCollapsedGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }))
                    }
                  >
                    <Icon name={grpCollapsed ? 'chevron-right' : 'chevron-down'} />
                    <Icon name="folder" />
                    <span className="dbx-truncate">{groupName}</span>
                    <span className="dbx-count-pill">{groupConns.length}</span>
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
                        className={`dbx-conn-node ${isActive ? 'is-active' : ''} ${isOnline ? 'is-online' : ''}`}
                      >
                        <div
                          className="dbx-conn-row"
                          onContextMenu={(e) => openConnMenu(e, conn)}
                        >
                          <button
                            type="button"
                            className="dbx-conn-row-btn"
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
                            <span className="dbx-conn-row-name dbx-truncate" title={conn.name}>
                              {conn.name}
                            </span>
                            {conn.sshTunnel.enabled && <span className="dbx-ssh-mini">SSH</span>}
                            {isBusy ? (
                              <Icon name="loader" />
                            ) : isOnline ? (
                              <span className="dbx-online-dot" aria-label={t('Connected')} />
                            ) : null}
                          </button>
                          {isOnline && (
                            <button
                              type="button"
                              className="dbx-icon-btn dbx-conn-disconnect-btn"
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
