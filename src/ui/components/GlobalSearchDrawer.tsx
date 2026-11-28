/**
 * Global Object Search & Cross-Table Database Data Search Drawer.
 * Lazy-loaded via React.lazy. No inline SVG/Canvas.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../Icon';
import type { RelationalDriver } from '../../drivers/types';
import {
  aggregateDataSearchMatches,
  buildGlobalObjectSearchSql,
  buildTableDataSearchSql,
  parseGlobalObjectSearchRows,
  searchCachedSchemaObjects,
  type CachedSchemaObjectsSlice,
  type DataSearchTableSummary,
  type GlobalObjectSearchHit,
  type SearchableObjectKind,
} from '../../sql/databaseSearch';
import {
  engineToSqlDialect,
  isRelationalDriver,
  schemaCacheKey,
} from '../sessionManager';
import type { ActiveSession } from '../types';

export interface GlobalSearchDrawerProps {
  session: ActiveSession;
  initialTab?: 'objects' | 'data';
  t: (key: string, vars?: Record<string, string | number>) => string;
  onJumpToTable: (opts: {
    database: string;
    schema: string;
    table: string;
    whereClause?: string;
  }) => void;
  onJumpToStructure?: (opts: {
    database: string;
    schema: string;
    table: string;
  }) => void;
  onOpenSqlInQuery?: (sql: string, title?: string) => void;
  onClose: () => void;
}

export function GlobalSearchDrawer({
  session,
  initialTab = 'objects',
  t,
  onJumpToTable,
  onJumpToStructure,
  onOpenSqlInQuery,
  onClose,
}: GlobalSearchDrawerProps) {
  const dialect = engineToSqlDialect(session.connection.engine);
  const db = session.activeDatabase;
  const activeSchema = session.activeSchema || session.schemas[0]?.name || 'main';

  const [tab, setTab] = useState<'objects' | 'data'>(initialTab);
  const [term, setTerm] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | SearchableObjectKind>('all');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Object Search state
  const [objectHits, setObjectHits] = useState<GlobalObjectSearchHit[]>([]);

  // Data Search state
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [perTableLimit, setPerTableLimit] = useState(20);
  const [dataResults, setDataResults] = useState<DataSearchTableSummary[]>([]);
  const [scannedCount, setScannedCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!isRelationalDriver(session.driver)) return;
    const cache = session.objectsBySchema[schemaCacheKey(db, activeSchema)];
    if (cache && cache.tables.length > 0) {
      const names = cache.tables.map((tb) => tb.name);
      setAvailableTables(names);
      setSelectedTables(names.slice(0, 15));
      return;
    }
    let cancelled = false;
    void (session.driver as RelationalDriver)
      .listTables(db, activeSchema)
      .then((list) => {
        if (cancelled) return;
        const names = list.map((tb) => tb.name);
        setAvailableTables(names);
        setSelectedTables(names.slice(0, 15));
      })
      .catch(() => {
        if (!cancelled) setAvailableTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSchema, db, session.driver, session.objectsBySchema]);

  const cachedSlices = useMemo<CachedSchemaObjectsSlice[]>(() => {
    const out: CachedSchemaObjectsSlice[] = [];
    for (const [key, slice] of Object.entries(session.objectsBySchema)) {
      const [, sch] = key.split('::');
      out.push({
        schema: sch || activeSchema,
        tables: slice.tables,
        views: slice.views,
        routines: slice.routines,
        structures: slice.structures,
      });
    }
    return out;
  }, [activeSchema, session.objectsBySchema]);

  const runObjectSearch = useCallback(async () => {
    const q = term.trim();
    if (!q) {
      setObjectHits([]);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      let catalogHits: GlobalObjectSearchHit[] = [];
      if (isRelationalDriver(session.driver)) {
        const sql = buildGlobalObjectSearchSql({
          dialect,
          database: db,
          term: q,
          limit: 250,
        });
        if (sql) {
          try {
            const res = await (session.driver as RelationalDriver).query(sql, { maxRows: 250 });
            if (res.results[0]) {
              catalogHits = parseGlobalObjectSearchRows(res.results[0], q);
            }
          } catch {
            // Fall back to cached metadata
          }
        }
      }
      if (catalogHits.length > 0) {
        setObjectHits(catalogHits);
      } else {
        setObjectHits(searchCachedSchemaObjects(cachedSlices, q, 250));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [cachedSlices, db, dialect, session.driver, term]);

  const runDataSearch = useCallback(async () => {
    const q = term.trim();
    if (!q || !isRelationalDriver(session.driver) || selectedTables.length === 0) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setSearching(true);
    setError(null);
    setDataResults([]);
    setScannedCount(0);

    const drv = session.driver as RelationalDriver;
    const cache = session.objectsBySchema[schemaCacheKey(db, activeSchema)];
    const out: DataSearchTableSummary[] = [];

    for (let i = 0; i < selectedTables.length; i += 1) {
      if (ctrl.signal.aborted) break;
      const tbl = selectedTables[i];
      setScannedCount(i + 1);
      try {
        const struct =
          cache?.structures[tbl] ??
          (await drv.getTableStructure(db, activeSchema, tbl));
        const built = buildTableDataSearchSql({
          dialect,
          schema: activeSchema,
          tableName: tbl,
          columns: struct.columns,
          term: q,
          limit: perTableLimit,
        });
        if (!built) continue;
        const res = await drv.query(built.sql, { maxRows: perTableLimit, signal: ctrl.signal });
        if (ctrl.signal.aborted) break;
        const rs = res.results[0];
        if (!rs || rs.rows.length === 0) continue;
        const summary = aggregateDataSearchMatches({
          dialect,
          schema: activeSchema,
          tableName: tbl,
          schemaColumns: struct.columns,
          result: rs,
          term: q,
        });
        if (summary.matches.length > 0) {
          out.push(summary);
          setDataResults([...out]);
        }
      } catch (err) {
        if (ctrl.signal.aborted) break;
        out.push({
          schema: activeSchema,
          tableName: tbl,
          matches: [],
          error: err instanceof Error ? err.message : String(err),
        });
        setDataResults([...out]);
      }
    }
    setSearching(false);
  }, [activeSchema, db, dialect, perTableLimit, selectedTables, session.driver, session.objectsBySchema, term]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'objects') void runObjectSearch();
    else void runDataSearch();
  };

  const visibleObjectHits = useMemo(
    () => (kindFilter === 'all' ? objectHits : objectHits.filter((h) => h.objectKind === kindFilter)),
    [kindFilter, objectHits],
  );

  const totalDataMatches = useMemo(
    () => dataResults.reduce((acc, item) => acc + item.matches.length, 0),
    [dataResults],
  );

  return (
    <aside className="ndb-drawer ndb-drawer-picker" style={{ width: 560 }}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <h2>{t('Global Database Search')}</h2>
          <span className="ndb-drawer-subtitle ndb-mono">{`${session.connection.name} · ${db}`}</span>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Tab Switcher */}
        <div className="ndb-segmented">
          <button type="button" className={tab === 'objects' ? 'is-active' : ''} onClick={() => setTab('objects')}>
            {t('Object & Schema Search')}
          </button>
          <button type="button" className={tab === 'data' ? 'is-active' : ''} onClick={() => setTab('data')}>
            {t('Cross-Table Data Search')}
          </button>
        </div>

        {/* Search Input Bar */}
        <form className="ndb-inline-row" style={{ gap: 6 }} onSubmit={handleSubmit}>
          <input
            type="text"
            className="ndb-input-sm ndb-flex-1"
            placeholder={
              tab === 'objects'
                ? t('Search tables, views, columns, routines, comments...')
                : t('Search text or exact numbers across table rows...')
            }
            value={term}
            onChange={(e) => setTerm(e.currentTarget.value)}
          />
          {searching ? (
            <button
              type="button"
              className="ndb-btn ndb-btn-danger ndb-btn-sm"
              onClick={() => {
                abortRef.current?.abort();
                setSearching(false);
              }}
            >
              <Icon name="square" />
              {t('Stop')}
            </button>
          ) : (
            <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={!term.trim()}>
              <Icon name="search" />
              {t('Search')}
            </button>
          )}
        </form>

        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}

        {/* TAB 1: OBJECT SEARCH */}
        {tab === 'objects' && (
          <>
            <div className="ndb-inline-row ndb-toolbar-wrap" style={{ gap: 6 }}>
              {(['all', 'table', 'view', 'column', 'routine'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`ndb-btn ndb-btn-xs ${kindFilter === k ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
                  onClick={() => setKindFilter(k)}
                >
                  {k.toUpperCase()}
                </button>
              ))}
              <div className="ndb-spacer" />
              <span className="ndb-muted ndb-mono" style={{ fontSize: 11 }}>{`${visibleObjectHits.length} hits`}</span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {visibleObjectHits.map((hit, idx) => (
                <div
                  key={`${hit.schema}.${hit.tableName}.${hit.columnName || ''}.${idx}`}
                  className="ndb-section-box"
                  style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span className="ndb-tag ndb-mono">{hit.objectKind}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ndb-mono ndb-truncate" style={{ fontSize: 12, fontWeight: 500 }}>
                      {hit.schema ? `${hit.schema}.` : ''}
                      {hit.tableName}
                      {hit.columnName ? `.${hit.columnName}` : ''}
                    </div>
                    {(hit.dataType || hit.comment) && (
                      <div className="ndb-muted ndb-truncate" style={{ fontSize: 11 }}>
                        {[hit.dataType, hit.comment].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  {(hit.objectKind === 'table' || hit.objectKind === 'view' || hit.objectKind === 'column' || hit.objectKind === 'materialized_view') && (
                    <div className="ndb-inline-row" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                        onClick={() =>
                          onJumpToTable({
                            database: db,
                            schema: hit.schema || activeSchema,
                            table: hit.tableName,
                          })
                        }
                      >
                        {t('Data')}
                      </button>
                      {onJumpToStructure && (
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() =>
                            onJumpToStructure({
                              database: db,
                              schema: hit.schema || activeSchema,
                              table: hit.tableName,
                            })
                          }
                        >
                          {t('DDL')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {!searching && visibleObjectHits.length === 0 && (
                <div className="ndb-muted" style={{ textAlign: 'center', padding: 24 }}>
                  {term.trim() ? t('No matching schema objects.') : t('Enter a keyword to search objects across schemas.')}
                </div>
              )}
            </div>
          </>
        )}

        {/* TAB 2: CROSS-TABLE DATA SEARCH */}
        {tab === 'data' && (
          <>
            <div className="ndb-section-box" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="ndb-inline-row" style={{ gap: 8 }}>
                <strong style={{ fontSize: 12 }}>{`${t('Tables to Scan')} (${selectedTables.length}/${availableTables.length})`}</strong>
                <div className="ndb-spacer" />
                <select
                  className="ndb-select-sm ndb-mono"
                  value={perTableLimit}
                  onChange={(e) => setPerTableLimit(Number(e.currentTarget.value))}
                >
                  <option value={10}>10 / table</option>
                  <option value={20}>20 / table</option>
                  <option value={50}>50 / table</option>
                </select>
                <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setSelectedTables([...availableTables])}>
                  {t('All')}
                </button>
                <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setSelectedTables([])}>
                  {t('None')}
                </button>
              </div>
              <div className="ndb-table-chips" style={{ maxHeight: 110, overflowY: 'auto', padding: 0 }}>
                {availableTables.map((tb) => (
                  <label key={tb} className="ndb-table-chip">
                    <input
                      type="checkbox"
                      checked={selectedTables.includes(tb)}
                      onChange={() =>
                        setSelectedTables((cur) =>
                          cur.includes(tb) ? cur.filter((x) => x !== tb) : [...cur, tb],
                        )
                      }
                    />
                    <span className="ndb-mono">{tb}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="ndb-inline-row">
              <span className="ndb-muted ndb-mono" style={{ fontSize: 11 }}>
                {searching
                  ? `${t('Scanning')} ${scannedCount} / ${selectedTables.length}...`
                  : `${totalDataMatches} ${t('matching rows across')} ${dataResults.filter((r) => r.matches.length > 0).length} ${t('tables')}`}
              </span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {dataResults.map((tblSummary) => (
                <div key={tblSummary.tableName} className="ndb-section-box" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="ndb-inline-row" style={{ gap: 8 }}>
                    <strong className="ndb-mono">{tblSummary.tableName}</strong>
                    <span className={`ndb-tag ndb-mono ${tblSummary.error ? 'ndb-tag-danger' : 'ndb-tag-ok'}`}>
                      {tblSummary.error ? 'ERR' : `${tblSummary.matches.length} hits`}
                    </span>
                    <div className="ndb-spacer" />
                    {onOpenSqlInQuery && tblSummary.matches.length > 0 && (
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                        onClick={() =>
                          onOpenSqlInQuery(
                            `SELECT * FROM ${tblSummary.tableName} WHERE ${tblSummary.matches[0].whereClause};`,
                            `Search ${tblSummary.tableName}`,
                          )
                        }
                      >
                        SQL
                      </button>
                    )}
                  </div>
                  {tblSummary.error && <div className="ndb-text-danger" style={{ fontSize: 12 }}>{tblSummary.error}</div>}
                  {tblSummary.matches.slice(0, 15).map((m, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 8px',
                        borderRadius: 'var(--plugin-radius-sm)',
                        background: 'var(--plugin-surface-subtle)',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="ndb-mono ndb-truncate" style={{ fontSize: 12 }}>
                          {m.matchedColumns.map((col) => `${col}=${String(m.rowValues[col] ?? 'NULL')}`).join(' · ')}
                        </div>
                        <div className="ndb-muted ndb-mono ndb-truncate" style={{ fontSize: 10 }}>
                          {m.whereClause}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                        onClick={() =>
                          onJumpToTable({
                            database: db,
                            schema: m.schema,
                            table: m.tableName,
                            whereClause: m.whereClause,
                          })
                        }
                      >
                        <Icon name="arrow-right" />
                        {t('Open')}
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

export default GlobalSearchDrawer;
