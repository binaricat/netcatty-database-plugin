/**
 * Row-by-Row Data Compare & Sync SQL Generator Tab.
 * Lazy-loaded via React.lazy. No inline SVG/Canvas.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { CellValue, RelationalDriver } from '../../drivers/types';
import {
  compareTableData,
  generateDataSyncSql,
  type DataCompareResult,
} from '../../sql/dataCompare';
import {
  engineToMonacoLanguage,
  engineToSqlDialect,
  isRelationalDriver,
  schemaCacheKey,
} from '../sessionManager';
import type { ActiveSession } from '../types';

export interface DataCompareTabProps {
  session: ActiveSession;
  sessions: Record<string, ActiveSession>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenSqlInQuery?: (sql: string, title?: string) => void;
  onSaveExportFile?: (opts: {
    title: string;
    defaultName: string;
    extension: string;
    filterName: string;
    data: string;
    encoding?: 'utf8' | 'base64';
  }) => Promise<void>;
  onNotify?: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

function formatCellShort(val: CellValue | undefined): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'object') return JSON.stringify(val);
  const s = String(val);
  return s.length > 60 ? `${s.slice(0, 60)}...` : s;
}

export function DataCompareTab({
  session,
  sessions,
  t,
  onOpenSqlInQuery,
  onSaveExportFile,
  onNotify,
  onShortcut,
}: DataCompareTabProps) {
  const relationalSessions = useMemo(
    () => Object.values(sessions).filter((s) => isRelationalDriver(s.driver)),
    [sessions],
  );

  const [srcConnId, setSrcConnId] = useState(session.connectionId);
  const [srcSchema, setSrcSchema] = useState(session.activeSchema || session.schemas[0]?.name || 'main');
  const [srcTable, setSrcTable] = useState('');
  const [srcTables, setSrcTables] = useState<string[]>([]);

  const [tgtConnId, setTgtConnId] = useState(session.connectionId);
  const [tgtSchema, setTgtSchema] = useState(session.activeSchema || session.schemas[0]?.name || 'main');
  const [tgtTable, setTgtTable] = useState('');
  const [tgtTables, setTgtTables] = useState<string[]>([]);

  const [rowLimit, setRowLimit] = useState(1000);
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const [keyColumns, setKeyColumns] = useState<string[]>([]);
  const [ignoredColumns, setIgnoredColumns] = useState<string[]>([]);
  const [looseEquality, setLooseEquality] = useState(true);

  const [diff, setDiff] = useState<DataCompareResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [filterKind, setFilterKind] = useState<'all' | 'added' | 'modified' | 'removed'>('all');
  const [direction, setDirection] = useState<'sourceToTarget' | 'targetToSource'>('sourceToTarget');
  const [includeInserts, setIncludeInserts] = useState(true);
  const [includeUpdates, setIncludeUpdates] = useState(true);
  const [includeDeletes, setIncludeDeletes] = useState(true);

  const [comparing, setComparing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const srcSession = sessions[srcConnId] ?? session;
  const tgtSession = sessions[tgtConnId] ?? session;
  const targetReadOnly = Boolean(tgtSession.connection.readOnly);
  const targetDialect = engineToSqlDialect(tgtSession.connection.engine);
  const targetMonacoLang = engineToMonacoLanguage(tgtSession.connection.engine);

  const loadTablesFor = useCallback(
    async (sess: ActiveSession, sch: string, setter: (names: string[]) => void) => {
      if (!isRelationalDriver(sess.driver)) {
        setter([]);
        return;
      }
      const cached = sess.objectsBySchema[schemaCacheKey(sess.activeDatabase, sch)];
      if (cached && cached.tables.length > 0) {
        setter(cached.tables.map((tb) => tb.name));
        return;
      }
      try {
        const list = await (sess.driver as RelationalDriver).listTables(sess.activeDatabase, sch);
        setter(list.map((tb) => tb.name));
      } catch {
        setter([]);
      }
    },
    [],
  );

  useEffect(() => {
    void loadTablesFor(srcSession, srcSchema, (names) => {
      setSrcTables(names);
      setSrcTable((cur) => (cur && names.includes(cur) ? cur : names[0] ?? ''));
    });
  }, [srcSession, srcSchema, loadTablesFor]);

  useEffect(() => {
    void loadTablesFor(tgtSession, tgtSchema, (names) => {
      setTgtTables(names);
      setTgtTable((cur) => (cur && names.includes(cur) ? cur : names.includes(srcTable) ? srcTable : names[0] ?? ''));
    });
  }, [tgtSession, tgtSchema, srcTable, loadTablesFor]);

  // Load column metadata for key selection when source table changes
  useEffect(() => {
    if (!srcTable || !isRelationalDriver(srcSession.driver)) return;
    let cancelled = false;
    void (srcSession.driver as RelationalDriver)
      .getTableStructure(srcSession.activeDatabase, srcSchema, srcTable)
      .then((struct) => {
        if (cancelled) return;
        const cols = struct.columns.map((c) => c.name);
        const pks = struct.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
        setAvailableColumns(cols);
        setKeyColumns(pks.length > 0 ? pks : cols.slice(0, 1));
        setIgnoredColumns([]);
      })
      .catch(() => {
        if (!cancelled) setAvailableColumns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [srcSession, srcSchema, srcTable]);

  const handleRunCompare = useCallback(async () => {
    if (!srcTable || !tgtTable) return;
    if (!isRelationalDriver(srcSession.driver) || !isRelationalDriver(tgtSession.driver)) return;
    setComparing(true);
    setError(null);
    try {
      const [srcRes, tgtRes] = await Promise.all([
        (srcSession.driver as RelationalDriver).browseTable(
          srcSession.activeDatabase,
          srcSchema,
          srcTable,
          { page: 1, pageSize: rowLimit },
        ),
        (tgtSession.driver as RelationalDriver).browseTable(
          tgtSession.activeDatabase,
          tgtSchema,
          tgtTable,
          { page: 1, pageSize: rowLimit },
        ),
      ]);

      const srcColNames = srcRes.columns.map((c) => c.name);
      const tgtColSet = new Set(tgtRes.columns.map((c) => c.name));
      const sharedCols = srcColNames.filter((c) => tgtColSet.has(c));
      if (sharedCols.length === 0) {
        throw new Error(t('Source and target tables share no matching column names.'));
      }

      const srcIndices = sharedCols.map((c) => srcColNames.indexOf(c));
      const tgtColNames = tgtRes.columns.map((c) => c.name);
      const tgtIndices = sharedCols.map((c) => tgtColNames.indexOf(c));

      const projectedSrc = srcRes.rows.map((r) => srcIndices.map((idx) => r[idx] ?? null));
      const projectedTgt = tgtRes.rows.map((r) => tgtIndices.map((idx) => r[idx] ?? null));

      const result = compareTableData({
        columns: sharedCols,
        keyColumns: keyColumns.filter((k) => sharedCols.includes(k)),
        ignoredColumns: ignoredColumns.filter((c) => sharedCols.includes(c)),
        sourceRows: projectedSrc,
        targetRows: projectedTgt,
        looseTypeEquality: looseEquality,
      });

      setDiff(result);
      setSelectedKeys([
        ...result.added.map((r) => r.key),
        ...result.modified.map((r) => r.key),
        ...result.removed.map((r) => r.key),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setComparing(false);
    }
  }, [
    ignoredColumns,
    keyColumns,
    looseEquality,
    rowLimit,
    srcSchema,
    srcSession,
    srcTable,
    t,
    tgtSchema,
    tgtSession,
    tgtTable,
  ]);

  const syncPlan = useMemo(() => {
    if (!diff || !tgtTable) return null;
    const isReverse = direction === 'targetToSource';
    return generateDataSyncSql({
      dialect: isReverse ? engineToSqlDialect(srcSession.connection.engine) : targetDialect,
      tableName: isReverse ? srcTable : tgtTable,
      schema: isReverse ? srcSchema : tgtSchema,
      diff,
      selectedKeys,
      includeInserts,
      includeUpdates,
      includeDeletes,
      direction,
    });
  }, [
    diff,
    direction,
    includeDeletes,
    includeInserts,
    includeUpdates,
    selectedKeys,
    srcSchema,
    srcSession.connection.engine,
    srcTable,
    targetDialect,
    tgtSchema,
    tgtTable,
  ]);

  const handleApplySync = useCallback(async () => {
    if (!syncPlan || syncPlan.statements.length === 0) return;
    const destSess = direction === 'targetToSource' ? srcSession : tgtSession;
    if (destSess.connection.readOnly) {
      onNotify?.('warning', t('Target connection is in Read-Only mode.'));
      return;
    }
    if (!isRelationalDriver(destSess.driver)) return;
    setApplying(true);
    setError(null);
    try {
      const res = await (destSess.driver as RelationalDriver).applyBatchMutations(syncPlan.statements);
      onNotify?.('success', `${t('Data sync applied')}: ${res.applied} statements (${res.affectedRows} rows)`);
      await handleRunCompare();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onNotify?.('error', msg);
    } finally {
      setApplying(false);
    }
  }, [direction, handleRunCompare, onNotify, srcSession, syncPlan, t, tgtSession]);

  const toggleRowKey = (key: string) => {
    setSelectedKeys((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  };

  const diffEntries = useMemo(() => {
    if (!diff) return [];
    const list: Array<{
      kind: 'added' | 'modified' | 'removed';
      key: string;
      keySummary: string;
      detail: string;
    }> = [];
    if (filterKind === 'all' || filterKind === 'added') {
      for (const r of diff.added) {
        list.push({
          kind: 'added',
          key: r.key,
          keySummary: diff.keyColumns.map((k) => `${k}=${formatCellShort(r.keyValues[k])}`).join(', '),
          detail: diff.columns.slice(0, 4).map((c) => `${c}: ${formatCellShort(r.values[c])}`).join(' · '),
        });
      }
    }
    if (filterKind === 'all' || filterKind === 'modified') {
      for (const r of diff.modified) {
        list.push({
          kind: 'modified',
          key: r.key,
          keySummary: diff.keyColumns.map((k) => `${k}=${formatCellShort(r.keyValues[k])}`).join(', '),
          detail: r.changes
            .map((ch) => `${ch.column}: ${formatCellShort(ch.target)} -> ${formatCellShort(ch.source)}`)
            .join(' · '),
        });
      }
    }
    if (filterKind === 'all' || filterKind === 'removed') {
      for (const r of diff.removed) {
        list.push({
          kind: 'removed',
          key: r.key,
          keySummary: diff.keyColumns.map((k) => `${k}=${formatCellShort(r.keyValues[k])}`).join(', '),
          detail: diff.columns.slice(0, 4).map((c) => `${c}: ${formatCellShort(r.values[c])}`).join(' · '),
        });
      }
    }
    return list;
  }, [diff, filterKind]);

  return (
    <div className="ndb-tab-pane">
      {/* Top Picker Toolbar */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <span className="ndb-field-label">{t('Source')}</span>
        <select
          className="ndb-select-sm"
          value={srcSession.connectionId}
          onChange={(e) => {
            const next = sessions[e.currentTarget.value];
            if (!next) return;
            setSrcConnId(next.connectionId);
            setSrcSchema(next.activeSchema || next.schemas[0]?.name || 'main');
          }}
        >
          {relationalSessions.map((s) => (
            <option key={s.connectionId} value={s.connectionId}>{s.connection.name}</option>
          ))}
        </select>
        <select className="ndb-select-sm ndb-mono" value={srcTable} onChange={(e) => setSrcTable(e.currentTarget.value)}>
          {srcTables.map((tb) => <option key={tb} value={tb}>{tb}</option>)}
        </select>

        <span className="ndb-muted">→</span>

        <span className="ndb-field-label">{t('Target')}</span>
        <select
          className="ndb-select-sm"
          value={tgtSession.connectionId}
          onChange={(e) => {
            const next = sessions[e.currentTarget.value];
            if (!next) return;
            setTgtConnId(next.connectionId);
            setTgtSchema(next.activeSchema || next.schemas[0]?.name || 'main');
          }}
        >
          {relationalSessions.map((s) => (
            <option key={s.connectionId} value={s.connectionId}>{s.connection.name}</option>
          ))}
        </select>
        <select className="ndb-select-sm ndb-mono" value={tgtTable} onChange={(e) => setTgtTable(e.currentTarget.value)}>
          {tgtTables.map((tb) => <option key={tb} value={tb}>{tb}</option>)}
        </select>

        <select
          className="ndb-select-sm ndb-mono"
          aria-label={t('Row limit')}
          value={rowLimit}
          onChange={(e) => setRowLimit(Number(e.currentTarget.value))}
        >
          <option value={500}>500 rows</option>
          <option value={1000}>1,000 rows</option>
          <option value={5000}>5,000 rows</option>
          <option value={10000}>10,000 rows</option>
        </select>

        <div className="ndb-spacer" />

        <button
          type="button"
          className="ndb-btn ndb-btn-primary ndb-btn-sm"
          disabled={comparing || !srcTable || !tgtTable}
          onClick={() => void handleRunCompare()}
        >
          <Icon name={comparing ? 'loader' : 'play'} />
          {t('Compare Data')}
        </button>
      </div>

      {/* Key Columns Bar */}
      {availableColumns.length > 0 && (
        <div className="ndb-toolbar ndb-sub-toolbar ndb-toolbar-wrap" style={{ gap: 8 }}>
          <span className="ndb-field-label">{t('Match Key Columns')}:</span>
          <div className="ndb-table-chips" style={{ padding: 0 }}>
            {availableColumns.map((col) => {
              const checked = keyColumns.includes(col);
              return (
                <label key={col} className="ndb-table-chip">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setKeyColumns((cur) => (cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col]))
                    }
                  />
                  <span className="ndb-mono">{col}</span>
                </label>
              );
            })}
          </div>
          <div className="ndb-spacer" />
          <label className="ndb-checkbox-row">
            <input type="checkbox" checked={looseEquality} onChange={(e) => setLooseEquality(e.currentTarget.checked)} />
            <span>{t('Loose numeric/bool match')}</span>
          </label>
        </div>
      )}

      {error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </div>
      )}

      <div className="ndb-structure-scroll" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {diff && (
          <>
            {/* Summary Bar */}
            <div className="ndb-inline-row ndb-toolbar-wrap" style={{ gap: 8 }}>
              <div className="ndb-segmented">
                <button type="button" className={filterKind === 'all' ? 'is-active' : ''} onClick={() => setFilterKind('all')}>
                  {`${t('All')} (${diff.added.length + diff.modified.length + diff.removed.length})`}
                </button>
                <button type="button" className={filterKind === 'added' ? 'is-active' : ''} onClick={() => setFilterKind('added')}>
                  {`+${diff.added.length} Added`}
                </button>
                <button type="button" className={filterKind === 'modified' ? 'is-active' : ''} onClick={() => setFilterKind('modified')}>
                  {`~${diff.modified.length} Modified`}
                </button>
                <button type="button" className={filterKind === 'removed' ? 'is-active' : ''} onClick={() => setFilterKind('removed')}>
                  {`-${diff.removed.length} Removed`}
                </button>
              </div>
              <span className="ndb-muted ndb-mono" style={{ fontSize: 12 }}>
                {`= ${diff.unchangedCount} identical`}
              </span>
              <div className="ndb-spacer" />
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                onClick={() =>
                  setSelectedKeys([
                    ...diff.added.map((r) => r.key),
                    ...diff.modified.map((r) => r.key),
                    ...diff.removed.map((r) => r.key),
                  ])
                }
              >
                {t('Select All')}
              </button>
              <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setSelectedKeys([])}>
                {t('Select None')}
              </button>
            </div>

            {/* Row Diff Table */}
            <div className="ndb-section-box" style={{ maxHeight: 280, overflowY: 'auto' }}>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }} />
                    <th style={{ width: 96 }}>{t('Status')}</th>
                    <th>{t('Key')}</th>
                    <th>{t('Changes')}</th>
                  </tr>
                </thead>
                <tbody>
                  {diffEntries.slice(0, 500).map((entry) => (
                    <tr key={`${entry.kind}:${entry.key}`}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedKeys.includes(entry.key)}
                          onChange={() => toggleRowKey(entry.key)}
                        />
                      </td>
                      <td>
                        <span
                          className={`ndb-tag ndb-mono ${
                            entry.kind === 'added'
                              ? 'ndb-tag-ok'
                              : entry.kind === 'removed'
                                ? 'ndb-tag-danger'
                                : 'ndb-tag-warn'
                          }`}
                        >
                          {entry.kind.toUpperCase()}
                        </span>
                      </td>
                      <td className="ndb-mono" style={{ whiteSpace: 'nowrap' }}>{entry.keySummary}</td>
                      <td className="ndb-mono ndb-muted" style={{ fontSize: 12 }}>{entry.detail}</td>
                    </tr>
                  ))}
                  {diffEntries.length === 0 && (
                    <tr>
                      <td colSpan={4} className="ndb-muted" style={{ textAlign: 'center', padding: 18 }}>
                        {t('No row differences found.')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Sync SQL Options & Preview */}
            <div className="ndb-section-box" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="ndb-inline-row ndb-toolbar-wrap" style={{ gap: 10 }}>
                <strong style={{ fontSize: 12 }}>{t('Sync SQL')}</strong>
                <select
                  className="ndb-select-sm"
                  value={direction}
                  onChange={(e) => setDirection(e.currentTarget.value as 'sourceToTarget' | 'targetToSource')}
                >
                  <option value="sourceToTarget">{t('Source -> Target')}</option>
                  <option value="targetToSource">{t('Target -> Source')}</option>
                </select>
                <label className="ndb-checkbox-row"><input type="checkbox" checked={includeInserts} onChange={(e) => setIncludeInserts(e.currentTarget.checked)} /><span>INSERT ({syncPlan?.insertCount ?? 0})</span></label>
                <label className="ndb-checkbox-row"><input type="checkbox" checked={includeUpdates} onChange={(e) => setIncludeUpdates(e.currentTarget.checked)} /><span>UPDATE ({syncPlan?.updateCount ?? 0})</span></label>
                <label className="ndb-checkbox-row"><input type="checkbox" checked={includeDeletes} onChange={(e) => setIncludeDeletes(e.currentTarget.checked)} /><span>DELETE ({syncPlan?.deleteCount ?? 0})</span></label>
                <div className="ndb-spacer" />
                {onOpenSqlInQuery && syncPlan?.sql && (
                  <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => onOpenSqlInQuery(syncPlan.sql, `Sync ${tgtTable}`)}>
                    {t('Open in Query')}
                  </button>
                )}
                {onSaveExportFile && syncPlan?.sql && (
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                    onClick={() =>
                      void onSaveExportFile({
                        title: t('Save Sync SQL'),
                        defaultName: `sync_${srcTable}_to_${tgtTable}.sql`,
                        extension: 'sql',
                        filterName: 'SQL Script',
                        data: syncPlan.sql,
                        encoding: 'utf8',
                      })
                    }
                  >
                    {t('Save .sql')}
                  </button>
                )}
                <button
                  type="button"
                  className="ndb-btn ndb-btn-primary ndb-btn-xs"
                  disabled={applying || targetReadOnly || !syncPlan || syncPlan.statements.length === 0}
                  onClick={() => void handleApplySync()}
                >
                  <Icon name={applying ? 'loader' : 'check'} />
                  {t('Apply Sync')}
                </button>
              </div>
              <div style={{ height: 220, border: '1px solid var(--plugin-hairline)', borderRadius: 'var(--plugin-radius-sm)', overflow: 'hidden' }}>
                <PluginCodeEditor
                  value={syncPlan?.sql || '-- No sync statements selected.'}
                  language={targetMonacoLang}
                  readOnly
                  wordWrap="on"
                  height={220}
                  onShortcut={onShortcut}
                />
              </div>
            </div>
          </>
        )}

        {!diff && (
          <div className="ndb-section-box" style={{ padding: 24, textAlign: 'center' }}>
            <p className="ndb-muted">
              {t('Select Source and Target tables above, choose key columns, and click Compare Data to inspect row/cell diffs and generate Sync SQL.')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default DataCompareTab;
