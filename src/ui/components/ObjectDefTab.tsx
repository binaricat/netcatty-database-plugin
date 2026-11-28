/**
 * Dedicated Object Definition, Editable Source & Routine Execution Tab (Full Workbench Parity):
 * - Displays & edits Views, Materialized Views, Functions, Procedures, Triggers,
 *   Sequences, MySQL Events, Custom Types, Extensions, and Synonyms in Monaco.
 * - Save & Compile edited DDL (with read-only guard).
 * - Execute Routine panel parsing IN/OUT/INOUT params for PG / MySQL / MSSQL.
 * - Sequence Alter/Restart, Materialized View Refresh, Trigger & Event Enable/Disable.
 * - Object Dependencies bar.
 */

import React, { useMemo, useState } from 'react';
import { PluginCodeEditor, type PluginWorkbenchShortcut } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import {
  buildMysqlEventToggleSql,
  buildRefreshMaterializedViewSql,
  buildRoutineExecutionSql,
  buildSequenceAlterSql,
  buildTriggerToggleSql,
  parseRoutineParameters,
} from '../../sql/routineSql';
import { engineToMonacoLanguage, engineToSqlDialect } from '../sessionManager';
import type { ActiveSession, ObjectDefTabState } from '../types';

export interface ObjectDefTabProps {
  tab: ObjectDefTabState;
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenInQuery: (sql: string) => void;
  onRunInQuery?: (sql: string, title?: string) => void;
  onCopyDdl: (sql: string) => void;
  onOpenViewData?: () => void;
  onExecuteSql?: (sql: string, title?: string) => Promise<void>;
  onUpdateTab?: (patch: Partial<ObjectDefTabState>) => void;
  onShortcut?: (shortcut: PluginWorkbenchShortcut) => void;
}

