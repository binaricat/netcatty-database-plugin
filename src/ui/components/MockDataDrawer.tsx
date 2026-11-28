/**
 * Mock / Test Data Generator Right Drawer.
 * Lazy-loaded via React.lazy. No inline SVG/Canvas.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../Icon';
import type { RelationalDriver, TableStructure } from '../../drivers/types';
import {
  MOCK_PRESET_OPTIONS,
  buildMockInsertStatements,
  generateMockRows,
  inferColumnMockRule,
  type ColumnMockRule,
  type MockPresetId,
} from '../../sql/mockGenerator';
import {
  engineToSqlDialect,
  isRelationalDriver,
  schemaCacheKey,
} from '../sessionManager';
import type { ActiveSession } from '../types';

export interface MockDataDrawerProps {
  session: ActiveSession;
  initialTable?: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenSqlInQuery?: (sql: string, title?: string) => void;
  onNotify?: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onClose: () => void;
}

export function MockDataDrawer({
  session,
  initialTable,
  t,
  onOpenSqlInQuery,
  onNotify,
  onClose,
}: MockDataDrawerProps) {
  const dialect = engineToSqlDialect(session.connection.engine);
  const readOnly = Boolean(session.connection.readOnly);
  const db = session.activeDatabase;
  const schema = session.activeSchema || session.schemas[0]?.name || 'main';

  const [tables, setTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState(initialTable || '');
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [rules, setRules] = useState<ColumnMockRule[]>([]);
  const [rowCount, setRowCount] = useState(50);
  const [batchSize, setBatchSize] = useState(100);
  const [seed, setSeed] = useState(() => Math.floor(Date.now() % 100000));
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isRelationalDriver(session.driver)) return;
    const cache = session.objectsBySchema[schemaCacheKey(db, schema)];
    if (cache && cache.tables.length > 0) {
      const names = cache.tables.map((tb) => tb.name);
      setTables(names);
      setSelectedTable((cur) => (cur && names.includes(cur) ? cur : initialTable && names.includes(initialTable) ? initialTable : names[0] ?? ''));
      return;
    }
    let cancelled = false;
    void (session.driver as RelationalDriver)
      .listTables(db, schema)
      .then((list) => {
        if (cancelled) return;
        const names = list.map((tb) => tb.name);
        setTables(names);
        setSelectedTable((cur) => (cur && names.includes(cur) ? cur : initialTable && names.includes(initialTable) ? initialTable : names[0] ?? ''));
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [db, initialTable, schema, session.driver, session.objectsBySchema]);

  useEffect(() => {
    if (!selectedTable || !isRelationalDriver(session.driver)) {
      setStructure(null);
      setRules([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (session.driver as RelationalDriver)
      .getTableStructure(db, schema, selectedTable)
      .then((st) => {
        if (cancelled) return;
        setStructure(st);
        setRules(st.columns.map(inferColumnMockRule));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [db, schema, selectedTable, session.driver]);

  const updateRule = useCallback((colName: string, patch: Partial<ColumnMockRule>) => {
    setRules((cur) => cur.map((r) => (r.columnName === colName ? { ...r, ...patch } : r)));
  }, []);

  const previewData = useMemo(
    () => generateMockRows(rules, Math.min(8, Math.max(1, rowCount)), seed),
    [rules, rowCount, seed],
  );

  const buildFullStatements = useCallback(() => {
    const dataset = generateMockRows(rules, rowCount, seed);
    return buildMockInsertStatements({
      dialect,
      tableName: selectedTable,
      schema,
      columns: dataset.columns,
      rows: dataset.rows,
      batchSize,
    });
  }, [batchSize, dialect, rowCount, rules, schema, seed, selectedTable]);

  const handleOpenSql = () => {
    if (!selectedTable || !onOpenSqlInQuery) return;
    const stmts = buildFullStatements();
    if (stmts.length === 0) {
      onNotify?.('warning', t('No active columns configured for generation.'));
      return;
    }
    onOpenSqlInQuery(stmts.join('\n\n'), `Mock ${selectedTable} (${rowCount} rows)`);
  };

  const handleExecute = async () => {
    if (!selectedTable || !isRelationalDriver(session.driver)) return;
    if (readOnly) {
      onNotify?.('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    const stmts = buildFullStatements();
    if (stmts.length === 0) {
      onNotify?.('warning', t('No active columns configured for generation.'));
      return;
    }
    setExecuting(true);
    setError(null);
    try {
      const res = await (session.driver as RelationalDriver).applyBatchMutations(stmts);
      onNotify?.('success', `${t('Inserted mock rows into')} ${selectedTable}: ${rowCount} rows (${res.applied} batches)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onNotify?.('error', msg);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <aside className="ndb-drawer ndb-drawer-picker" style={{ width: 560 }}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <h2>{t('Mock Data Generator')}</h2>
          <span className="ndb-drawer-subtitle ndb-mono">{`${session.connection.name} · ${db}`}</span>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Target Table & Count Controls */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 80px', gap: 8, alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="ndb-field-label">{t('Table')}</span>
            <select
              className="ndb-select-sm ndb-mono"
              value={selectedTable}
              onChange={(e) => setSelectedTable(e.currentTarget.value)}
            >
              {tables.map((tb) => (
                <option key={tb} value={tb}>{tb}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="ndb-field-label">{t('Rows')}</span>
            <input
              type="number"
              min={1}
              max={10000}
              className="ndb-input-sm ndb-mono"
              value={rowCount}
              onChange={(e) => setRowCount(Math.max(1, Math.min(10000, Number(e.currentTarget.value) || 1)))}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="ndb-field-label">{t('Batch')}</span>
            <input
              type="number"
              min={1}
              max={500}
              className="ndb-input-sm ndb-mono"
              value={batchSize}
              onChange={(e) => setBatchSize(Math.max(1, Math.min(500, Number(e.currentTarget.value) || 100)))}
            />
          </label>
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary ndb-btn-sm"
            title={t('Re-roll preview seed')}
            onClick={() => setSeed((s) => (s + 7919) % 100000)}
          >
            <Icon name="refresh" />
            {t('Roll')}
          </button>
        </div>

        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}

        {/* Per-Column Rules */}
        {loading ? (
          <div className="ndb-muted">{t('Loading table columns...')}</div>
        ) : (
          structure && (
            <div className="ndb-section-box" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="ndb-inline-row">
                <strong style={{ fontSize: 12 }}>{t('Column Rules')}</strong>
                <div className="ndb-spacer" />
                <span className="ndb-muted ndb-mono" style={{ fontSize: 11 }}>{`${rules.length} cols`}</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                {rules.map((rule) => (
                  <div
                    key={rule.columnName}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '125px 150px 1fr 56px',
                      gap: 6,
                      alignItems: 'center',
                      padding: '4px 0',
                      borderBottom: '1px solid var(--plugin-hairline)',
                    }}
                  >
                    <div className="ndb-truncate" title={`${rule.columnName} (${rule.dataType})`}>
                      <div className="ndb-mono ndb-truncate" style={{ fontSize: 12, fontWeight: 500 }}>{rule.columnName}</div>
                      <div className="ndb-muted ndb-mono ndb-truncate" style={{ fontSize: 10 }}>{rule.dataType}</div>
                    </div>

                    <select
                      className="ndb-select-sm"
                      value={rule.preset}
                      onChange={(e) => updateRule(rule.columnName, { preset: e.currentTarget.value as MockPresetId })}
                    >
                      {MOCK_PRESET_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </select>

                    {/* Preset-specific compact parameter */}
                    <div>
                      {(rule.preset === 'int' || rule.preset === 'float') && (
                        <div className="ndb-inline-row" style={{ gap: 4 }}>
                          <input
                            type="number"
                            className="ndb-input-sm ndb-mono"
                            style={{ width: 64 }}
                            value={rule.min ?? 0}
                            onChange={(e) => updateRule(rule.columnName, { min: Number(e.currentTarget.value) })}
                            placeholder="min"
                          />
                          <span className="ndb-muted">..</span>
                          <input
                            type="number"
                            className="ndb-input-sm ndb-mono"
                            style={{ width: 64 }}
                            value={rule.max ?? 1000}
                            onChange={(e) => updateRule(rule.columnName, { max: Number(e.currentTarget.value) })}
                            placeholder="max"
                          />
                        </div>
                      )}
                      {rule.preset === 'enum' && (
                        <input
                          type="text"
                          className="ndb-input-sm ndb-mono"
                          style={{ width: '100%' }}
                          value={rule.enumValues ?? ''}
                          onChange={(e) => updateRule(rule.columnName, { enumValues: e.currentTarget.value })}
                          placeholder="a:50,b:30,c:20"
                        />
                      )}
                      {rule.preset === 'regex' && (
                        <input
                          type="text"
                          className="ndb-input-sm ndb-mono"
                          style={{ width: '100%' }}
                          value={rule.pattern ?? '[A-Z]{2}-[0-9]{4}'}
                          onChange={(e) => updateRule(rule.columnName, { pattern: e.currentTarget.value })}
                          placeholder="[A-Z]{2}-[0-9]{4}"
                        />
                      )}
                      {rule.preset === 'constant' && (
                        <input
                          type="text"
                          className="ndb-input-sm ndb-mono"
                          style={{ width: '100%' }}
                          value={rule.constantValue ?? ''}
                          onChange={(e) => updateRule(rule.columnName, { constantValue: e.currentTarget.value })}
                          placeholder="Constant..."
                        />
                      )}
                      {rule.preset === 'sequence' && (
                        <div className="ndb-inline-row" style={{ gap: 4 }}>
                          <input
                            type="number"
                            className="ndb-input-sm ndb-mono"
                            style={{ width: 64 }}
                            value={rule.seqStart ?? 1}
                            onChange={(e) => updateRule(rule.columnName, { seqStart: Number(e.currentTarget.value) })}
                            title="Start"
                          />
                          <span className="ndb-muted">+</span>
                          <input
                            type="number"
                            className="ndb-input-sm ndb-mono"
                            style={{ width: 52 }}
                            value={rule.seqStep ?? 1}
                            onChange={(e) => updateRule(rule.columnName, { seqStep: Number(e.currentTarget.value) })}
                            title="Step"
                          />
                        </div>
                      )}
                    </div>

                    <input
                      type="number"
                      min={0}
                      max={100}
                      className="ndb-input-sm ndb-mono"
                      title={t('NULL %')}
                      disabled={rule.preset === 'skip'}
                      value={rule.nullPercent ?? 0}
                      onChange={(e) =>
                        updateRule(rule.columnName, {
                          nullPercent: Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0)),
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )
        )}

        {/* Live Sample Preview */}
        {previewData.columns.length > 0 && (
          <div className="ndb-section-box" style={{ padding: 10 }}>
            <div className="ndb-inline-row" style={{ marginBottom: 6 }}>
              <strong style={{ fontSize: 12 }}>{t('Live Preview')}</strong>
              <div className="ndb-spacer" />
              <span className="ndb-muted ndb-mono" style={{ fontSize: 11 }}>{`Showing ${previewData.rows.length} of ${rowCount}`}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="ndb-table">
                <thead>
                  <tr>
                    {previewData.columns.map((c) => (
                      <th key={c} className="ndb-mono">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="ndb-mono" style={{ whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {cell === null ? <span className="ndb-muted">NULL</span> : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <footer className="ndb-drawer-footer">
        {onOpenSqlInQuery && (
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary ndb-btn-sm"
            disabled={!selectedTable || previewData.columns.length === 0}
            onClick={handleOpenSql}
          >
            <Icon name="file-code" />
            {t('Open INSERT SQL')}
          </button>
        )}
        <div className="ndb-spacer" />
        <button
          type="button"
          className="ndb-btn ndb-btn-primary ndb-btn-sm"
          disabled={executing || readOnly || !selectedTable || previewData.columns.length === 0}
          onClick={() => void handleExecute()}
        >
          <Icon name={executing ? 'loader' : 'play'} />
          {`${t('Insert')} ${rowCount} ${t('Rows')}`}
        </button>
      </footer>
    </aside>
  );
}

export default MockDataDrawer;
