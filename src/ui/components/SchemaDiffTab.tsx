/**
 * Schema Diff, SQL Dump, SQL Restore & Cross-Connection Data Transfer Tab (v0.3.0):
 * - Mode 1 (`diff`): Cross-connection Source/Target comparison, selectable structured diff tree (`diffResult.items`),
 *   filtered migration SQL in Monaco, and 1-click Apply Selected to Target (guarded by Read-Only).
 * - Mode 2 (`dump`): Per-table checkboxes, Schema+Data or Schema-Only SQL dump + Save `.sql`.
 * - Mode 3 (`restore`): Pick `.sql` file via `ui.openFile`, live progress bar, continue-on-error toggle, error report.
 * - Mode 4 (`transfer`): Cross-connection table-to-table structure + data copy with dialect translation & progress bar.
 */

import React, { useMemo } from 'react';
import { PluginCodeEditor, type PluginWorkbenchShortcut } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import { engineToMonacoLanguage, isRelationalDriver, schemaCacheKey } from '../sessionManager';
import type { ActiveSession, SchemaDiffTabState } from '../types';

export interface SchemaDiffTabProps {
  tab: SchemaDiffTabState;
  session: ActiveSession;
  sessions: Record<string, ActiveSession>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<SchemaDiffTabState>) => void;
  onRunDiff: () => void;
  onApplySelectedDiff: (statements: string[]) => void;
  onRunDump: () => void;
  onPickRestoreFile: () => void;
  onRunRestore: () => void;
  onRunTransfer: () => void;
  onSaveSql: (sql: string, defaultName: string) => void;
  onOpenInQuery: (sql: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

export function SchemaDiffTab({
  tab,
  session,
  sessions,
  t,
  onUpdateTab,
  onRunDiff,
  onApplySelectedDiff,
  onRunDump,
  onPickRestoreFile,
  onRunRestore,
  onRunTransfer,
  onSaveSql,
  onOpenInQuery,
  onShortcut,
}: SchemaDiffTabProps) {
  const relationalSessions = useMemo(
    () => Object.values(sessions).filter((s) => isRelationalDriver(s.driver)),
    [sessions],
  );

  const leftSession = sessions[tab.leftConnectionId] ?? session;
  const rightSession = sessions[tab.rightConnectionId] ?? session;

  const leftSchemaOptions = leftSession.schemas.length > 0
    ? leftSession.schemas.map((s) => s.name)
    : [leftSession.activeSchema || 'main'];
  const rightSchemaOptions = rightSession.schemas.length > 0
    ? rightSession.schemas.map((s) => s.name)
    : [rightSession.activeSchema || 'main'];

  const leftTables = useMemo(() => {
    const cache = leftSession.objectsBySchema[schemaCacheKey(tab.leftDatabase || leftSession.activeDatabase, tab.leftSchema)];
    return (cache?.tables ?? []).map((tbl) => tbl.name);
  }, [leftSession, tab.leftDatabase, tab.leftSchema]);

  const lang = engineToMonacoLanguage(rightSession.connection.engine);
  const targetReadOnly = Boolean(rightSession.connection.readOnly);
  const sessionReadOnly = Boolean(session.connection.readOnly);

  const selectedDiffStatements = useMemo(() => {
    if (!tab.diffResult) return [] as string[];
    const items = tab.diffResult.items ?? [];
    if (items.length === 0) return tab.diffResult.migrationStatements;
    const selectedSet = new Set(tab.selectedItemIds);
    return items.filter((item) => selectedSet.has(item.id)).flatMap((item) => item.sql);
  }, [tab.diffResult, tab.selectedItemIds]);

  const diffPreviewSql = useMemo(() => {
    if (!tab.diffResult) return '';
    if (selectedDiffStatements.length === 0) return '-- No migration statements selected';
    return selectedDiffStatements.join('\n\n');
  }, [tab.diffResult, selectedDiffStatements]);

  const toggleDiffItem = (id: string) => {
    const next = new Set(tab.selectedItemIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onUpdateTab({ selectedItemIds: Array.from(next) });
  };

  const toggleTableSelection = (field: 'dumpTables' | 'transferTables', name: string) => {
    const cur = new Set(tab[field]);
    if (cur.has(name)) cur.delete(name);
    else cur.add(name);
    onUpdateTab({ [field]: Array.from(cur) } as Partial<SchemaDiffTabState>);
  };

  return (
    <div className="ndb-tab-pane">
      {/* Mode Switcher Bar */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <div className="ndb-segmented">
          {(
            [
              ['diff', t('Schema Diff')],
              ['dump', t('SQL Dump')],
              ['restore', t('SQL Restore')],
              ['transfer', t('Data Transfer')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab.mode === id ? 'is-active' : ''}
              onClick={() => onUpdateTab({ mode: id, error: undefined })}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ndb-spacer" />

        {tab.mode === 'diff' && diffPreviewSql && (
          <div className="ndb-toolbar-group">
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              onClick={() => onOpenInQuery(diffPreviewSql)}
            >
              {t('Open in Query')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-sm"
              onClick={() => onSaveSql(diffPreviewSql, `migration_${tab.leftSchema}_to_${tab.rightSchema}.sql`)}
            >
              {t('Save .sql')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={tab.loading || targetReadOnly || selectedDiffStatements.length === 0}
              title={targetReadOnly ? t('Read-Only Mode') : undefined}
              onClick={() => onApplySelectedDiff(selectedDiffStatements)}
            >
              <Icon name="check" />
              {`${t('Apply Selected')} (${selectedDiffStatements.length})`}
            </button>
          </div>
        )}

        {tab.mode === 'dump' && tab.dumpSql && (
          <div className="ndb-toolbar-group">
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              onClick={() => onOpenInQuery(tab.dumpSql)}
            >
              {t('Open in Query')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-sm"
              onClick={() => onSaveSql(tab.dumpSql, `${tab.leftDatabase || 'schema'}_${tab.leftSchema}.sql`)}
            >
              {t('Save .sql')}
            </button>
          </div>
        )}
      </div>

      {tab.error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      {/* MODE 1: SCHEMA DIFF */}
      {tab.mode === 'diff' && (
        <div className="ndb-diff-body">
          <div className="ndb-toolbar ndb-toolbar-wrap ndb-sub-toolbar">
            <span className="ndb-field-label">{t('Source')}</span>
            <select
              className="ndb-select-sm"
              value={leftSession.connectionId}
              onChange={(e) => {
                const nextSess = sessions[e.currentTarget.value];
                if (!nextSess) return;
                onUpdateTab({
                  leftConnectionId: nextSess.connectionId,
                  leftDatabase: nextSess.activeDatabase,
                  leftSchema: nextSess.activeSchema || nextSess.schemas[0]?.name || 'main',
                });
              }}
            >
              {relationalSessions.map((s) => (
                <option key={s.connectionId} value={s.connectionId}>{s.connection.name}</option>
              ))}
            </select>
            <select
              className="ndb-mono ndb-select-sm"
              value={tab.leftSchema}
              onChange={(e) => onUpdateTab({ leftSchema: e.currentTarget.value })}
            >
              {leftSchemaOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            <span className="ndb-muted">→</span>

            <span className="ndb-field-label">{t('Target')}</span>
            <select
              className="ndb-select-sm"
              value={rightSession.connectionId}
              onChange={(e) => {
                const nextSess = sessions[e.currentTarget.value];
                if (!nextSess) return;
                onUpdateTab({
                  rightConnectionId: nextSess.connectionId,
                  rightDatabase: nextSess.activeDatabase,
                  rightSchema: nextSess.activeSchema || nextSess.schemas[0]?.name || 'main',
                });
              }}
            >
              {relationalSessions.map((s) => (
                <option key={s.connectionId} value={s.connectionId}>{s.connection.name}</option>
              ))}
            </select>
            <select
              className="ndb-mono ndb-select-sm"
              value={tab.rightSchema}
              onChange={(e) => onUpdateTab({ rightSchema: e.currentTarget.value })}
            >
              {rightSchemaOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={tab.loading}
              onClick={onRunDiff}
            >
              <Icon name={tab.loading ? 'loader' : 'play'} />
              {t('Compare Schemas')}
            </button>
          </div>

          {tab.diffResult && (
            <div className="ndb-diff-summary-bar ndb-mono">
              <span className="ndb-tag ndb-tag-ok">{`+${tab.diffResult.addedTables.length} added`}</span>
              <span className="ndb-tag ndb-tag-warn">{`~${tab.diffResult.modifiedTables.length} modified`}</span>
              <span className="ndb-tag ndb-tag-danger">{`-${tab.diffResult.droppedTables.length} dropped`}</span>
              <span className="ndb-muted">{`${tab.diffResult.items.length} changes`}</span>
              <div className="ndb-spacer" />
              {tab.diffResult.items.length > 0 && (
                <>
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                    onClick={() => onUpdateTab({ selectedItemIds: tab.diffResult!.items.map((i) => i.id) })}
                  >
                    {t('Select All')}
                  </button>
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                    onClick={() => onUpdateTab({ selectedItemIds: [] })}
                  >
                    {t('Select None')}
                  </button>
                </>
              )}
            </div>
          )}

          {tab.diffResult && tab.diffResult.items.length > 0 && (
            <div className="ndb-diff-checklist">
              {tab.diffResult.items.map((item) => {
                const checked = tab.selectedItemIds.includes(item.id);
                const badgeCls =
                  item.action === 'add'
                    ? 'ndb-tag-ok'
                    : item.action === 'drop'
                      ? 'ndb-tag-danger'
                      : 'ndb-tag-warn';
                return (
                  <label key={item.id} className="ndb-diff-check-item">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDiffItem(item.id)}
                    />
                    <span className={`ndb-tag ndb-mono ${badgeCls}`}>{item.action.toUpperCase()}</span>
                    <span className="ndb-tag ndb-mono">{item.kind}</span>
                    <span className="ndb-mono ndb-truncate">{item.summary}</span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="ndb-editor-host">
            <PluginCodeEditor
              value={diffPreviewSql || '-- Choose Source & Target schemas and click Compare Schemas.'}
              language={lang}
              readOnly
              wordWrap="on"
              onShortcut={onShortcut}
            />
          </div>
        </div>
      )}

      {/* MODE 2: SQL DUMP */}
      {tab.mode === 'dump' && (
        <div className="ndb-diff-body">
          <div className="ndb-toolbar ndb-toolbar-wrap ndb-sub-toolbar">
            <label className="ndb-checkbox-row">
              <input
                type="checkbox"
                checked={tab.includeData}
                onChange={(e) => onUpdateTab({ includeData: e.currentTarget.checked })}
              />
              <span>{t('Include INSERT data')}</span>
            </label>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
              onClick={() => onUpdateTab({ dumpTables: [...leftTables] })}
            >
              {t('Select All')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
              onClick={() => onUpdateTab({ dumpTables: [] })}
            >
              {t('Select None')}
            </button>
            <div className="ndb-spacer" />
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={tab.loading}
              onClick={onRunDump}
            >
              <Icon name={tab.loading ? 'loader' : 'file-code'} />
              {t('Generate Dump SQL')}
            </button>
          </div>

          {leftTables.length > 0 && (
            <div className="ndb-table-chips">
              {leftTables.map((tbl) => {
                const checked = tab.dumpTables.length === 0 || tab.dumpTables.includes(tbl);
                return (
                  <label key={tbl} className="ndb-table-chip">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        if (tab.dumpTables.length === 0) {
                          onUpdateTab({ dumpTables: leftTables.filter((n) => n !== tbl) });
                        } else {
                          toggleTableSelection('dumpTables', tbl);
                        }
                      }}
                    />
                    <span className="ndb-mono">{tbl}</span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="ndb-editor-host">
            <PluginCodeEditor
              value={tab.dumpSql || '-- Click Generate Dump SQL to export CREATE TABLE & INSERT statements.'}
              language={lang}
              readOnly
              wordWrap="on"
              onShortcut={onShortcut}
            />
          </div>
        </div>
      )}

      {/* MODE 3: SQL RESTORE */}
      {tab.mode === 'restore' && (
        <div className="ndb-structure-scroll ndb-transfer-body">
          <div className="ndb-section-box">
            <div className="ndb-inline-row">
              <strong>{`${t('SQL Restore')} → ${session.connection.name}`}</strong>
              {sessionReadOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
            </div>
            <div className="ndb-file-row">
              <span className="ndb-mono ndb-truncate">{tab.restoreFileName || 'Choose a .sql dump file to restore'}</span>
              <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={onPickRestoreFile}>
                <Icon name="folder" />
                {t('Choose SQL File...')}
              </button>
            </div>
            <div className="ndb-inline-row">
              <label className="ndb-checkbox-row">
                <input
                  type="checkbox"
                  checked={tab.restoreContinueOnError}
                  onChange={(e) => onUpdateTab({ restoreContinueOnError: e.currentTarget.checked })}
                />
                <span>{t('Continue on error')}</span>
              </label>
              <div className="ndb-spacer" />
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-sm"
                disabled={tab.loading || sessionReadOnly || !tab.restoreSql.trim()}
                onClick={onRunRestore}
              >
                <Icon name={tab.loading ? 'loader' : 'play'} />
                {t('Run Restore')}
              </button>
            </div>

            {tab.restoreProgress && (
              <div className="ndb-progress-block">
                <div className="ndb-progress-meta ndb-mono">
                  <span>{`${tab.restoreProgress.completed} / ${tab.restoreProgress.total} statements`}</span>
                  <span>{`OK ${tab.restoreProgress.succeeded} · ERR ${tab.restoreProgress.failed}`}</span>
                </div>
                <div className="ndb-progress-track">
                  <div
                    className="ndb-progress-fill"
                    style={{
                      width: `${tab.restoreProgress.total > 0 ? Math.round((tab.restoreProgress.completed / tab.restoreProgress.total) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {tab.restoreResult && (
              <div className="ndb-section-box">
                <div className="ndb-inline-row ndb-mono">
                  <span className="ndb-tag ndb-tag-ok">{`Succeeded: ${tab.restoreResult.succeeded}`}</span>
                  <span className={`ndb-tag ${tab.restoreResult.failed > 0 ? 'ndb-tag-danger' : ''}`}>
                    {`Failed: ${tab.restoreResult.failed}`}
                  </span>
                  <span className="ndb-muted">{`${tab.restoreResult.executionMs} ms`}</span>
                </div>
                {tab.restoreResult.errors.length > 0 && (
                  <div className="ndb-messages-list">
                    {tab.restoreResult.errors.map((err, i) => (
                      <div key={i} className="ndb-msg-row ndb-msg-error">
                        <span className="ndb-mono">{`#${err.index + 1}: ${err.message}`}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODE 4: CROSS-CONNECTION DATA TRANSFER */}
      {tab.mode === 'transfer' && (
        <div className="ndb-structure-scroll ndb-transfer-body">
          <div className="ndb-section-box">
            <div className="ndb-toolbar-group ndb-toolbar-wrap">
              <span className="ndb-field-label">{t('Source')}</span>
              <select
                className="ndb-select-sm"
                value={leftSession.connectionId}
                onChange={(e) => {
                  const nextSess = sessions[e.currentTarget.value];
                  if (!nextSess) return;
                  onUpdateTab({
                    leftConnectionId: nextSess.connectionId,
                    leftDatabase: nextSess.activeDatabase,
                    leftSchema: nextSess.activeSchema || nextSess.schemas[0]?.name || 'main',
                    transferTables: [],
                  });
                }}
              >
                {relationalSessions.map((s) => (
                  <option key={s.connectionId} value={s.connectionId}>{`${s.connection.name} (${s.family})`}</option>
                ))}
              </select>
              <span className="ndb-muted">→</span>
              <span className="ndb-field-label">{t('Target')}</span>
              <select
                className="ndb-select-sm"
                value={rightSession.connectionId}
                onChange={(e) => {
                  const nextSess = sessions[e.currentTarget.value];
                  if (!nextSess) return;
                  onUpdateTab({
                    rightConnectionId: nextSess.connectionId,
                    rightDatabase: nextSess.activeDatabase,
                    rightSchema: nextSess.activeSchema || nextSess.schemas[0]?.name || 'main',
                  });
                }}
              >
                {relationalSessions.map((s) => (
                  <option key={s.connectionId} value={s.connectionId}>{`${s.connection.name} (${s.family})`}</option>
                ))}
              </select>
              {targetReadOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
            </div>

            <div className="ndb-inline-row ndb-toolbar-wrap">
              <label className="ndb-checkbox-row">
                <input
                  type="checkbox"
                  checked={tab.transferCreateTables}
                  onChange={(e) => onUpdateTab({ transferCreateTables: e.currentTarget.checked })}
                />
                <span>{t('Create target tables')}</span>
              </label>
              <label className="ndb-checkbox-row">
                <input
                  type="checkbox"
                  checked={tab.transferDropIfExists}
                  onChange={(e) => onUpdateTab({ transferDropIfExists: e.currentTarget.checked })}
                />
                <span>{t('Drop if exists')}</span>
              </label>
              <label className="ndb-checkbox-row">
                <input
                  type="checkbox"
                  checked={tab.transferIncludeData}
                  onChange={(e) => onUpdateTab({ transferIncludeData: e.currentTarget.checked })}
                />
                <span>{t('Include data')}</span>
              </label>
              <div className="ndb-spacer" />
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                onClick={() => onUpdateTab({ transferTables: [...leftTables] })}
              >
                {t('Select All')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-sm"
                disabled={tab.loading || targetReadOnly || tab.transferTables.length === 0}
                onClick={onRunTransfer}
              >
                <Icon name={tab.loading ? 'loader' : 'play'} />
                {`${t('Start Transfer')} (${tab.transferTables.length})`}
              </button>
            </div>

            <div className="ndb-table-chips">
              {leftTables.map((tbl) => (
                <label key={tbl} className="ndb-table-chip">
                  <input
                    type="checkbox"
                    checked={tab.transferTables.includes(tbl)}
                    onChange={() => toggleTableSelection('transferTables', tbl)}
                  />
                  <span className="ndb-mono">{tbl}</span>
                </label>
              ))}
              {leftTables.length === 0 && (
                <span className="ndb-muted">Open the source schema in the Explorer to load its table list.</span>
              )}
            </div>

            {tab.transferProgress && (
              <div className="ndb-progress-block">
                <div className="ndb-progress-meta ndb-mono">
                  <span>{`Table ${tab.transferProgress.tableIndex + 1}/${tab.transferProgress.totalTables}: ${tab.transferProgress.table} (${tab.transferProgress.stage})`}</span>
                  <span>{`${tab.transferProgress.rowsCopied} rows`}</span>
                </div>
                <div className="ndb-progress-track">
                  <div
                    className="ndb-progress-fill"
                    style={{
                      width: `${tab.transferProgress.totalTables > 0 ? Math.round(((tab.transferProgress.tableIndex + (tab.transferProgress.stage === 'done' ? 1 : 0.5)) / tab.transferProgress.totalTables) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {tab.transferResult && (
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th>Rows Copied</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tab.transferResult.tables.map((r) => (
                    <tr key={r.table}>
                      <td className="ndb-mono"><strong>{r.table}</strong></td>
                      <td className="ndb-mono">{r.rowsCopied}</td>
                      <td>
                        {r.error ? (
                          <span className="ndb-tag ndb-tag-danger">{r.error}</span>
                        ) : (
                          <span className="ndb-tag ndb-tag-ok">OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
