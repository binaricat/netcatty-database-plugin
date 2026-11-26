/**
 * SQL Query Tab powered by vertical `PluginSplitPane`, host-rendered Monaco (`PluginCodeEditor`),
 * virtualized `PluginDataGrid` multi-result tabs, interactive EXPLAIN tree, Tx controls,
 * and CSV/JSON/Markdown/SQL/XLSX export via `PluginPopover`.
 */

import React, { useId, useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  PluginDataGrid,
  PluginPopover,
  PluginSplitPane,
  type PluginCodeEditorCompletionSchema,
  type PluginDataGridColumn,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { ExplainNode, QueryResultSet } from '../../drivers/types';
import { engineToMonacoLanguage } from '../sessionManager';
import type { ActiveSession, SqlQueryTabState } from '../types';

export type ExportFormat = 'csv' | 'json' | 'markdown' | 'sql' | 'xlsx' | 'copy-csv' | 'copy-json';

export interface SqlQueryTabProps {
  tab: SqlQueryTabState;
  session: ActiveSession;
  completionSchema?: PluginCodeEditorCompletionSchema;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<SqlQueryTabState>) => void;
  onExecute: (sql: string) => void;
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
  onExportResult: (result: QueryResultSet, format: ExportFormat) => void;
  onInspectCell: (rowIndex: number, colName: string, value: unknown, rowObj: Record<string, unknown>) => void;
}

