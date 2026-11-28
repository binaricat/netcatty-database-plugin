/**
 * SQL Query Tab powered by vertical `PluginSplitPane`, host-rendered Monaco (`PluginCodeEditor`),
 * virtualized `PluginDataGrid` multi-result tabs (sortable, filterable, double-click/context-menu inspect),
 * live syntax + server diagnostics, richer EXPLAIN tree with cost-share bars & Raw Plan toggle,
 * Tx controls, AI Error Fix, and CSV/JSON/Markdown/SQL/XLSX export via `PluginPopover`.
 */

import React, { useId, useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  PluginDataGrid,
  PluginPopover,
  PluginSplitPane,
  type PluginCodeEditorCompletionSchema,
  type PluginCodeEditorDiagnostic,
  type PluginDataGridColumn,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { CellValue, ExplainNode, QueryResultSet } from '../../drivers/types';
import {
  buildBiChartProps,
  recommendChartConfig,
  type BiChartConfig,
  type BiDatumClickDetail,
  type BiExportPngDetail,
  type BiExportSvgDetail,
} from '../../bi/index';
import { checkSqlSyntaxDiagnostics } from '../../sql/index';
import { engineToMonacoLanguage, formatCellForClipboard } from '../sessionManager';
import type { ActiveSession, ContextMenuItem, SqlQueryTabState } from '../types';
import { BiChartControlsBar, BiChartView } from './BiChartView';

export type ExportFormat =
  | 'csv'
  | 'tsv'
  | 'json'
  | 'markdown'
  | 'sql'
  | 'xlsx'
  | 'copy-csv'
  | 'copy-tsv'
  | 'copy-json'
  | 'copy-sql-in';

export interface SqlQueryTabProps {
  tab: SqlQueryTabState;
  session: ActiveSession;
  completionSchema?: PluginCodeEditorCompletionSchema;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<SqlQueryTabState>) => void;
  onExecute: (sql: string) => void;
  onExecuteMultiDb?: (sql: string, databases: string[]) => void;
  onCancel: () => void;
  onFormat: (sql: string) => void;
  onExplain: (sql: string, analyze: boolean) => void;
  onToggleTxMode: () => void;
  onBeginTx: () => void;
  onCommitTx: () => void;
  onRollbackTx: () => void;
  onOpenSqlFile: () => void;
  onSaveSqlFile: () => void;
  onOpenHistory: (initialTab: 'history' | 'snippets') => void;
  onOpenAi?: () => void;
  onFixWithAi?: (errorText: string, failedSql: string) => void;
  onExportResult: (result: QueryResultSet, format: ExportFormat) => void;
  onPinChartToBi?: (payload: {
    title: string;
    sql: string;
    result: QueryResultSet;
    chartConfig: BiChartConfig;
  }) => void;
  onExportChartSvg?: (detail: BiExportSvgDetail) => void;
  onExportChartPng?: (detail: BiExportPngDetail) => void;
  onInspectCell: (rowIndex: number, colName: string, value: unknown, rowObj: Record<string, unknown>) => void;
  onCopyText?: (text: string, label: string) => void;
  onOpenContextMenu?: (x: number, y: number, items: ContextMenuItem[]) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

function compareCellValues(a: CellValue, b: CellValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function ExplainTreeNode({
  node,
  rootCost,
  depth = 0,
}: {
  node: ExplainNode;
  rootCost: number;
  depth?: number;
}) {
  const hasWarn = Boolean(node.warnings && node.warnings.length > 0);
  const costPct =
    rootCost > 0 && node.totalCost !== undefined
      ? Math.max(0, Math.min(100, Math.round((node.totalCost / rootCost) * 100)))
      : null;

  return (
    <div className="ndb-explain-node" style={{ paddingLeft: `${depth * 18}px` }}>
      <div className={`ndb-explain-card ${hasWarn ? 'is-warn' : ''}`}>
        <div className="ndb-explain-head">
          <strong className="ndb-explain-type">{node.nodeType}</strong>
          {node.relation && <span className="ndb-tag ndb-mono">{node.relation}</span>}
          {node.indexName && <span className="ndb-tag ndb-tag-ok ndb-mono">IDX: {node.indexName}</span>}
          <div className="ndb-spacer" />
          {costPct !== null && (
            <span className="ndb-explain-cost-wrap ndb-mono" title={`${costPct}% of total cost`}>
              <span className="ndb-explain-cost-bar">
                <span
                  className={`ndb-explain-cost-fill ${costPct >= 60 ? 'is-high' : costPct >= 25 ? 'is-med' : ''}`}
                  style={{ width: `${costPct}%` }}
                />
              </span>
              <span>{`${costPct}%`}</span>
            </span>
          )}
          {node.totalCost !== undefined && (
            <span className="ndb-explain-metric ndb-mono">cost {node.totalCost.toFixed(1)}</span>
          )}
          {node.planRows !== undefined && (
            <span className="ndb-explain-metric ndb-mono">est {node.planRows}</span>
          )}
          {node.actualRows !== undefined && (
            <span className="ndb-explain-metric ndb-mono">actual {node.actualRows}</span>
          )}
          {node.actualTimeMs !== undefined && (
            <span className="ndb-explain-metric ndb-mono">{node.actualTimeMs.toFixed(2)} ms</span>
          )}
        </div>
        {(node.filter || node.detail) && (
          <p className="ndb-explain-detail ndb-mono">{node.filter || node.detail}</p>
        )}
        {hasWarn && (
          <div className="ndb-explain-warns">
            {node.warnings!.map((w, i) => (
              <span key={i} className="ndb-tag ndb-tag-warn">
                {w}
              </span>
            ))}
          </div>
        )}
      </div>
      {node.children.map((child) => (
        <ExplainTreeNode key={child.id} node={child} rootCost={rootCost} depth={depth + 1} />
      ))}
    </div>
  );
}

export function SqlQueryTab({
  tab,
  session,
  completionSchema,
  t,
  onUpdateTab,
  onExecute,
  onExecuteMultiDb,
  onCancel,
  onFormat,
  onExplain,
  onToggleTxMode,
  onBeginTx,
  onCommitTx,
  onRollbackTx,
  onOpenSqlFile,
  onSaveSqlFile,
  onOpenHistory,
  onFixWithAi,
  onExportResult,
  onPinChartToBi,
  onExportChartSvg,
  onExportChartPng,
  onInspectCell,
  onCopyText,
  onOpenContextMenu,
  onShortcut,
}: SqlQueryTabProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const [multiDbOpen, setMultiDbOpen] = useState(false);
  const [selectedMultiDbs, setSelectedMultiDbs] = useState<string[]>([]);
  const [pinnedResult, setPinnedResult] = useState<{ label: string; result: QueryResultSet } | null>(null);
  const [showPinDiff, setShowPinDiff] = useState(false);
  const [chartClickFilter, setChartClickFilter] = useState<{
    category: string;
    seriesIndex: number;
    datumIndex: number;
  } | null>(null);
  const exportAnchorId = useId().replace(/[^a-zA-Z0-9_-]/g, '_');
  const multiDbAnchorId = useId().replace(/[^a-zA-Z0-9_-]/g, '_');

  const language = engineToMonacoLanguage(session.connection.engine);
  const activeResult: QueryResultSet | null =
    typeof tab.activeResultTab === 'number' ? tab.results[tab.activeResultTab] ?? null : null;

  const chartSourceIndex = useMemo(() => {
    if (typeof tab.activeResultTab === 'number' && tab.results[tab.activeResultTab]?.columns.length) {
      return tab.activeResultTab;
    }
    if (tab.chartResultIndex !== undefined && tab.results[tab.chartResultIndex]?.columns.length) {
      return tab.chartResultIndex;
    }
    return tab.results.findIndex((r) => r.columns.length > 0);
  }, [tab.activeResultTab, tab.chartResultIndex, tab.results]);

  const chartSourceResult: QueryResultSet | null =
    chartSourceIndex >= 0 ? tab.results[chartSourceIndex] ?? null : null;

  const effectiveChartConfig = useMemo<BiChartConfig | null>(() => {
    if (!chartSourceResult || chartSourceResult.columns.length === 0) return null;
    if (
      tab.chartConfig &&
      tab.chartConfig.xField &&
      chartSourceResult.columns.some((c) => c.name === tab.chartConfig!.xField)
    ) {
      return tab.chartConfig;
    }
    return recommendChartConfig(chartSourceResult);
  }, [chartSourceResult, tab.chartConfig]);

  const chartBundle = useMemo(() => {
    if (!chartSourceResult || !effectiveChartConfig) return null;
    return buildBiChartProps(chartSourceResult, effectiveChartConfig, {
      height: 250,
      activeFilter: chartClickFilter
        ? {
            category: chartClickFilter.category,
            seriesIndex: chartClickFilter.seriesIndex,
            datumIndex: chartClickFilter.datumIndex,
          }
        : null,
      emptyText: t('Query returned 0 rows'),
    });
  }, [chartClickFilter, chartSourceResult, effectiveChartConfig, t]);

  const handleSqlChartDatumClick = (detail: BiDatumClickDetail) => {
    if (!detail.category) return;
    setChartClickFilter((prev) =>
      prev && prev.category === detail.category && prev.datumIndex === detail.datumIndex
        ? null
        : { category: detail.category, seriesIndex: detail.seriesIndex, datumIndex: detail.datumIndex },
    );
  };

  const liveDiagnostics = useMemo<PluginCodeEditorDiagnostic[]>(() => {
    const syntaxDiags = checkSqlSyntaxDiagnostics(tab.sql, tab.dialect);
    return [...syntaxDiags, ...(tab.serverDiagnostics ?? []), ...(tab.diagnostics ?? [])];
  }, [tab.sql, tab.dialect, tab.serverDiagnostics, tab.diagnostics]);

  const gridColumns: PluginDataGridColumn[] = useMemo(() => {
    if (!activeResult) return [];
    return activeResult.columns.map((c) => ({
      name: c.name,
      type: c.dataType,
      primaryKey: c.isPrimaryKey,
      nullable: c.nullable,
      sortable: true,
    }));
  }, [activeResult]);

  const displayedRows = useMemo(() => {
    if (!activeResult) return [];
    const q = (tab.resultFilter || '').trim().toLowerCase();
    let rows = activeResult.rows;
    if (q) {
      rows = rows.filter((row) =>
        row.some((cell) => {
          if (cell === null || cell === undefined) return false;
          if (typeof cell === 'object') return JSON.stringify(cell).toLowerCase().includes(q);
          return String(cell).toLowerCase().includes(q);
        }),
      );
    }
    if (tab.resultSort) {
      const colIdx = activeResult.columns.findIndex((c) => c.name === tab.resultSort!.column);
      if (colIdx >= 0) {
        const dir = tab.resultSort.direction === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => compareCellValues(a[colIdx], b[colIdx]) * dir);
      }
    }
    return rows;
  }, [activeResult, tab.resultFilter, tab.resultSort]);

  const buildRowObj = (rowIndex: number): Record<string, unknown> => {
    const rowObj: Record<string, unknown> = {};
    if (!activeResult) return rowObj;
    const rawRow = displayedRows[rowIndex] ?? [];
    activeResult.columns.forEach((c, idx) => {
      rowObj[c.name] = rawRow[idx];
    });
    return rowObj;
  };

  const handleResultCellContextMenu = (detail: { rowIndex: number; colName: string; x: number; y: number }) => {
    if (!activeResult || !onOpenContextMenu) return;
    const rowObj = buildRowObj(detail.rowIndex);
    const cellVal = (rowObj[detail.colName] ?? null) as CellValue;
    const items: ContextMenuItem[] = [
      {
        id: 'inspect',
        label: t('Inspect / Edit Cell'),
        onSelect: () => onInspectCell(detail.rowIndex, detail.colName, cellVal, rowObj),
      },
      {
        id: 'copy-val',
        label: t('Copy Value'),
        onSelect: () => onCopyText?.(formatCellForClipboard(cellVal), detail.colName),
      },
      {
        id: 'copy-json',
        label: t('Copy Row as JSON'),
        onSelect: () => onCopyText?.(JSON.stringify(rowObj, null, 2), 'Row JSON'),
      },
    ];
    onOpenContextMenu(detail.x, detail.y, items);
  };

  const explainRootCost = useMemo(() => {
    if (!tab.explainResult) return 0;
    return tab.explainResult.totalCost ?? tab.explainResult.root.totalCost ?? 0;
  }, [tab.explainResult]);

  return (
    <div className="ndb-tab-pane">
      {/* SQL Query Toolbar */}
      <div className="ndb-toolbar ndb-toolbar-single">
        <div className="ndb-toolbar-group ndb-toolbar-nowrap">
          <button
            type="button"
            className="ndb-btn ndb-btn-primary ndb-btn-sm"
            disabled={tab.running || !tab.sql.trim()}
            onClick={() => onExecute(tab.sql)}
            title="Cmd/Ctrl + Enter"
          >
            <Icon name={tab.running ? 'loader' : 'play'} />
            {t('Run')}
          </button>

          {tab.selectedText.trim() && (
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-sm"
              disabled={tab.running}
              onClick={() => onExecute(tab.selectedText)}
            >
              <Icon name="play" />
              {t('Run Selection')}
            </button>
          )}

          {tab.running && (
            <button type="button" className="ndb-btn ndb-btn-danger ndb-btn-sm" onClick={onCancel}>
              <Icon name="square" />
              {t('Cancel')}
            </button>
          )}

          <span className="ndb-divider-v" />

          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-sm"
            disabled={tab.running || !tab.sql.trim()}
            onClick={() => onFormat(tab.sql)}
          >
            {t('Format')}
          </button>

          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-sm"
            disabled={tab.running || !tab.sql.trim()}
            onClick={() => onExplain(tab.selectedText.trim() || tab.sql, false)}
          >
            {t('Explain')}
          </button>

          {(session.family === 'postgres' || session.family === 'mysql') && (
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              disabled={tab.running || !tab.sql.trim()}
              onClick={() => onExplain(tab.selectedText.trim() || tab.sql, true)}
            >
              {t('Analyze')}
            </button>
          )}

          <span className="ndb-divider-v" />

          {/* Transaction controls */}
          <button
            type="button"
            className={`ndb-btn ndb-btn-sm ${tab.txMode === 'manual' ? 'ndb-btn-amber' : 'ndb-btn-ghost'}`}
            onClick={onToggleTxMode}
            title="Toggle Auto / Manual Transaction Mode"
          >
            {tab.txMode === 'manual' ? t('Manual Tx') : t('Auto Tx')}
          </button>

          {tab.txMode === 'manual' && (
            <>
              {!tab.inTransaction ? (
                <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={onBeginTx}>
                  {t('Begin')}
                </button>
              ) : (
                <>
                  <button type="button" className="ndb-btn ndb-btn-ok ndb-btn-sm" onClick={onCommitTx}>
                    {t('Commit')}
                  </button>
                  <button type="button" className="ndb-btn ndb-btn-danger ndb-btn-sm" onClick={onRollbackTx}>
                    {t('Rollback')}
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className="ndb-spacer" />

        <div className="ndb-toolbar-group ndb-toolbar-nowrap">
          <span className="ndb-context-chip ndb-mono">
            {tab.database || session.activeDatabase}
            {tab.schema && tab.schema !== tab.database ? `.${tab.schema}` : ''}
          </span>
          {onExecuteMultiDb && session.databases.length > 1 && (
            <>
              <button
                id={multiDbAnchorId}
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                title={t('Multi-DB Batch Execute')}
                onClick={() => setMultiDbOpen((v) => !v)}
              >
                {t('Multi-DB')}
                <Icon name="chevron-down" />
              </button>
              <PluginPopover
                anchor={multiDbAnchorId}
                open={multiDbOpen}
                width={230}
                maxHeight={320}
                onClose={() => setMultiDbOpen(false)}
              >
                <div className="ndb-col-picker">
                  <div className="ndb-col-picker-head">
                    <strong>{t('Target Databases')}</strong>
                  </div>
                  <div className="ndb-col-picker-list">
                    {session.databases.map((db) => {
                      const checked = selectedMultiDbs.includes(db.name);
                      return (
                        <label key={db.name} className="ndb-checkbox-row ndb-col-picker-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelectedMultiDbs((prev) =>
                                checked ? prev.filter((x) => x !== db.name) : [...prev, db.name],
                              )
                            }
                          />
                          <span className="ndb-mono ndb-truncate">{db.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-primary ndb-btn-sm"
                    disabled={selectedMultiDbs.length === 0 || !tab.sql.trim()}
                    onClick={() => {
                      setMultiDbOpen(false);
                      onExecuteMultiDb(tab.selectedText.trim() || tab.sql, selectedMultiDbs);
                    }}
                  >
                    {`${t('Run')} (${selectedMultiDbs.length})`}
                  </button>
                </div>
              </PluginPopover>
            </>
          )}
          <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={onOpenSqlFile}>
            <Icon name="folder" />
            {t('Open .sql')}
          </button>
          <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={onSaveSqlFile}>
            {t('Save .sql')}
          </button>
          <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={() => onOpenHistory('snippets')}>
            <Icon name="book-open" />
            {t('Snippets')}
          </button>
        </div>
      </div>

      {/* Vertical Split: Top = Monaco Editor, Bottom = Multi-Result & Explain Pane */}
      <div className="ndb-split-host">
        <PluginSplitPane direction="vertical" initialSize={260} minSize={120} maxSize={680}>
          <div className="ndb-editor-host">
            <PluginCodeEditor
              value={tab.sql}
              language={language}
              completionSchema={completionSchema}
              diagnostics={liveDiagnostics}
              placeholder="-- Write SQL here and press Cmd+Enter to execute"
              onChange={({ value }) =>
                onUpdateTab({ sql: value, dirty: true, serverDiagnostics: [] })
              }
              onSelection={({ selectedText }) => onUpdateTab({ selectedText })}
              onExecute={({ value, selectedText, currentStatement }) => {
                onUpdateTab({ sql: value, selectedText });
                const target = selectedText.trim() || currentStatement.trim() || value;
                if (target.trim()) onExecute(target);
              }}
              onFormat={({ value }) => onFormat(value)}
              onShortcut={onShortcut}
            />
          </div>

          <div className="ndb-results-pane">
            {/* Result Tabs Bar */}
            <div className="ndb-subtab-bar">
              {tab.results.map((res, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`ndb-subtab ${tab.activeResultTab === idx ? 'is-active' : ''}`}
                  onClick={() => onUpdateTab({ activeResultTab: idx, chartResultIndex: idx, resultSort: null })}
                >
                  <span>{`${t('Result')} ${idx + 1}`}</span>
                  <span className="ndb-count-pill ndb-mono">{res.rowCount}</span>
                </button>
              ))}
              {chartSourceResult && (
                <button
                  type="button"
                  className={`ndb-subtab ${tab.activeResultTab === 'chart' ? 'is-active' : ''}`}
                  onClick={() => {
                    setChartClickFilter(null);
                    onUpdateTab({
                      activeResultTab: 'chart',
                      chartResultIndex: chartSourceIndex,
                    });
                  }}
                >
                  <Icon name="bar-chart-2" />
                  <span>{t('Chart')}</span>
                </button>
              )}
              <button
                type="button"
                className={`ndb-subtab ${tab.activeResultTab === 'messages' ? 'is-active' : ''}`}
                onClick={() => onUpdateTab({ activeResultTab: 'messages' })}
              >
                <span>{t('Messages')}</span>
                {tab.messages.length > 0 && <span className="ndb-count-pill">{tab.messages.length}</span>}
              </button>
              {tab.explainResult && (
                <button
                  type="button"
                  className={`ndb-subtab ${tab.activeResultTab === 'explain' ? 'is-active' : ''}`}
                  onClick={() => onUpdateTab({ activeResultTab: 'explain' })}
                >
                  <span>{t('Explain Plan')}</span>
                </button>
              )}

              <div className="ndb-spacer" />

              {activeResult && activeResult.columns.length > 0 && (
                <>
                  <button
                    type="button"
                    className={`ndb-btn ndb-btn-sm ${pinnedResult ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
                    title={t('Pin Result Snapshot for Diff')}
                    onClick={() => {
                      setPinnedResult({
                        label: `Pinned (${activeResult.rowCount} rows)`,
                        result: activeResult,
                      });
                      setShowPinDiff(false);
                    }}
                  >
                    {pinnedResult ? t('Re-Pin') : t('Pin')}
                  </button>
                  {pinnedResult && (
                    <button
                      type="button"
                      className={`ndb-btn ndb-btn-sm ${showPinDiff ? 'ndb-btn-primary' : 'ndb-btn-ghost'}`}
                      onClick={() => setShowPinDiff((v) => !v)}
                    >
                      {showPinDiff ? t('Exit Diff') : t('Diff vs Pinned')}
                    </button>
                  )}
                  <div className="ndb-compact-search">
                    <Icon name="search" />
                    <input
                      type="text"
                      placeholder={t('Filter rows...')}
                      value={tab.resultFilter || ''}
                      onChange={(e) => onUpdateTab({ resultFilter: e.currentTarget.value })}
                    />
                  </div>
                  <button
                    id={exportAnchorId}
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                    onClick={() => setExportOpen((v) => !v)}
                  >
                    {t('Export')}
                    <Icon name="chevron-down" />
                  </button>
                  <PluginPopover
                    anchor={exportAnchorId}
                    open={exportOpen}
                    width={210}
                    onClose={() => setExportOpen(false)}
                  >
                    <div className="ndb-menu-list">
                      {(
                        [
                          ['csv', t('Export CSV')],
                          ['tsv', t('Export TSV')],
                          ['json', t('Export JSON')],
                          ['markdown', t('Export Markdown')],
                          ['sql', t('Export SQL INSERT')],
                          ['xlsx', t('Export XLSX')],
                          ['copy-csv', t('Copy CSV to Clipboard')],
                          ['copy-tsv', t('Copy TSV (Spreadsheet)')],
                          ['copy-json', t('Copy JSON to Clipboard')],
                        ] as Array<[ExportFormat, string]>
                      ).map(([fmt, label]) => (
                        <button
                          key={fmt}
                          type="button"
                          className="ndb-menu-item"
                          onClick={() => {
                            setExportOpen(false);
                            onExportResult(activeResult, fmt);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </PluginPopover>
                </>
              )}
            </div>

            {/* Result Body */}
            <div className="ndb-results-body">
              {showPinDiff && pinnedResult && activeResult ? (
                <div className="ndb-structure-scroll">
                  <div className="ndb-inline-card">
                    <strong>{`${t('Result Diff')}: ${pinnedResult.label} vs Current (${activeResult.rowCount} rows)`}</strong>
                    <span className="ndb-spacer" />
                    <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setShowPinDiff(false)}>
                      {t('Close')}
                    </button>
                  </div>
                  <table className="ndb-table ndb-mono">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Status</th>
                        {activeResult.columns.slice(0, 8).map((c) => (
                          <th key={c.name}>{c.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(
                        { length: Math.min(100, Math.max(pinnedResult.result.rows.length, activeResult.rows.length)) },
                        (_, idx) => {
                          const left = pinnedResult.result.rows[idx];
                          const right = activeResult.rows[idx];
                          const status = !left
                            ? 'ADDED'
                            : !right
                              ? 'REMOVED'
                              : JSON.stringify(left) === JSON.stringify(right)
                                ? 'SAME'
                                : 'CHANGED';
                          const row = right ?? left ?? [];
                          return (
                            <tr key={idx}>
                              <td>{idx + 1}</td>
                              <td>
                                <span
                                  className={`ndb-tag ${
                                    status === 'ADDED'
                                      ? 'ndb-tag-ok'
                                      : status === 'REMOVED'
                                        ? 'ndb-tag-err'
                                        : status === 'CHANGED'
                                          ? 'ndb-tag-warn'
                                          : ''
                                  }`}
                                >
                                  {status}
                                </span>
                              </td>
                              {activeResult.columns.slice(0, 8).map((c, ci) => {
                                const lv = left?.[ci];
                                const rv = right?.[ci];
                                const cellChanged = status === 'CHANGED' && JSON.stringify(lv) !== JSON.stringify(rv);
                                return (
                                  <td key={c.name}>
                                    {cellChanged
                                      ? `${String(lv ?? 'NULL')} -> ${String(rv ?? 'NULL')}`
                                      : String(row[ci] ?? 'NULL')}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        },
                      )}
                    </tbody>
                  </table>
                </div>
              ) : tab.activeResultTab === 'chart' && chartSourceResult && effectiveChartConfig && chartBundle ? (
                <div className="ndb-bi-inline-panel">
                  <div className="ndb-bi-inline-bar">
                    <BiChartControlsBar
                      config={effectiveChartConfig}
                      columns={chartSourceResult.columns}
                      compact
                      t={t}
                      onChange={(patch) => {
                        setChartClickFilter(null);
                        onUpdateTab({ chartConfig: { ...effectiveChartConfig, ...patch } });
                      }}
                    />
                    <div className="ndb-spacer" />
                    {chartClickFilter && (
                      <div className="ndb-bi-inline-filter-group">
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                          onClick={() =>
                            onUpdateTab({
                              activeResultTab: Math.max(0, chartSourceIndex),
                              resultFilter: chartClickFilter.category,
                            })
                          }
                        >
                          {`${t('Filter rows')}: ${chartClickFilter.category}`}
                        </button>
                        <button
                          type="button"
                          className="ndb-icon-btn"
                          aria-label={t('Clear')}
                          onClick={() => setChartClickFilter(null)}
                        >
                          <Icon name="x" />
                        </button>
                      </div>
                    )}
                    {onPinChartToBi && (
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-primary ndb-btn-xs"
                        onClick={() =>
                          onPinChartToBi({
                            title: tab.title,
                            sql: chartSourceResult.sql || tab.sql,
                            result: chartSourceResult,
                            chartConfig: effectiveChartConfig,
                          })
                        }
                      >
                        <Icon name="plus" />
                        {t('Pin to BI Dashboard')}
                      </button>
                    )}
                  </div>
                  <div className="ndb-bi-inline-chart">
                    <BiChartView
                      {...chartBundle.props}
                      ariaLabel={`${tab.title} Chart`}
                      onDatumClick={handleSqlChartDatumClick}
                      onExportSvg={onExportChartSvg}
                      onExportPng={onExportChartPng}
                      onShortcut={onShortcut}
                    />
                  </div>
                </div>
              ) : tab.activeResultTab === 'messages' ? (
                <div className="ndb-messages-list">
                  {tab.messages.length === 0 ? (
                    <div className="ndb-empty-center">{t('No results')}</div>
                  ) : (
                    tab.messages.map((m, i) => (
                      <div key={i} className={`ndb-msg-row ndb-msg-${m.level}`}>
                        <span className="ndb-msg-time ndb-mono">
                          {new Date(m.time).toLocaleTimeString()}
                        </span>
                        <div className="ndb-msg-content">
                          <div className="ndb-msg-head-line">
                            {m.line !== undefined && (
                              <span className="ndb-tag ndb-tag-danger ndb-mono">
                                {`L${m.line}${m.column !== undefined ? `:C${m.column}` : ''}`}
                              </span>
                            )}
                            <span className="ndb-msg-text ndb-mono">{m.text}</span>
                          </div>
                          {m.hint && <div className="ndb-msg-hint ndb-mono">{`Hint: ${m.hint}`}</div>}
                        </div>
                        {m.level === 'error' && onFixWithAi && (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                            onClick={() => onFixWithAi(m.text, m.sql || tab.sql)}
                          >
                            <Icon name="sparkles" />
                            {t('Fix with AI')}
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              ) : tab.activeResultTab === 'explain' && tab.explainResult ? (
                <div className="ndb-explain-wrap">
                  <div className="ndb-explain-summary">
                    <span className="ndb-tag">{tab.explainResult.dialect.toUpperCase()}</span>
                    {tab.explainResult.analyzed && <span className="ndb-tag ndb-tag-ok">ANALYZE</span>}
                    {tab.explainResult.totalCost !== undefined && (
                      <span className="ndb-mono">{`Total Cost: ${tab.explainResult.totalCost.toFixed(2)}`}</span>
                    )}
                    {tab.explainResult.actualTimeMs !== undefined && (
                      <span className="ndb-mono">{`Execution: ${tab.explainResult.actualTimeMs.toFixed(2)} ms`}</span>
                    )}
                    <div className="ndb-spacer" />
                    <div className="ndb-segmented">
                      <button
                        type="button"
                        className={(tab.explainViewMode || 'tree') === 'tree' ? 'is-active' : ''}
                        onClick={() => onUpdateTab({ explainViewMode: 'tree' })}
                      >
                        {t('Tree View')}
                      </button>
                      <button
                        type="button"
                        className={tab.explainViewMode === 'raw' ? 'is-active' : ''}
                        onClick={() => onUpdateTab({ explainViewMode: 'raw' })}
                      >
                        {t('Raw Plan')}
                      </button>
                    </div>
                  </div>
                  {tab.explainViewMode === 'raw' ? (
                    <div className="ndb-editor-host">
                      <PluginCodeEditor
                        value={tab.explainResult.rawText || ''}
                        language={tab.explainResult.rawJson ? 'json' : 'plaintext'}
                        readOnly
                        wordWrap="on"
                        onShortcut={onShortcut}
                      />
                    </div>
                  ) : (
                    <div className="ndb-explain-scroll">
                      <ExplainTreeNode node={tab.explainResult.root} rootCost={explainRootCost} />
                    </div>
                  )}
                </div>
              ) : activeResult ? (
                activeResult.columns.length > 0 ? (
                  <PluginDataGrid
                    columns={gridColumns}
                    rows={displayedRows}
                    sort={tab.resultSort ?? null}
                    editable={false}
                    loading={tab.running}
                    emptyMessage={tab.resultFilter ? t('No results') : t('Query returned 0 rows')}
                    onSortChange={(nextSort) => onUpdateTab({ resultSort: nextSort })}
                    onCellDoubleClick={({ rowIndex, colName, value }) => {
                      onInspectCell(rowIndex, colName, value, buildRowObj(rowIndex));
                    }}
                    onCellContextMenu={handleResultCellContextMenu}
                    onCellCopy={({ text }) => onCopyText?.(text, 'Cell')}
                    onShortcut={onShortcut}
                  />
                ) : (
                  <div className="ndb-empty-center">
                    <Icon name="check" />
                    <p>
                      {`${activeResult.commandTag ?? 'OK'} · ${activeResult.affectedRows} rows affected (${activeResult.executionMs} ms)`}
                    </p>
                  </div>
                )
              ) : (
                <div className="ndb-empty-center">
                  <Icon name="play" />
                  <p>{t('Press Cmd+Enter or click Run to execute SQL')}</p>
                </div>
              )}
            </div>

            {/* Result Status Strip */}
            <div className="ndb-result-strip ndb-mono">
              {tab.running ? (
                <span>{t('Executing query...')}</span>
              ) : activeResult ? (
                <>
                  <span>
                    {tab.resultFilter
                      ? `${displayedRows.length} / ${activeResult.rowCount} ${t('rows')}`
                      : `${activeResult.rowCount} ${t('rows')}`}
                  </span>
                  <span>{`${activeResult.columns.length} ${t('cols')}`}</span>
                  <span>{`${activeResult.executionMs} ms`}</span>
                  {activeResult.affectedRows > 0 && <span>{`${activeResult.affectedRows} ${t('affected')}`}</span>}
                  {activeResult.truncated && <span className="ndb-text-amber">truncated</span>}
                  <span className="ndb-spacer" />
                  <span className="ndb-truncate ndb-muted">{activeResult.sql}</span>
                </>
              ) : (
                <span className="ndb-muted">{t('Ready')}</span>
              )}
            </div>
          </div>
        </PluginSplitPane>
      </div>
    </div>
  );
}