export function ObjectDefTab({
  tab,
  session,
  t,
  onOpenInQuery,
  onRunInQuery,
  onCopyDdl,
  onOpenViewData,
  onExecuteSql,
  onUpdateTab,
  onShortcut,
}: ObjectDefTabProps) {
  const readOnly = Boolean(session.connection.readOnly);
  const language = engineToMonacoLanguage(session.connection.engine);
  const dialect = engineToSqlDialect(session.connection.engine);
  const kindBadge = tab.objectKind.replaceAll('_', ' ').toUpperCase();

  const [editing, setEditing] = useState(false);
  const [draftDdl, setDraftDdl] = useState(tab.definition);
  const [saving, setSaving] = useState(false);
  const [showExecPanel, setShowExecPanel] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [seqRestartVal, setSeqRestartVal] = useState('');
  const [seqIncVal, setSeqIncVal] = useState('');
  const [showDeps, setShowDeps] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const isRoutine = tab.objectKind === 'function' || tab.objectKind === 'procedure';
  const isViewLike = tab.objectKind === 'view' || tab.objectKind === 'materialized_view';
  const parsedParams = useMemo(
    () => (isRoutine ? parseRoutineParameters(tab.arguments, dialect) : []),
    [isRoutine, tab.arguments, dialect],
  );

  const generatedCallSql = useMemo(() => {
    if (!isRoutine) return '';
    return buildRoutineExecutionSql({
      dialect,
      db: tab.database,
      schema: tab.schema,
      name: tab.name,
      kind: tab.objectKind === 'procedure' ? 'procedure' : 'function',
      params: parsedParams,
      values: paramValues,
    });
  }, [isRoutine, dialect, tab.database, tab.schema, tab.name, tab.objectKind, parsedParams, paramValues]);

  const runActionSql = async (sql: string, label: string) => {
    if (!onExecuteSql) {
      onOpenInQuery(sql);
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      await onExecuteSql(sql, label);
      setStatusMsg(`${label}: OK`);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCompile = async () => {
    if (readOnly || !draftDdl.trim()) return;
    await runActionSql(draftDdl, `${t('Save & Compile')} ${tab.name}`);
    onUpdateTab?.({ definition: draftDdl, dirty: false });
    setEditing(false);
  };

  const deps = tab.dependencies ?? [];

  return (
    <div className="ndb-tab-pane">
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <div className="ndb-toolbar-group ndb-toolbar-nowrap">
          <span className="ndb-tag ndb-mono">{kindBadge}</span>
          <strong className="ndb-mono">{`${tab.schema ? `${tab.schema}.` : ''}${tab.name}`}</strong>
          {tab.tableName && <span className="ndb-tag ndb-mono">{`ON ${tab.tableName}`}</span>}
          {tab.language && <span className="ndb-tag ndb-mono">{tab.language}</span>}
          {tab.returnType && <span className="ndb-tag ndb-mono">{`-> ${tab.returnType}`}</span>}
          {tab.timing && tab.event && (
            <span className="ndb-tag ndb-mono">{`${tab.timing} ${tab.event}`}</span>
          )}
          {tab.enabled === false && <span className="ndb-tag ndb-tag-warn">{t('Disabled')}</span>}
        </div>

        <div className="ndb-spacer" />

        <div className="ndb-toolbar-group ndb-toolbar-nowrap">
          {isViewLike && onOpenViewData && (
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={onOpenViewData}>
              <Icon name="table" />
              {t('Open Data')}
            </button>
          )}
          {tab.objectKind === 'materialized_view' && !readOnly && (
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-sm"
              disabled={saving}
              onClick={() =>
                void runActionSql(
                  buildRefreshMaterializedViewSql({
                    dialect,
                    db: tab.database,
                    schema: tab.schema,
                    name: tab.name,
                  }),
                  t('Refresh Materialized View'),
                )
              }
            >
              <Icon name="refresh" />
              {t('Refresh MV')}
            </button>
          )}
          {isRoutine && (
            <button
              type="button"
              className={`ndb-btn ndb-btn-sm ${showExecPanel ? 'ndb-btn-primary' : 'ndb-btn-secondary'}`}
              onClick={() => setShowExecPanel((v) => !v)}
            >
              <Icon name="play" />
              {t('Execute')}
            </button>
          )}
          {tab.objectKind === 'trigger' && tab.tableName && !readOnly && (dialect === 'postgres' || dialect === 'mssql') && (
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-sm"
              disabled={saving}
              onClick={() => {
                const nextEnable = tab.enabled === false;
                void runActionSql(
                  buildTriggerToggleSql({
                    dialect,
                    db: tab.database,
                    schema: tab.schema,
                    tableName: tab.tableName!,
                    triggerName: tab.name,
                    enable: nextEnable,
                  }),
                  nextEnable ? t('Enable Trigger') : t('Disable Trigger'),
                ).then(() => onUpdateTab?.({ enabled: nextEnable }));
              }}
            >
              {tab.enabled === false ? t('Enable Trigger') : t('Disable Trigger')}
            </button>
          )}
          {tab.objectKind === 'event' && !readOnly && dialect === 'mysql' && (
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-sm"
              disabled={saving}
              onClick={() => {
                const nextEnable = tab.enabled === false;
                void runActionSql(
                  buildMysqlEventToggleSql(tab.database, tab.name, nextEnable),
                  nextEnable ? t('Enable Event') : t('Disable Event'),
                ).then(() => onUpdateTab?.({ enabled: nextEnable }));
              }}
            >
              {tab.enabled === false ? t('Enable Event') : t('Disable Event')}
            </button>
          )}
          {!readOnly && !editing && (
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-sm"
              onClick={() => {
                setDraftDdl(tab.definition);
                setEditing(true);
              }}
            >
              {t('Edit Source')}
            </button>
          )}
          {!readOnly && editing && (
            <>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                onClick={() => {
                  setDraftDdl(tab.definition);
                  setEditing(false);
                }}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-sm"
                disabled={saving}
                onClick={() => void handleSaveCompile()}
              >
                <Icon name="check" />
                {t('Save & Compile')}
              </button>
            </>
          )}
          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-sm"
            onClick={() => onCopyDdl(editing ? draftDdl : tab.definition)}
          >
            {t('Copy DDL')}
          </button>
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary ndb-btn-sm"
            onClick={() => onOpenInQuery(editing ? draftDdl : tab.definition)}
          >
            <Icon name="file-code" />
            {t('Open in Query')}
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className="ndb-banner ndb-banner-inline">
          <span className="ndb-mono">{statusMsg}</span>
        </div>
      )}

      {/* Routine Execution Parameter Form */}
      {isRoutine && showExecPanel && (
        <div className="ndb-inline-panel ndb-routine-exec">
          <div className="ndb-inline-panel-head">
            <strong>{`${t('Execute')} ${tab.objectKind === 'procedure' ? t('Procedure') : t('Function')}: ${tab.name}`}</strong>
            <div className="ndb-toolbar-group">
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                onClick={() => onOpenInQuery(generatedCallSql)}
              >
                {t('Open in Query')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-sm"
                disabled={saving}
                onClick={() => {
                  if (onRunInQuery) {
                    onRunInQuery(generatedCallSql, `${t('Execute')} ${tab.name}`);
                  } else {
                    void runActionSql(generatedCallSql, `${t('Execute')} ${tab.name}`);
                  }
                }}
              >
                <Icon name="play" />
                {t('Run')}
              </button>
            </div>
          </div>
          {parsedParams.length > 0 ? (
            <div className="ndb-param-grid">
              {parsedParams.map((p) => (
                <label key={p.name} className="ndb-param-field">
                  <span className="ndb-mono">
                    <span className="ndb-tag">{p.mode}</span> {p.name}{' '}
                    <span className="ndb-muted">{p.dataType}</span>
                  </span>
                  <input
                    type="text"
                    className="ndb-mono ndb-input-compact"
                    disabled={p.mode === 'OUT'}
                    placeholder={p.mode === 'OUT' ? '(OUTPUT)' : (p.defaultValue ?? 'NULL')}
                    value={paramValues[p.name] ?? ''}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      setParamValues((prev) => ({ ...prev, [p.name]: val }));
                    }}
                  />
                </label>
              ))}
            </div>
          ) : (
            <p className="ndb-muted ndb-mono">{t('No parameters')}</p>
          )}
          <pre className="ndb-sql-preview ndb-mono">{generatedCallSql}</pre>
        </div>
      )}

      {/* Sequence Quick Alter / Restart Strip */}
      {tab.objectKind === 'sequence' && !readOnly && (
        <div className="ndb-inline-card">
          <span className="ndb-field-label">{t('Alter Sequence')}</span>
          <input
            type="text"
            className="ndb-mono ndb-input-compact"
            placeholder="RESTART WITH (e.g. 100)"
            value={seqRestartVal}
            onChange={(e) => setSeqRestartVal(e.currentTarget.value)}
          />
          <input
            type="text"
            className="ndb-mono ndb-input-compact"
            placeholder="INCREMENT BY (e.g. 1)"
            value={seqIncVal}
            onChange={(e) => setSeqIncVal(e.currentTarget.value)}
          />
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary ndb-btn-sm"
            disabled={saving}
            onClick={() =>
              void runActionSql(
                buildSequenceAlterSql({
                  dialect,
                  db: tab.database,
                  schema: tab.schema,
                  name: tab.name,
                  restartWith: seqRestartVal || undefined,
                  increment: seqIncVal || undefined,
                }),
                t('Alter Sequence'),
              )
            }
          >
            {t('Apply')}
          </button>
        </div>
      )}

      <div className="ndb-editor-host">
        <PluginCodeEditor
          value={
            editing
              ? draftDdl
              : tab.definition || `-- Definition not available for ${tab.objectKind} ${tab.name}`
          }
          language={language}
          readOnly={!editing}
          wordWrap="on"
          onChange={editing ? ({ value }) => setDraftDdl(value) : undefined}
          onShortcut={onShortcut ? ({ shortcut }) => onShortcut(shortcut) : undefined}
        />
      </div>

      {/* Collapsible Object Dependencies */}
      {showDeps && deps.length > 0 && (
        <div className="ndb-inline-panel">
          <strong>{t('Dependencies')}</strong>
          <div className="ndb-dep-list">
            {deps.map((d, idx) => (
              <span key={`${d.schema}.${d.name}:${idx}`} className="ndb-tag ndb-mono">
                {`${d.direction === 'referenced_by' ? '<-' : '->'} ${d.kind}: ${d.schema}.${d.name}`}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="ndb-result-strip ndb-mono">
        <span>{`${tab.database}${tab.schema ? ` / ${tab.schema}` : ''}`}</span>
        {tab.arguments && <span>{`(${tab.arguments})`}</span>}
        {deps.length > 0 && (
          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-sm"
            onClick={() => setShowDeps((v) => !v)}
          >
            {`${t('Dependencies')} (${deps.length})`}
          </button>
        )}
        <span className="ndb-spacer" />
        <span className="ndb-muted">{editing ? t('Editing') : t('Read-Only')}</span>
      </div>
    </div>
  );
}