function ExplainTreeNode({ node, depth = 0 }: { node: ExplainNode; depth?: number }) {
  const hasWarn = Boolean(node.warnings && node.warnings.length > 0);
  return (
    <div className="dbx-explain-node" style={{ paddingLeft: `${depth * 18}px` }}>
      <div className={`dbx-explain-card ${hasWarn ? 'is-warn' : ''}`}>
        <div className="dbx-explain-head">
          <strong className="dbx-explain-type">{node.nodeType}</strong>
          {node.relation && <span className="dbx-tag dbx-mono">{node.relation}</span>}
          {node.indexName && <span className="dbx-tag dbx-tag-ok dbx-mono">IDX: {node.indexName}</span>}
          <div className="dbx-spacer" />
          {node.totalCost !== undefined && (
            <span className="dbx-explain-metric dbx-mono">cost {node.totalCost.toFixed(1)}</span>
          )}
          {node.planRows !== undefined && (
            <span className="dbx-explain-metric dbx-mono">est {node.planRows}</span>
          )}
          {node.actualRows !== undefined && (
            <span className="dbx-explain-metric dbx-mono">actual {node.actualRows}</span>
          )}
          {node.actualTimeMs !== undefined && (
            <span className="dbx-explain-metric dbx-mono">{node.actualTimeMs.toFixed(2)} ms</span>
          )}
        </div>
        {(node.filter || node.detail) && (
          <p className="dbx-explain-detail dbx-mono">{node.filter || node.detail}</p>
        )}
        {hasWarn && (
          <div className="dbx-explain-warns">
            {node.warnings!.map((w, i) => (
              <span key={i} className="dbx-tag dbx-tag-warn">
                {w}
              </span>
            ))}
          </div>
        )}
      </div>
      {node.children.map((child) => (
        <ExplainTreeNode key={child.id} node={child} depth={depth + 1} />
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
  onOpenAi,
  onExportResult,
  onInspectCell,
}: SqlQueryTabProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const exportAnchorId = useId().replace(/[^a-zA-Z0-9_-]/g, '_');

  const language = engineToMonacoLanguage(session.connection.engine);
  const activeResult: QueryResultSet | null =
    typeof tab.activeResultTab === 'number' ? tab.results[tab.activeResultTab] ?? null : null;

  const gridColumns: PluginDataGridColumn[] = useMemo(() => {
    if (!activeResult) return [];
    return activeResult.columns.map((c) => ({
      name: c.name,
      type: c.dataType,
      primaryKey: c.isPrimaryKey,
      nullable: c.nullable,
      sortable: false,
    }));
  }, [activeResult]);

  return (
    <div className="dbx-tab-pane">
      {/* SQL Query Toolbar */}
      <div className="dbx-toolbar dbx-toolbar-single">
        <div className="dbx-toolbar-group dbx-toolbar-nowrap">
          <button
            type="button"
            className="dbx-btn dbx-btn-primary dbx-btn-sm"
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
              className="dbx-btn dbx-btn-secondary dbx-btn-sm"
              disabled={tab.running}
              onClick={() => onExecute(tab.selectedText)}
            >
              <Icon name="play" />
              {t('Run Selection')}
            </button>
          )}

          {tab.running && (
            <button type="button" className="dbx-btn dbx-btn-danger dbx-btn-sm" onClick={onCancel}>
              <Icon name="square" />
              {t('Cancel')}
            </button>
          )}

          <span className="dbx-divider-v" />

          <button
            type="button"
            className="dbx-btn dbx-btn-ghost dbx-btn-sm"
            disabled={tab.running || !tab.sql.trim()}
            onClick={() => onFormat(tab.sql)}
          >
            {t('Format')}
          </button>

          <button
            type="button"
            className="dbx-btn dbx-btn-ghost dbx-btn-sm"
            disabled={tab.running || !tab.sql.trim()}
            onClick={() => onExplain(tab.selectedText.trim() || tab.sql, false)}
          >
            {t('Explain')}
          </button>

          {session.family === 'postgres' && (
            <button
              type="button"
              className="dbx-btn dbx-btn-ghost dbx-btn-sm"
              disabled={tab.running || !tab.sql.trim()}
              onClick={() => onExplain(tab.selectedText.trim() || tab.sql, true)}
            >
              {t('Analyze')}
            </button>
          )}

          <span className="dbx-divider-v" />

          {/* Transaction controls */}
          <button
            type="button"
            className={`dbx-btn dbx-btn-sm ${tab.txMode === 'manual' ? 'dbx-btn-amber' : 'dbx-btn-ghost'}`}
            onClick={onToggleTxMode}
            title="Toggle Auto / Manual Transaction Mode"
          >
            {tab.txMode === 'manual' ? t('Manual Tx') : t('Auto Tx')}
          </button>

          {tab.txMode === 'manual' && (
            <>
              {!tab.inTransaction ? (
                <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={onBeginTx}>
                  {t('Begin')}
                </button>
              ) : (
                <>
                  <button type="button" className="dbx-btn dbx-btn-ok dbx-btn-sm" onClick={onCommitTx}>
                    {t('Commit')}
                  </button>
                  <button type="button" className="dbx-btn dbx-btn-danger dbx-btn-sm" onClick={onRollbackTx}>
                    {t('Rollback')}
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className="dbx-spacer" />

        <div className="dbx-toolbar-group dbx-toolbar-nowrap">
          <span className="dbx-context-chip dbx-mono">
            {tab.database || session.activeDatabase}
            {tab.schema && tab.schema !== tab.database ? `.${tab.schema}` : ''}
          </span>
          <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={onOpenSqlFile}>
            <Icon name="folder" />
            {t('Open .sql')}
          </button>
          <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={onSaveSqlFile}>
            {t('Save .sql')}
          </button>
          <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={() => onOpenHistory('snippets')}>
            <Icon name="book-open" />
            {t('Snippets')}
          </button>
        </div>
      </div>

      {/* Vertical Split: Top = Monaco Editor, Bottom = Multi-Result & Explain Pane */}
      <div className="dbx-split-host">
        <PluginSplitPane direction="vertical" initialSize={260} minSize={120} maxSize={680}>
          <div className="dbx-editor-host">
            <PluginCodeEditor
              value={tab.sql}
              language={language}
              completionSchema={completionSchema}
              diagnostics={tab.diagnostics}
              placeholder="-- Write SQL here and press Cmd+Enter to execute"
              onChange={({ value }) => onUpdateTab({ sql: value, dirty: true })}
              onSelection={({ selectedText }) => onUpdateTab({ selectedText })}
              onExecute={({ value, selectedText, currentStatement }) => {
                onUpdateTab({ sql: value, selectedText });
                const target = selectedText.trim() || currentStatement.trim() || value;
                if (target.trim()) onExecute(target);
              }}
              onFormat={({ value }) => onFormat(value)}
            />
          </div>

          <div className="dbx-results-pane">
            {/* Result Tabs Bar */}
            <div className="dbx-subtab-bar">
              {tab.results.map((res, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`dbx-subtab ${tab.activeResultTab === idx ? 'is-active' : ''}`}
                  onClick={() => onUpdateTab({ activeResultTab: idx })}
                >
                  <span>{`Result ${idx + 1}`}</span>
                  <span className="dbx-count-pill dbx-mono">{res.rowCount}</span>
                </button>
              ))}
              <button
                type="button"
                className={`dbx-subtab ${tab.activeResultTab === 'messages' ? 'is-active' : ''}`}
                onClick={() => onUpdateTab({ activeResultTab: 'messages' })}
              >
                <span>{t('Messages')}</span>
                {tab.messages.length > 0 && <span className="dbx-count-pill">{tab.messages.length}</span>}
              </button>
              {tab.explainResult && (
                <button
                  type="button"
                  className={`dbx-subtab ${tab.activeResultTab === 'explain' ? 'is-active' : ''}`}
                  onClick={() => onUpdateTab({ activeResultTab: 'explain' })}
                >
                  <span>{t('Explain Plan')}</span>
                </button>
              )}

              <div className="dbx-spacer" />

              {activeResult && activeResult.columns.length > 0 && (
                <>
                  <button
                    id={exportAnchorId}
                    type="button"
                    className="dbx-btn dbx-btn-ghost dbx-btn-sm"
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
                    <div className="dbx-menu-list">
                      {(
                        [
                          ['csv', t('Export CSV')],
                          ['json', t('Export JSON')],
                          ['markdown', t('Export Markdown')],
                          ['sql', t('Export SQL INSERT')],
                          ['xlsx', t('Export XLSX')],
                          ['copy-csv', t('Copy CSV to Clipboard')],
                          ['copy-json', t('Copy JSON to Clipboard')],
                        ] as Array<[ExportFormat, string]>
                      ).map(([fmt, label]) => (
                        <button
                          key={fmt}
                          type="button"
                          className="dbx-menu-item"
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
            <div className="dbx-results-body">
              {tab.activeResultTab === 'messages' ? (
                <div className="dbx-messages-list">
                  {tab.messages.length === 0 ? (
                    <div className="dbx-empty-center">{t('No results')}</div>
                  ) : (
                    tab.messages.map((m, i) => (
                      <div key={i} className={`dbx-msg-row dbx-msg-${m.level}`}>
                        <span className="dbx-msg-time dbx-mono">
                          {new Date(m.time).toLocaleTimeString()}
                        </span>
                        <span className="dbx-msg-text dbx-mono">{m.text}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : tab.activeResultTab === 'explain' && tab.explainResult ? (
                <div className="dbx-explain-scroll">
                  <div className="dbx-explain-summary">
                    <span className="dbx-tag">{tab.explainResult.dialect.toUpperCase()}</span>
                    {tab.explainResult.analyzed && <span className="dbx-tag dbx-tag-ok">ANALYZE</span>}
                    {tab.explainResult.totalCost !== undefined && (
                      <span className="dbx-mono">Total Cost: {tab.explainResult.totalCost.toFixed(2)}</span>
                    )}
                    {tab.explainResult.actualTimeMs !== undefined && (
                      <span className="dbx-mono">Execution: {tab.explainResult.actualTimeMs.toFixed(2)} ms</span>
                    )}
                  </div>
                  <ExplainTreeNode node={tab.explainResult.root} />
                </div>
              ) : activeResult ? (
                activeResult.columns.length > 0 ? (
                  <PluginDataGrid
                    columns={gridColumns}
                    rows={activeResult.rows}
                    editable={false}
                    loading={tab.running}
                    emptyMessage="Query returned 0 rows"
                    onCellSelect={({ rowIndex, colName, value }) => {
                      const rawRow = activeResult.rows[rowIndex] ?? [];
                      const rowObj: Record<string, unknown> = {};
                      activeResult.columns.forEach((c, idx) => {
                        rowObj[c.name] = rawRow[idx];
                      });
                      onInspectCell(rowIndex, colName, value, rowObj);
                    }}
                  />
                ) : (
                  <div className="dbx-empty-center">
                    <Icon name="check" />
                    <p>
                      {`${activeResult.commandTag ?? 'OK'} · ${activeResult.affectedRows} rows affected (${activeResult.executionMs} ms)`}
                    </p>
                  </div>
                )
              ) : (
                <div className="dbx-empty-center">
                  <Icon name="play" />
                  <p>Press Cmd+Enter or click Run to execute SQL</p>
                </div>
              )}
            </div>

            {/* Result Status Strip */}
            <div className="dbx-result-strip dbx-mono">
              {tab.running ? (
                <span>Executing query...</span>
              ) : activeResult ? (
                <>
                  <span>{`${activeResult.rowCount} rows`}</span>
                  <span>{`${activeResult.columns.length} cols`}</span>
                  <span>{`${activeResult.executionMs} ms`}</span>
                  {activeResult.affectedRows > 0 && <span>{`${activeResult.affectedRows} affected`}</span>}
                  {activeResult.truncated && <span className="dbx-text-amber">truncated</span>}
                  <span className="dbx-spacer" />
                  <span className="dbx-truncate dbx-muted">{activeResult.sql}</span>
                </>
              ) : (
                <span className="dbx-muted">Ready</span>
              )}
            </div>
          </div>
        </PluginSplitPane>
      </div>
    </div>
  );
}
