/**
 * Schema Diff & SQL Dump Tab:
 * Compare two schemas (producing migration SQL in Monaco) OR dump schema/data SQL and save via `ui.saveFile`.
 */

import React from 'react';
import { PluginCodeEditor } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import { engineToMonacoLanguage } from '../sessionManager';
import type { ActiveSession, SchemaDiffTabState } from '../types';

export interface SchemaDiffTabProps {
  tab: SchemaDiffTabState;
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<SchemaDiffTabState>) => void;
  onRunDiff: () => void;
  onRunDump: () => void;
  onSaveSql: (sql: string, defaultName: string) => void;
  onOpenInQuery: (sql: string) => void;
}

export function SchemaDiffTab({
  tab,
  session,
  t,
  onUpdateTab,
  onRunDiff,
  onRunDump,
  onSaveSql,
  onOpenInQuery,
}: SchemaDiffTabProps) {
  const schemaOptions = session.schemas.length > 0
    ? session.schemas.map((s) => s.name)
    : [session.activeSchema || 'main'];
  const lang = engineToMonacoLanguage(session.connection.engine);
  const displaySql = tab.diffResult ? tab.diffResult.migrationSql || '-- Schemas are identical' : tab.dumpSql;

  return (
    <div className="dbx-tab-pane">
      <div className="dbx-toolbar dbx-toolbar-wrap">
        <div className="dbx-toolbar-group">
          <span className="dbx-field-label">Source</span>
          <select
            className="dbx-mono dbx-select-sm"
            value={tab.leftSchema}
            onChange={(e) => onUpdateTab({ leftSchema: e.currentTarget.value })}
          >
            {schemaOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <span className="dbx-muted">→</span>
          <span className="dbx-field-label">Target</span>
          <select
            className="dbx-mono dbx-select-sm"
            value={tab.rightSchema}
            onChange={(e) => onUpdateTab({ rightSchema: e.currentTarget.value })}
          >
            {schemaOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button
            type="button"
            className="dbx-btn dbx-btn-primary dbx-btn-sm"
            disabled={tab.loading}
            onClick={onRunDiff}
          >
            <Icon name={tab.loading ? 'loader' : 'play'} />
            Compare Schemas
          </button>
        </div>

        <div className="dbx-spacer" />

        <div className="dbx-toolbar-group">
          <label className="dbx-checkbox-row">
            <input
              type="checkbox"
              checked={tab.includeData}
              onChange={(e) => onUpdateTab({ includeData: e.currentTarget.checked })}
            />
            <span>Include INSERT data</span>
          </label>
          <button
            type="button"
            className="dbx-btn dbx-btn-secondary dbx-btn-sm"
            disabled={tab.loading}
            onClick={onRunDump}
          >
            <Icon name="file-code" />
            Generate Dump SQL
          </button>
          {displaySql && (
            <>
              <button
                type="button"
                className="dbx-btn dbx-btn-ghost dbx-btn-sm"
                onClick={() => onOpenInQuery(displaySql)}
              >
                Open in Query
              </button>
              <button
                type="button"
                className="dbx-btn dbx-btn-secondary dbx-btn-sm"
                onClick={() => onSaveSql(displaySql, `${tab.database || 'schema'}_${tab.leftSchema}.sql`)}
              >
                {t('Save .sql')}
              </button>
            </>
          )}
        </div>
      </div>

      {tab.error && (
        <div className="dbx-banner dbx-banner-error dbx-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      {tab.diffResult && (
        <div className="dbx-diff-summary-bar dbx-mono">
          <span className="dbx-tag dbx-tag-ok">{`+${tab.diffResult.addedTables.length} added tables`}</span>
          <span className="dbx-tag dbx-tag-warn">{`~${tab.diffResult.modifiedTables.length} modified tables`}</span>
          <span className="dbx-tag dbx-tag-danger">{`-${tab.diffResult.droppedTables.length} dropped tables`}</span>
          <span className="dbx-muted">{`${tab.diffResult.migrationStatements.length} migration statements`}</span>
        </div>
      )}

      <div className="dbx-editor-host">
        <PluginCodeEditor
          value={displaySql || '-- Select schemas to compare, or click Generate Dump SQL to export backup.'}
          language={lang}
          readOnly
          wordWrap="on"
        />
      </div>
    </div>
  );
}
