/**
 * Dolt Git-for-Data Version Control Tab.
 * Supports branches, commit log, `dolt_status`, `DOLT_DIFF_SUMMARY`, `DOLT_DIFF`,
 * and checkout / branch / stage+commit / merge / reset SQL actions.
 * Lazy-loaded via React.lazy. No inline SVG/Canvas.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../Icon';
import type { CellValue, QueryResultSet, RelationalDriver } from '../../drivers/types';
import { isRelationalDriver } from '../sessionManager';
import type { ActiveSession } from '../types';

export interface DoltVersionTabProps {
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenSqlInQuery?: (sql: string, title?: string) => void;
  onNotify?: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

interface DoltBranchInfo {
  name: string;
  hash: string;
  active: boolean;
}

interface DoltCommitInfo {
  hash: string;
  committer: string;
  date: string;
  message: string;
  parents: string[];
}

interface DoltStatusItem {
  tableName: string;
  staged: boolean;
  status: string;
}

interface DoltDiffSummaryItem {
  tableName: string;
  diffType: string;
  dataChange: boolean;
  schemaChange: boolean;
}

function doltLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function colVal(result: QueryResultSet, row: readonly CellValue[], ...names: string[]): string {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const idx = result.columns.findIndex((c) => lower.has(c.name.toLowerCase()));
  if (idx < 0 || row[idx] === null || row[idx] === undefined) return '';
  return String(row[idx]);
}

function colBool(result: QueryResultSet, row: readonly CellValue[], ...names: string[]): boolean {
  const v = colVal(result, row, ...names).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function DoltVersionTab({
  session,
  t,
  onOpenSqlInQuery,
  onNotify,
}: DoltVersionTabProps) {
  const readOnly = Boolean(session.connection.readOnly);
  const [activeBranch, setActiveBranch] = useState('main');
  const [branches, setBranches] = useState<DoltBranchInfo[]>([]);
  const [commits, setCommits] = useState<DoltCommitInfo[]>([]);
  const [statusItems, setStatusItems] = useState<DoltStatusItem[]>([]);

  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [diffSummary, setDiffSummary] = useState<DoltDiffSummaryItem[]>([]);
  const [selectedDiffTable, setSelectedDiffTable] = useState<string | null>(null);
  const [diffRowsResult, setDiffRowsResult] = useState<QueryResultSet | null>(null);

  const [newBranchName, setNewBranchName] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');

  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!isRelationalDriver(session.driver)) return;
    setLoading(true);
    setError(null);
    const drv = session.driver as RelationalDriver;
    try {
      let currentBranch = 'main';
      try {
        const bRes = await drv.query('SELECT active_branch() AS branch', { maxRows: 1 });
        const val = bRes.results[0]?.rows?.[0]?.[0];
        if (val) currentBranch = String(val);
      } catch {
        // Keep fallback
      }
      setActiveBranch(currentBranch);

      const [brRes, stRes, logRes] = await Promise.all([
        drv.query('SELECT name, hash FROM dolt_branches ORDER BY name', { maxRows: 200 }),
        drv.query('SELECT table_name, staged, status FROM dolt_status ORDER BY table_name, staged DESC', { maxRows: 500 }),
        drv.query(
          `SELECT * FROM DOLT_LOG(${doltLiteral(currentBranch)}, '--parents') LIMIT 100`,
          { maxRows: 100 },
        ),
      ]);

      const brSet = brRes.results[0];
      if (brSet) {
        const parsedBranches = brSet.rows.map((r) => {
          const name = colVal(brSet, r, 'name', 'branch');
          return {
            name,
            hash: colVal(brSet, r, 'hash', 'commit_hash'),
            active: name === currentBranch,
          };
        });
        setBranches(parsedBranches);
        const other = parsedBranches.find((b) => b.name !== currentBranch);
        setMergeTarget((cur) => (cur && parsedBranches.some((b) => b.name === cur) ? cur : other?.name ?? ''));
      }

      const stSet = stRes.results[0];
      if (stSet) {
        setStatusItems(
          stSet.rows.map((r) => ({
            tableName: colVal(stSet, r, 'table_name', 'table'),
            staged: colBool(stSet, r, 'staged'),
            status: colVal(stSet, r, 'status'),
          })),
        );
      }

      const lgSet = logRes.results[0];
      if (lgSet) {
        setCommits(
          lgSet.rows.map((r) => ({
            hash: colVal(lgSet, r, 'commit_hash', 'hash'),
            committer: colVal(lgSet, r, 'committer', 'author'),
            date: colVal(lgSet, r, 'date', 'commit_date'),
            message: colVal(lgSet, r, 'message'),
            parents: colVal(lgSet, r, 'parents', 'parent_hashes')
              .split(/[\s,;]+/)
              .filter(Boolean),
          })),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [session.driver]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, session.connectionId]);

  const inspectDiffRange = useCallback(
    async (fromRev: string, toRev: string) => {
      if (!isRelationalDriver(session.driver)) return;
      const drv = session.driver as RelationalDriver;
      setDiffRowsResult(null);
      setSelectedDiffTable(null);
      try {
        const res = await drv.query(
          `SELECT * FROM DOLT_DIFF_SUMMARY(${doltLiteral(fromRev)}, ${doltLiteral(toRev)})`,
          { maxRows: 200 },
        );
        const rs = res.results[0];
        if (!rs) {
          setDiffSummary([]);
          return;
        }
        const items: DoltDiffSummaryItem[] = rs.rows.map((r) => ({
          tableName: colVal(rs, r, 'to_table_name', 'from_table_name', 'table_name'),
          diffType: colVal(rs, r, 'diff_type') || 'modified',
          dataChange: colBool(rs, r, 'data_change'),
          schemaChange: colBool(rs, r, 'schema_change'),
        }));
        setDiffSummary(items);
        if (items[0]) {
          setSelectedDiffTable(items[0].tableName);
          const tblRes = await drv.query(
            `SELECT * FROM DOLT_DIFF(${doltLiteral(fromRev)}, ${doltLiteral(toRev)}, ${doltLiteral(items[0].tableName)}) LIMIT 100`,
            { maxRows: 100 },
          );
          setDiffRowsResult(tblRes.results[0] ?? null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [session.driver],
  );

  const activeDiffRange = useMemo(() => {
    if (!selectedCommitHash) return { from: 'HEAD', to: 'WORKING' };
    const commit = commits.find((c) => c.hash === selectedCommitHash);
    const parent = commit?.parents[0] || `${selectedCommitHash}~1`;
    return { from: parent, to: selectedCommitHash };
  }, [commits, selectedCommitHash]);

  const loadTableDiff = useCallback(
    async (tableName: string) => {
      if (!isRelationalDriver(session.driver)) return;
      setSelectedDiffTable(tableName);
      try {
        const res = await (session.driver as RelationalDriver).query(
          `SELECT * FROM DOLT_DIFF(${doltLiteral(activeDiffRange.from)}, ${doltLiteral(activeDiffRange.to)}, ${doltLiteral(tableName)}) LIMIT 100`,
          { maxRows: 100 },
        );
        setDiffRowsResult(res.results[0] ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeDiffRange.from, activeDiffRange.to, session.driver],
  );

  const runDoltAction = useCallback(
    async (sql: string, successMessage: string) => {
      if (!isRelationalDriver(session.driver)) return;
      if (readOnly) {
        onNotify?.('warning', t('Connection is in Read-Only mode.'));
        return;
      }
      setMutating(true);
      setError(null);
      try {
        await (session.driver as RelationalDriver).query(sql, { maxRows: 20 });
        onNotify?.('success', successMessage);
        await loadAll();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        onNotify?.('error', msg);
      } finally {
        setMutating(false);
      }
    },
    [loadAll, onNotify, readOnly, session.driver, t],
  );

  const handleCheckout = (branch: string) =>
    void runDoltAction(`CALL DOLT_CHECKOUT(${doltLiteral(branch)})`, `${t('Switched to branch')} ${branch}`);

  const handleCreateBranch = () => {
    const name = newBranchName.trim();
    if (!name) return;
    setNewBranchName('');
    void runDoltAction(`CALL DOLT_BRANCH(${doltLiteral(name)})`, `${t('Created branch')} ${name}`);
  };

  const handleMergeBranch = () => {
    const target = mergeTarget.trim();
    if (!target) return;
    void runDoltAction(`CALL DOLT_MERGE(${doltLiteral(target)})`, `${t('Merged branch')} ${target}`);
  };

  const handleCommitAll = async () => {
    const msg = commitMessage.trim();
    if (!msg || !isRelationalDriver(session.driver)) return;
    if (readOnly) {
      onNotify?.('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    setMutating(true);
    setError(null);
    const drv = session.driver as RelationalDriver;
    try {
      await drv.query("CALL DOLT_ADD('.')", { maxRows: 5 });
      await drv.query(`CALL DOLT_COMMIT('-m', ${doltLiteral(msg)})`, { maxRows: 5 });
      setCommitMessage('');
      onNotify?.('success', `${t('Committed')}: ${msg}`);
      await loadAll();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m);
      onNotify?.('error', m);
    } finally {
      setMutating(false);
    }
  };

  return (
    <div className="ndb-tab-pane">
      {/* Top Toolbar */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <strong style={{ fontSize: 13 }}>{t('Dolt Version Control')}</strong>
        <span className="ndb-tag ndb-tag-ok ndb-mono">{`branch: ${activeBranch}`}</span>
        <span className="ndb-tag ndb-mono">{`${statusItems.length} uncommitted`}</span>
        {readOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
        <div className="ndb-spacer" />
        <button
          type="button"
          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
          onClick={() => {
            setSelectedCommitHash(null);
            void inspectDiffRange('HEAD', 'WORKING');
          }}
        >
          {t('Diff Working Tree')}
        </button>
        <button
          type="button"
          className="ndb-btn ndb-btn-secondary ndb-btn-xs"
          disabled={loading}
          onClick={() => void loadAll()}
        >
          <Icon name={loading ? 'loader' : 'refresh'} />
          {t('Refresh')}
        </button>
      </div>

      {error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left Rail: Branches & Working Tree Status */}
        <aside
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid var(--plugin-hairline)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            overflowY: 'auto',
          }}
        >
          {/* Branches */}
          <section className="ndb-section-box" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong style={{ fontSize: 12 }}>{`${t('Branches')} (${branches.length})`}</strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {branches.map((b) => (
                <div key={b.name} className="ndb-inline-row" style={{ gap: 6 }}>
                  <span className="ndb-mono ndb-truncate" style={{ fontWeight: b.active ? 600 : 400, flex: 1 }}>
                    {b.name}
                  </span>
                  {b.active ? (
                    <span className="ndb-tag ndb-tag-ok">HEAD</span>
                  ) : (
                    <button
                      type="button"
                      className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                      disabled={mutating || readOnly}
                      onClick={() => handleCheckout(b.name)}
                    >
                      {t('Checkout')}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="ndb-inline-row" style={{ gap: 4, marginTop: 4 }}>
              <input
                type="text"
                className="ndb-input-sm ndb-flex-1"
                placeholder={t('New branch name...')}
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.currentTarget.value)}
              />
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                disabled={mutating || readOnly || !newBranchName.trim()}
                onClick={handleCreateBranch}
              >
                <Icon name="plus" />
              </button>
            </div>

            {branches.length > 1 && (
              <div className="ndb-inline-row" style={{ gap: 4 }}>
                <select
                  className="ndb-select-sm ndb-flex-1 ndb-mono"
                  value={mergeTarget}
                  onChange={(e) => setMergeTarget(e.currentTarget.value)}
                >
                  {branches
                    .filter((b) => !b.active)
                    .map((b) => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                </select>
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                  disabled={mutating || readOnly || !mergeTarget}
                  onClick={handleMergeBranch}
                >
                  {t('Merge')}
                </button>
              </div>
            )}
          </section>

          {/* Working Tree Status & Commit */}
          <section className="ndb-section-box" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="ndb-inline-row">
              <strong style={{ fontSize: 12 }}>{t('Working Tree (dolt_status)')}</strong>
              <div className="ndb-spacer" />
              {statusItems.length > 0 && (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-danger ndb-btn-xs"
                  disabled={mutating || readOnly}
                  onClick={() => void runDoltAction("CALL DOLT_RESET('--hard', 'HEAD')", t('Working tree discarded.'))}
                >
                  {t('Reset')}
                </button>
              )}
            </div>

            {statusItems.length === 0 ? (
              <span className="ndb-muted" style={{ fontSize: 12 }}>{t('Clean working tree.')}</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {statusItems.map((item, i) => (
                  <div key={`${item.tableName}-${i}`} className="ndb-inline-row" style={{ gap: 6 }}>
                    <span className={`ndb-tag ndb-mono ${item.staged ? 'ndb-tag-ok' : 'ndb-tag-warn'}`}>
                      {item.status}
                    </span>
                    <span className="ndb-mono ndb-truncate" style={{ fontSize: 12 }}>{item.tableName}</span>
                  </div>
                ))}
              </div>
            )}

            <input
              type="text"
              className="ndb-input-sm"
              placeholder={t('Commit message...')}
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.currentTarget.value)}
            />
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={mutating || readOnly || !commitMessage.trim() || statusItems.length === 0}
              onClick={() => void handleCommitAll()}
            >
              <Icon name={mutating ? 'loader' : 'check'} />
              {t('Stage All & Commit')}
            </button>
          </section>
        </aside>

        {/* Main Content: Commit Log & Diff Viewer */}
        <section className="ndb-structure-scroll" style={{ flex: 1, minWidth: 0, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="ndb-section-box" style={{ padding: 10 }}>
            <div className="ndb-inline-row" style={{ marginBottom: 8 }}>
              <strong style={{ fontSize: 12 }}>{`${t('Commit History')} (${commits.length})`}</strong>
              <div className="ndb-spacer" />
              {onOpenSqlInQuery && (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                  onClick={() =>
                    onOpenSqlInQuery(
                      `SELECT * FROM DOLT_LOG(${doltLiteral(activeBranch)}, '--parents') LIMIT 50;`,
                      'Dolt Log',
                    )
                  }
                >
                  SQL
                </button>
              )}
            </div>
            <div style={{ maxHeight: 230, overflowY: 'auto' }}>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>Hash</th>
                    <th>{t('Message')}</th>
                    <th>{t('Author')}</th>
                    <th>{t('Date')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {commits.map((c) => (
                    <tr
                      key={c.hash}
                      style={selectedCommitHash === c.hash ? { background: 'var(--plugin-surface-hover)' } : undefined}
                    >
                      <td className="ndb-mono">{c.hash.slice(0, 8)}</td>
                      <td className="ndb-truncate" style={{ maxWidth: 280 }}>{c.message}</td>
                      <td className="ndb-muted">{c.committer}</td>
                      <td className="ndb-mono ndb-muted" style={{ whiteSpace: 'nowrap' }}>{c.date}</td>
                      <td>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() => {
                            setSelectedCommitHash(c.hash);
                            const parent = c.parents[0] || `${c.hash}~1`;
                            void inspectDiffRange(parent, c.hash);
                          }}
                        >
                          {t('Diff')}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {commits.length === 0 && (
                    <tr>
                      <td colSpan={5} className="ndb-muted" style={{ textAlign: 'center', padding: 16 }}>
                        {loading ? t('Loading Dolt commit history...') : t('No commits returned (is this a Dolt server?).')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Diff Summary & Row Diff Grid */}
          {diffSummary.length > 0 && (
            <div className="ndb-section-box" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="ndb-inline-row ndb-toolbar-wrap" style={{ gap: 6 }}>
                <strong style={{ fontSize: 12 }}>
                  {`Diff: ${activeDiffRange.from.slice(0, 10)} → ${activeDiffRange.to.slice(0, 10)}`}
                </strong>
                {diffSummary.map((item) => (
                  <button
                    key={item.tableName}
                    type="button"
                    className={`ndb-btn ndb-btn-xs ndb-mono ${selectedDiffTable === item.tableName ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
                    onClick={() => void loadTableDiff(item.tableName)}
                  >
                    {`${item.tableName} (${item.diffType})`}
                  </button>
                ))}
              </div>

              {diffRowsResult && (
                <div style={{ overflowX: 'auto', maxHeight: 280 }}>
                  <table className="ndb-table">
                    <thead>
                      <tr>
                        {diffRowsResult.columns.map((col) => (
                          <th key={col.name} className="ndb-mono">{col.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {diffRowsResult.rows.map((row, rIdx) => (
                        <tr key={rIdx}>
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} className="ndb-mono" style={{ whiteSpace: 'nowrap' }}>
                              {cell === null ? <span className="ndb-muted">NULL</span> : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {diffRowsResult.rows.length === 0 && (
                        <tr>
                          <td colSpan={Math.max(1, diffRowsResult.columns.length)} className="ndb-muted" style={{ textAlign: 'center', padding: 14 }}>
                            {t('No row changes in this table.')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default DoltVersionTab;
