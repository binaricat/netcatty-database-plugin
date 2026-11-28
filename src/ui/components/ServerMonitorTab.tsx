/**
 * Live Server Status Monitor, Auto-Refreshing Processlist & Variables Inspector Tab.
 * Lazy-loaded via React.lazy. Uses host PluginMetricChart & PluginBiChart (no inline SVG/Canvas).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PluginBiChart,
  PluginMetricChart,
  type PluginMetricChartSeries,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type {
  ProcessEntry,
  RelationalDriver,
  ServerStatusSnapshot,
  ServerVariableEntry,
} from '../../drivers/types';
import {
  MAX_MONITOR_SAMPLES,
  buildCancelQuerySql,
  buildServerStatusSnapshot,
  buildTerminateSessionSql,
  clampRefreshInterval,
  computeServerDeltaMetrics,
  formatBytesPerSec,
  formatNumber,
  formatRate,
  formatUptime,
  isPgLegacyProcessListError,
  isPgLegacyStatusError,
  parseProcessListResult,
  parseServerVariablesResult,
  parseStatusMapForDialect,
  resolveMonitorProfile,
  statusNumber,
  type ServerDeltaMetrics,
  type StatusSample,
} from '../../sql/serverMonitor';
import { isRelationalDriver } from '../sessionManager';
import type { ActiveSession } from '../types';

export interface ServerMonitorTabProps {
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenSqlInQuery?: (sql: string, title?: string) => void;
  onNotify?: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

interface ChartSamplePoint {
  at: number;
  qps: number;
  activeConn: number;
  totalConn: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
}

export function ServerMonitorTab({
  session,
  t,
  onOpenSqlInQuery,
  onNotify,
}: ServerMonitorTabProps) {
  const profile = useMemo(
    () => resolveMonitorProfile(session.connection.engine),
    [session.connection.engine],
  );
  const readOnly = Boolean(session.connection.readOnly);

  const [subTab, setSubTab] = useState<'overview' | 'processes' | 'variables'>('overview');
  const [refreshSec, setRefreshSec] = useState<number>(5);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [snapshot, setSnapshot] = useState<ServerStatusSnapshot | null>(null);
  const [delta, setDelta] = useState<ServerDeltaMetrics | null>(null);
  const [rawStatus, setRawStatus] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<ChartSamplePoint[]>([]);

  const [processes, setProcesses] = useState<ProcessEntry[]>([]);
  const [processFilter, setProcessFilter] = useState('');
  const [hideIdle, setHideIdle] = useState(false);
  const [confirmKill, setConfirmKill] = useState<{
    id: string;
    mode: 'cancel' | 'terminate';
    sql: string;
  } | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);

  const [variables, setVariables] = useState<ServerVariableEntry[]>([]);
  const [variablesLoaded, setVariablesLoaded] = useState(false);
  const [varFilter, setVarFilter] = useState('');

  const inFlightRef = useRef(false);
  const prevSampleRef = useRef<StatusSample | null>(null);
  const ownSessionRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset history when switching connections
  useEffect(() => {
    prevSampleRef.current = null;
    ownSessionRef.current = null;
    setHistory([]);
    setSnapshot(null);
    setDelta(null);
    setRawStatus({});
    setProcesses([]);
    setVariables([]);
    setVariablesLoaded(false);
    setError(null);
  }, [session.connectionId]);

  const fetchVariables = useCallback(async () => {
    if (!profile || !isRelationalDriver(session.driver)) return;
    const drv = session.driver as RelationalDriver;
    try {
      const res = await drv.query(profile.variablesSql, { maxRows: 2000 });
      if (!mountedRef.current) return;
      const parsed = parseServerVariablesResult(res.results[0]);
      setVariables(parsed);
      setVariablesLoaded(true);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [profile, session.driver]);

  const pollOnce = useCallback(async () => {
    if (!profile || !isRelationalDriver(session.driver)) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);

    const drv = session.driver as RelationalDriver;
    try {
      if (ownSessionRef.current === null) {
        try {
          const ownRes = await drv.query(profile.ownSessionSql, { maxRows: 1 });
          const val = ownRes.results[0]?.rows?.[0]?.[0];
          if (val !== null && val !== undefined) ownSessionRef.current = String(val);
        } catch {
          ownSessionRef.current = '';
        }
      }

      // 1. Server Status
      let statusRes;
      try {
        statusRes = await drv.query(profile.statusSql, { maxRows: 1000 });
      } catch (err) {
        if (profile.fallbackStatusSql && profile.dialect === 'postgres' && isPgLegacyStatusError(err)) {
          statusRes = await drv.query(profile.fallbackStatusSql, { maxRows: 1000 });
        } else {
          throw err;
        }
      }

      const now = Date.now();
      const statusMap = parseStatusMapForDialect(profile.dialect, statusRes.results[0]);
      const sample: StatusSample = { at: now, status: statusMap };
      const nextDelta = computeServerDeltaMetrics(profile.dialect, prevSampleRef.current, sample);
      prevSampleRef.current = sample;

      const snap = buildServerStatusSnapshot({
        engine: session.connection.engine as ServerStatusSnapshot['engine'],
        dialect: profile.dialect,
        status: statusMap,
        variables,
        delta: nextDelta,
        timestamp: now,
      });

      // 2. Processlist
      let procRes;
      try {
        procRes = await drv.query(profile.processListSql, { maxRows: 1000 });
      } catch (err) {
        if (
          profile.fallbackProcessListSql &&
          profile.dialect === 'postgres' &&
          isPgLegacyProcessListError(err)
        ) {
          procRes = await drv.query(profile.fallbackProcessListSql, { maxRows: 1000 });
        } else {
          procRes = null;
        }
      }

      if (!mountedRef.current) return;

      setRawStatus(statusMap);
      setDelta(nextDelta);
      setSnapshot(snap);
      setError(null);
      if (procRes?.results[0]) {
        setProcesses(parseProcessListResult(profile.dialect, procRes.results[0], ownSessionRef.current));
      }
      setHistory((prev) => {
        const next: ChartSamplePoint = {
          at: now,
          qps: Number(nextDelta.qpsOrTps.toFixed(2)),
          activeConn: snap.activeConnections,
          totalConn: snap.totalConnections ?? snap.activeConnections,
          bytesInPerSec: Math.round(nextDelta.bytesInPerSec),
          bytesOutPerSec: Math.round(nextDelta.bytesOutPerSec),
        };
        return [...prev, next].slice(-MAX_MONITOR_SAMPLES);
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [profile, session.connection.engine, session.driver, variables]);

  // Initial fetch & polling interval
  useEffect(() => {
    if (!profile) return;
    void pollOnce();
  }, [profile, session.connectionId]);

  useEffect(() => {
    if (!profile || paused || refreshSec <= 0) return;
    const ms = clampRefreshInterval(refreshSec) * 1000;
    const timer = window.setInterval(() => {
      void pollOnce();
    }, ms);
    return () => window.clearInterval(timer);
  }, [profile, paused, refreshSec, pollOnce]);

  useEffect(() => {
    if (subTab === 'variables' && !variablesLoaded && profile) {
      void fetchVariables();
    }
  }, [subTab, variablesLoaded, profile, fetchVariables]);

  const handleRequestKill = useCallback(
    (entry: ProcessEntry, mode: 'cancel' | 'terminate') => {
      if (!profile) return;
      try {
        const sql =
          mode === 'cancel'
            ? buildCancelQuerySql(profile.dialect, entry.id)
            : buildTerminateSessionSql(profile.dialect, entry.id);
        setConfirmKill({ id: entry.id, mode, sql });
      } catch (err) {
        onNotify?.('error', err instanceof Error ? err.message : String(err));
      }
    },
    [onNotify, profile],
  );

  const handleExecuteKill = useCallback(async () => {
    if (!confirmKill || !isRelationalDriver(session.driver)) return;
    if (readOnly) {
      onNotify?.('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    setKillingId(confirmKill.id);
    try {
      await (session.driver as RelationalDriver).query(confirmKill.sql, { maxRows: 10 });
      onNotify?.('success', `${t('Executed')}: ${confirmKill.sql}`);
      setConfirmKill(null);
      void pollOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onNotify?.('error', msg);
    } finally {
      if (mountedRef.current) setKillingId(null);
    }
  }, [confirmKill, onNotify, pollOnce, readOnly, session.driver, t]);

  const filteredProcesses = useMemo(() => {
    const q = processFilter.trim().toLowerCase();
    return processes.filter((p) => {
      if (hideIdle) {
        const st = (p.state || p.command || '').toLowerCase();
        if (st === 'sleep' || st === 'idle' || st === 'sleeping') return false;
      }
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        p.user.toLowerCase().includes(q) ||
        (p.database ?? '').toLowerCase().includes(q) ||
        (p.host ?? '').toLowerCase().includes(q) ||
        (p.state ?? '').toLowerCase().includes(q) ||
        (p.sql ?? '').toLowerCase().includes(q)
      );
    });
  }, [processes, processFilter, hideIdle]);

  const filteredVariables = useMemo(() => {
    const q = varFilter.trim().toLowerCase();
    if (!q) return variables;
    return variables.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.value.toLowerCase().includes(q) ||
        (v.description ?? '').toLowerCase().includes(q),
    );
  }, [variables, varFilter]);

  const qpsSeries: PluginMetricChartSeries[] = useMemo(
    () => [
      {
        id: 'qps',
        label: profile?.qpsLabel ?? 'QPS',
        color: 'primary',
        unit: 'count',
        points: history.map((pt) => ({ at: pt.at, value: pt.qps })),
      },
    ],
    [history, profile?.qpsLabel],
  );

  const connSeries: PluginMetricChartSeries[] = useMemo(
    () => [
      {
        id: 'active',
        label: t('Active'),
        color: 'emerald',
        unit: 'count',
        points: history.map((pt) => ({ at: pt.at, value: pt.activeConn })),
      },
      {
        id: 'total',
        label: t('Total'),
        color: 'sky',
        unit: 'count',
        points: history.map((pt) => ({ at: pt.at, value: pt.totalConn })),
      },
    ],
    [history, t],
  );

  const trafficSeries: PluginMetricChartSeries[] = useMemo(
    () => [
      {
        id: 'in',
        label: profile?.dialect === 'postgres' ? 'WAL/s' : t('Traffic In'),
        color: 'violet',
        unit: 'bytes/s',
        points: history.map((pt) => ({ at: pt.at, value: pt.bytesInPerSec })),
      },
      ...(profile?.dialect === 'mysql' || profile?.dialect === 'clickhouse'
        ? [
            {
              id: 'out',
              label: t('Traffic Out'),
              color: 'amber' as const,
              unit: 'bytes/s' as const,
              points: history.map((pt) => ({ at: pt.at, value: pt.bytesOutPerSec })),
            },
          ]
        : []),
    ],
    [history, profile?.dialect, t],
  );

  const commandBreakdown = useMemo(() => {
    if (!profile) return null;
    if (profile.dialect === 'mysql') {
      const cats = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
      const vals = [
        statusNumber(rawStatus, 'Com_select'),
        statusNumber(rawStatus, 'Com_insert'),
        statusNumber(rawStatus, 'Com_update'),
        statusNumber(rawStatus, 'Com_delete'),
      ];
      if (vals.every((v) => v === 0)) return null;
      return { title: t('Cumulative DML Breakdown'), categories: cats, values: vals };
    }
    if (profile.dialect === 'postgres') {
      const cats = ['Returned', 'Fetched', 'Inserted', 'Updated', 'Deleted'];
      const vals = [
        statusNumber(rawStatus, 'tup_returned'),
        statusNumber(rawStatus, 'tup_fetched'),
        statusNumber(rawStatus, 'tup_inserted'),
        statusNumber(rawStatus, 'tup_updated'),
        statusNumber(rawStatus, 'tup_deleted'),
      ];
      if (vals.every((v) => v === 0)) return null;
      return { title: t('Tuple Activity Breakdown'), categories: cats, values: vals };
    }
    return null;
  }, [profile, rawStatus, t]);

  if (!profile) {
    return (
      <div className="ndb-tab-pane" style={{ padding: 24 }}>
        <div className="ndb-section-box" style={{ maxWidth: 540 }}>
          <div className="ndb-inline-row" style={{ gap: 8, marginBottom: 8 }}>
            <Icon name="server" />
            <strong>{t('Server Monitor')}</strong>
          </div>
          <p className="ndb-muted">
            {t('Server status monitoring is supported for MySQL, MariaDB, TiDB, OceanBase, PostgreSQL, openGauss, Kingbase, SQL Server, and ClickHouse connections.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ndb-tab-pane">
      {/* Top Toolbar */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <div className="ndb-segmented">
          {(
            [
              ['overview', t('Overview')],
              ['processes', `${t('Processlist')} (${processes.length})`],
              ['variables', `${t('Variables')}${variables.length ? ` (${variables.length})` : ''}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={subTab === id ? 'is-active' : ''}
              onClick={() => setSubTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="ndb-tag ndb-mono">{session.connection.engine}</span>
        {snapshot && (
          <span className="ndb-muted ndb-mono" style={{ fontSize: 12 }}>
            {`${t('Uptime')}: ${formatUptime(snapshot.uptimeSeconds)}`}
          </span>
        )}

        <div className="ndb-spacer" />

        <div className="ndb-toolbar-group" style={{ gap: 6 }}>
          <select
            className="ndb-select-sm"
            aria-label={t('Refresh interval')}
            value={refreshSec}
            onChange={(e) => setRefreshSec(Number(e.currentTarget.value))}
          >
            <option value={0}>{t('Manual')}</option>
            <option value={2}>2s</option>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={30}>30s</option>
          </select>
          <button
            type="button"
            className={`ndb-btn ndb-btn-xs ${paused ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
            onClick={() => setPaused((p) => !p)}
          >
            <Icon name={paused ? 'play' : 'square'} />
            {paused ? t('Resume') : t('Pause')}
          </button>
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary ndb-btn-xs"
            disabled={loading}
            onClick={() => {
              void pollOnce();
              if (subTab === 'variables') void fetchVariables();
            }}
          >
            <Icon name={loading ? 'loader' : 'refresh'} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </div>
      )}

      {/* SUB-TAB 1: OVERVIEW */}
      {subTab === 'overview' && (
        <div className="ndb-structure-scroll" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Borderless KPI Strip */}
          <div className="ndb-bi-kpi-strip" style={{ borderRadius: 'var(--plugin-radius)', background: 'var(--plugin-surface-subtle)', border: '1px solid var(--plugin-hairline)' }}>
            <div className="ndb-bi-kpi-card">
              <span className="ndb-bi-kpi-label">{profile.qpsLabel}</span>
              <span className="ndb-bi-kpi-value ndb-mono">{delta ? formatRate(delta.qpsOrTps) : '--'}</span>
              <span className="ndb-bi-kpi-sub">{t('per second')}</span>
            </div>
            <div className="ndb-bi-kpi-card">
              <span className="ndb-bi-kpi-label">{t('Active / Total Conn')}</span>
              <span className="ndb-bi-kpi-value ndb-mono">
                {snapshot ? `${snapshot.activeConnections} / ${snapshot.totalConnections ?? snapshot.activeConnections}` : '--'}
              </span>
              <span className="ndb-bi-kpi-sub">
                {snapshot?.idleConnections !== undefined ? `${snapshot.idleConnections} ${t('idle')}` : t('sessions')}
              </span>
            </div>
            <div className="ndb-bi-kpi-card">
              <span className="ndb-bi-kpi-label">{profile.cacheLabel}</span>
              <span className="ndb-bi-kpi-value ndb-mono">
                {snapshot?.cacheHitRatio !== undefined ? `${snapshot.cacheHitRatio.toFixed(2)}%` : '--'}
              </span>
              <span className="ndb-bi-kpi-sub">{t('buffer ratio')}</span>
            </div>
            <div className="ndb-bi-kpi-card">
              <span className="ndb-bi-kpi-label">{profile.dialect === 'postgres' ? 'WAL Rate' : t('Traffic In / Out')}</span>
              <span className="ndb-bi-kpi-value ndb-mono" style={{ fontSize: 15 }}>
                {delta
                  ? profile.dialect === 'postgres'
                    ? formatBytesPerSec(delta.walBytesPerSec ?? 0)
                    : `${formatBytesPerSec(delta.bytesInPerSec)} / ${formatBytesPerSec(delta.bytesOutPerSec)}`
                  : '--'}
              </span>
              <span className="ndb-bi-kpi-sub">
                {snapshot?.slowQueries !== undefined
                  ? `${t('Slow Queries')}: ${formatNumber(snapshot.slowQueries)}`
                  : snapshot?.deadlocks !== undefined
                    ? `${t('Deadlocks')}: ${formatNumber(snapshot.deadlocks)}`
                    : t('throughput')}
              </span>
            </div>
          </div>

          {/* Live Metric Charts Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <section className="ndb-section-box" style={{ padding: 12 }}>
              <div className="ndb-inline-row" style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 12 }}>{`${profile.qpsLabel} (${t('Live')})`}</strong>
                <div className="ndb-spacer" />
                <span className="ndb-mono ndb-muted" style={{ fontSize: 11 }}>
                  {delta ? `${formatRate(delta.qpsOrTps)} /s` : ''}
                </span>
              </div>
              <PluginMetricChart
                variant="area"
                series={qpsSeries}
                height={170}
                showGrid
                showAxes
                interactive
                emptyText={t('Collecting samples...')}
              />
            </section>

            <section className="ndb-section-box" style={{ padding: 12 }}>
              <div className="ndb-inline-row" style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 12 }}>{t('Connections')}</strong>
                <div className="ndb-spacer" />
                <span className="ndb-mono ndb-muted" style={{ fontSize: 11 }}>
                  {snapshot ? `${snapshot.activeConnections} active` : ''}
                </span>
              </div>
              <PluginMetricChart
                variant="line"
                series={connSeries}
                height={170}
                showGrid
                showAxes
                showLegend
                interactive
                emptyText={t('Collecting samples...')}
              />
            </section>

            {(profile.dialect === 'mysql' || profile.dialect === 'postgres' || profile.dialect === 'clickhouse') && (
              <section className="ndb-section-box" style={{ padding: 12 }}>
                <div className="ndb-inline-row" style={{ marginBottom: 8 }}>
                  <strong style={{ fontSize: 12 }}>
                    {profile.dialect === 'postgres' ? t('WAL Throughput') : t('Network Traffic')}
                  </strong>
                </div>
                <PluginMetricChart
                  variant="line"
                  series={trafficSeries}
                  height={170}
                  showGrid
                  showAxes
                  showLegend
                  interactive
                  emptyText={t('Collecting samples...')}
                />
              </section>
            )}

            {commandBreakdown && (
              <section className="ndb-section-box" style={{ padding: 12 }}>
                <div className="ndb-inline-row" style={{ marginBottom: 8 }}>
                  <strong style={{ fontSize: 12 }}>{commandBreakdown.title}</strong>
                </div>
                <PluginBiChart
                  type="bar"
                  categories={commandBreakdown.categories}
                  series={[{ id: 'ops', name: t('Count'), data: commandBreakdown.values, color: 'primary' }]}
                  valueFormat="compact"
                  height={170}
                  showGrid
                />
              </section>
            )}
          </div>

          {/* Detailed Key-Value Metrics Table */}
          {snapshot && snapshot.metrics.length > 0 && (
            <section className="ndb-section-box" style={{ padding: 12 }}>
              <div className="ndb-inline-row" style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 12 }}>{t('Server Counters')}</strong>
                <div className="ndb-spacer" />
                <span className="ndb-muted ndb-mono" style={{ fontSize: 11 }}>
                  {`${snapshot.metrics.length} metrics`}
                </span>
              </div>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('Group')}</th>
                    <th>{t('Metric')}</th>
                    <th>{t('Key')}</th>
                    <th>{t('Value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.metrics.map((m) => (
                    <tr key={m.key}>
                      <td><span className="ndb-tag">{m.group || 'General'}</span></td>
                      <td>{m.label}</td>
                      <td className="ndb-mono ndb-muted">{m.key}</td>
                      <td className="ndb-mono"><strong>{m.value}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}

      {/* SUB-TAB 2: PROCESSLIST */}
      {subTab === 'processes' && (
        <div className="ndb-structure-scroll" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="ndb-inline-row ndb-toolbar-wrap" style={{ gap: 8 }}>
            <input
              type="text"
              className="ndb-input-sm"
              style={{ minWidth: 220 }}
              placeholder={t('Filter by user, db, state, or SQL...')}
              value={processFilter}
              onChange={(e) => setProcessFilter(e.currentTarget.value)}
            />
            <label className="ndb-checkbox-row">
              <input
                type="checkbox"
                checked={hideIdle}
                onChange={(e) => setHideIdle(e.currentTarget.checked)}
              />
              <span>{t('Hide idle / sleep')}</span>
            </label>
            <div className="ndb-spacer" />
            {readOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
            <span className="ndb-muted ndb-mono" style={{ fontSize: 12 }}>
              {`${filteredProcesses.length} / ${processes.length}`}
            </span>
          </div>

          {confirmKill && (
            <div className="ndb-section-box" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: 10 }}>
              <span className="ndb-tag ndb-tag-danger">
                {confirmKill.mode === 'cancel' ? t('Cancel Query') : t('Terminate Session')}
              </span>
              <code className="ndb-mono" style={{ fontSize: 12 }}>{confirmKill.sql}</code>
              <div className="ndb-spacer" />
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                onClick={() => setConfirmKill(null)}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-danger ndb-btn-xs"
                disabled={readOnly || killingId === confirmKill.id}
                onClick={() => void handleExecuteKill()}
              >
                <Icon name={killingId === confirmKill.id ? 'loader' : 'check'} />
                {t('Confirm')}
              </button>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('User')}</th>
                  <th>{t('Host')}</th>
                  <th>{t('Database')}</th>
                  <th>{t('State')}</th>
                  <th>{t('Time')}</th>
                  <th>SQL</th>
                  <th>{t('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredProcesses.map((proc) => (
                  <tr key={proc.id} style={proc.isCurrentSession ? { opacity: 0.7 } : undefined}>
                    <td className="ndb-mono">
                      {proc.id}
                      {proc.isCurrentSession && (
                        <span className="ndb-tag" style={{ marginLeft: 4 }}>self</span>
                      )}
                    </td>
                    <td className="ndb-mono">{proc.user}</td>
                    <td className="ndb-mono ndb-muted">{proc.host || '-'}</td>
                    <td className="ndb-mono">{proc.database || '-'}</td>
                    <td>
                      <span
                        className={`ndb-tag ${
                          (proc.state || '').toLowerCase().includes('active') ||
                          (proc.command || '').toLowerCase() === 'query'
                            ? 'ndb-tag-ok'
                            : ''
                        }`}
                      >
                        {proc.state || proc.command || '-'}
                      </span>
                      {proc.waitEvent && (
                        <span className="ndb-muted ndb-mono" style={{ marginLeft: 4, fontSize: 11 }}>
                          {proc.waitEvent}
                        </span>
                      )}
                    </td>
                    <td className="ndb-mono">{`${proc.durationSec ?? 0}s`}</td>
                    <td
                      className="ndb-mono"
                      style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={proc.sql || ''}
                    >
                      {proc.sql || <span className="ndb-muted">-</span>}
                    </td>
                    <td>
                      <div className="ndb-inline-row" style={{ gap: 4 }}>
                        {proc.sql && onOpenSqlInQuery && (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                            title={t('Open in Query')}
                            onClick={() => onOpenSqlInQuery(proc.sql!, `Process ${proc.id}`)}
                          >
                            SQL
                          </button>
                        )}
                        {profile.supportsCancelQuery && !proc.isCurrentSession && (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                            disabled={readOnly}
                            onClick={() => handleRequestKill(proc, 'cancel')}
                          >
                            {t('Cancel')}
                          </button>
                        )}
                        {profile.supportsTerminateSession && !proc.isCurrentSession && (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-danger ndb-btn-xs"
                            disabled={readOnly}
                            onClick={() => handleRequestKill(proc, 'terminate')}
                          >
                            {t('Kill')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredProcesses.length === 0 && (
                  <tr>
                    <td colSpan={8} className="ndb-muted" style={{ textAlign: 'center', padding: 18 }}>
                      {t('No matching server sessions.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 3: VARIABLES / SETTINGS */}
      {subTab === 'variables' && (
        <div className="ndb-structure-scroll" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="ndb-inline-row" style={{ gap: 8 }}>
            <input
              type="text"
              className="ndb-input-sm"
              style={{ minWidth: 260 }}
              placeholder={t('Search server variables / settings...')}
              value={varFilter}
              onChange={(e) => setVarFilter(e.currentTarget.value)}
            />
            <div className="ndb-spacer" />
            <span className="ndb-muted ndb-mono" style={{ fontSize: 12 }}>
              {`${filteredVariables.length} / ${variables.length}`}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>{t('Variable')}</th>
                  <th>{t('Value')}</th>
                  <th>{t('Description')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredVariables.slice(0, 500).map((entry) => (
                  <tr key={entry.name}>
                    <td className="ndb-mono"><strong>{entry.name}</strong></td>
                    <td className="ndb-mono" style={{ maxWidth: 280, wordBreak: 'break-all' }}>{entry.value}</td>
                    <td className="ndb-muted">{entry.description || ''}</td>
                  </tr>
                ))}
                {filteredVariables.length === 0 && (
                  <tr>
                    <td colSpan={3} className="ndb-muted" style={{ textAlign: 'center', padding: 18 }}>
                      {variablesLoaded ? t('No matching variables.') : t('Loading server variables...')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default ServerMonitorTab;
