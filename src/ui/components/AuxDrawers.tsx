/**
 * Harmonious `AsidePanel`-style slide-over drawers (never destroying active tabs):
 * - AI SQL Assistant (`context.ai` via `DraftStream`)
 * - Query History & Saved Snippets
 * - Cell & Row Inspector (Monaco JSON/text editor)
 * - SQL Preview / Diff (read-only Monaco + Commit CTA)
 * - Import Data Wizard (CSV / JSON / SQL / XLSX via `ui.openFile` + column mapping)
 * - Create Table Designer (`generateCreateTableDdl` + Monaco preview + Execute)
 */

import React, { useMemo, useRef, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import { PluginCodeEditor } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import { DraftStream, extractSqlDraft } from '../../domain';
import type {
  CellValue,
  CreateColumnSpec,
  RelationalDriver,
  SqlDialect,
} from '../../drivers/types';
import {
  autoMapImportColumns,
  importCsv,
  importJson,
  importSqlScript,
  importXlsx,
  type ImportedTableData,
} from '../../sql/index';
import { engineToMonacoLanguage, engineToSqlDialect, schemaCacheKey } from '../sessionManager';
import type {
  ActiveSession,
  CreateTableTarget,
  ImportWizardTarget,
  InspectorTarget,
  QueryHistoryEntry,
  SavedSnippet,
  SqlPreviewTarget,
} from '../types';

/* ============================================================================
 * 1. AI SQL Assistant Drawer
 * ============================================================================ */

export function AiAssistantDrawer({
  context,
  session,
  currentSql,
  t,
  onInsertSql,
  onClose,
}: {
  context: PluginContext;
  session: ActiveSession | undefined;
  currentSql: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onInsertSql: (sql: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'generate' | 'explain' | 'optimize' | 'fix'>('generate');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [modelName, setModelName] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<DraftStream | null>(null);

  const schemaSummary = useMemo(() => {
    if (!session) return 'No active connection.';
    const cache = session.objectsBySchema[schemaCacheKey(session.activeDatabase, session.activeSchema)];
    if (!cache) return `Database: ${session.activeDatabase}`;
    const lines = cache.tables.slice(0, 30).map((tbl) => {
      const cols = cache.structures[tbl.name]?.columns
        .map((c) => `${c.name}:${c.dataType}${c.isPrimaryKey ? '[PK]' : ''}`)
        .join(', ');
      return cols ? `- ${tbl.name} (${cols})` : `- ${tbl.name}`;
    });
    return `Engine: ${session.connection.engine}\nDatabase: ${session.activeDatabase}\nSchema: ${session.activeSchema}\nTables:\n${lines.join('\n')}`;
  }, [session]);

  const handleRun = async () => {
    if (!context.ai) {
      setError('Host AI capability is unavailable.');
      return;
    }
    setRunning(true);
    setError(null);
    setOutput('');
    if (!streamRef.current) streamRef.current = new DraftStream(context.ai);

    const instructions: Record<typeof mode, string> = {
      generate: 'Generate a clean, accurate SQL query for the user request using the schema below. Return the SQL inside a ```sql code block.',
      explain: 'Explain what the SQL query below does step-by-step and note any performance considerations.',
      optimize: 'Optimize the SQL query below for performance and clarity. Return the improved query in a ```sql code block.',
      fix: 'Identify and fix syntax or schema errors in the SQL query below. Return the corrected query in a ```sql code block.',
    };

    const fullPrompt = [
      instructions[mode],
      '',
      'Schema Context:',
      schemaSummary,
      currentSql.trim() ? `\nCurrent Editor SQL:\n\`\`\`sql\n${currentSql.slice(0, 4000)}\n\`\`\`` : '',
      prompt.trim() ? `\nUser Request:\n${prompt.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await streamRef.current.run(
        fullPrompt,
        (text) => setOutput(text),
        (model) => setModelName(model),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleStop = () => {
    void streamRef.current?.stop();
    setRunning(false);
  };

  const extractedSql = useMemo(() => {
    if (!output.trim()) return null;
    const fenced = /```(?:sql|pgsql|mysql)?\s*\n([\s\S]*?)```/i.exec(output);
    if (fenced?.[1]?.trim()) return fenced[1].trim();
    return extractSqlDraft(output, mode === 'explain' ? 'explain' : 'generate');
  }, [output, mode]);

  return (
    <aside className="dbx-drawer dbx-drawer-wide" role="dialog" aria-label={t('AI SQL Assistant')}>
      <header className="dbx-drawer-header">
        <div className="dbx-drawer-title-group">
          <Icon name="sparkles" />
          <div>
            <h2>{t('AI SQL Assistant')}</h2>
            <p className="dbx-drawer-subtitle">
              {modelName || (session ? `${session.connection.name} · ${session.activeSchema || session.activeDatabase}` : 'Schema-aware SQL drafting')}
            </p>
          </div>
        </div>
        <button type="button" className="dbx-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="dbx-drawer-body dbx-form-body">
        <div className="dbx-pill-tabs">
          {(
            [
              ['generate', t('Generate')],
              ['explain', t('Explain')],
              ['optimize', t('Optimize')],
              ['fix', t('Fix Error')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`dbx-pill-tab ${mode === id ? 'is-active' : ''}`}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="dbx-field">
          <span>{mode === 'generate' ? 'Describe the query you need' : 'Additional instructions (optional)'}</span>
          <textarea
            rows={4}
            placeholder={
              mode === 'generate'
                ? 'e.g. Top 10 customers by total order amount in the last 30 days'
                : 'e.g. Focus on index usage or explain error message...'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />
        </label>

        <div className="dbx-inline-row">
          <button
            type="button"
            className="dbx-btn dbx-btn-primary dbx-btn-sm"
            disabled={running}
            onClick={() => void handleRun()}
          >
            <Icon name={running ? 'loader' : 'sparkles'} />
            {running ? 'Generating...' : 'Run Assistant'}
          </button>
          {running && (
            <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={handleStop}>
              Stop
            </button>
          )}
          {extractedSql && (
            <button
              type="button"
              className="dbx-btn dbx-btn-secondary dbx-btn-sm"
              onClick={() => onInsertSql(extractedSql)}
            >
              <Icon name="arrow-right" />
              {t('Insert into Editor')}
            </button>
          )}
        </div>

        {error && (
          <div className="dbx-banner dbx-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}

        {output && (
          <div className="dbx-ai-output">
            <pre className="dbx-mono">{output}</pre>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ============================================================================
 * 2. Query History & Saved Snippets Drawer
 * ============================================================================ */

export function HistorySnippetsDrawer({
  initialTab,
  history,
  snippets,
  currentSql,
  currentDialect,
  t,
  onInsertSql,
  onOpenNewQuery,
  onSaveSnippet,
  onDeleteSnippet,
  onClearHistory,
  onClose,
}: {
  initialTab: 'history' | 'snippets';
  history: QueryHistoryEntry[];
  snippets: SavedSnippet[];
  currentSql: string;
  currentDialect: SqlDialect;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onInsertSql: (sql: string) => void;
  onOpenNewQuery: (sql: string) => void;
  onSaveSnippet: (title: string, sql: string, tags: string[]) => void;
  onDeleteSnippet: (id: string) => void;
  onClearHistory: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'history' | 'snippets'>(initialTab);
  const [search, setSearch] = useState('');
  const [snipTitle, setSnipTitle] = useState('');
  const [snipTags, setSnipTags] = useState('');
  const [snipSql, setSnipSql] = useState(currentSql);

  const q = search.trim().toLowerCase();
  const filteredHistory = useMemo(
    () =>
      history.filter(
        (h) => !q || h.sql.toLowerCase().includes(q) || h.connectionName.toLowerCase().includes(q),
      ),
    [history, q],
  );
  const filteredSnippets = useMemo(
    () =>
      snippets.filter(
        (s) =>
          !q ||
          s.title.toLowerCase().includes(q) ||
          s.sql.toLowerCase().includes(q) ||
          s.tags.some((tag) => tag.toLowerCase().includes(q)),
      ),
    [snippets, q],
  );

  return (
    <aside className="dbx-drawer dbx-drawer-wide" role="dialog" aria-label={t('Query History & Snippets')}>
      <header className="dbx-drawer-header">
        <div className="dbx-drawer-title-group">
          <Icon name="book-open" />
          <div>
            <h2>{t('Query History & Snippets')}</h2>
            <p className="dbx-drawer-subtitle">{`${history.length} executed · ${snippets.length} saved`}</p>
          </div>
        </div>
        <button type="button" className="dbx-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="dbx-drawer-body dbx-form-body">
        <div className="dbx-inline-row">
          <div className="dbx-segmented">
            <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>
              {`${t('History')} (${history.length})`}
            </button>
            <button type="button" className={tab === 'snippets' ? 'is-active' : ''} onClick={() => setTab('snippets')}>
              {`${t('Snippets')} (${snippets.length})`}
            </button>
          </div>
          <div className="dbx-spacer" />
          {tab === 'history' && history.length > 0 && (
            <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-xs" onClick={onClearHistory}>
              {t('Clear')}
            </button>
          )}
        </div>

        <div className="dbx-picker-search">
          <Icon name="search" />
          <input
            type="text"
            placeholder="Search SQL..."
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </div>

        {tab === 'snippets' && (
          <form
            className="dbx-section-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (!snipTitle.trim() || !snipSql.trim()) return;
              const tags = snipTags
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              onSaveSnippet(snipTitle.trim(), snipSql.trim(), tags);
              setSnipTitle('');
              setSnipTags('');
            }}
          >
            <strong>Save New Snippet ({currentDialect})</strong>
            <div className="dbx-form-grid">
              <input
                type="text"
                placeholder="Snippet title"
                value={snipTitle}
                onChange={(e) => setSnipTitle(e.currentTarget.value)}
              />
              <input
                type="text"
                placeholder="tags, comma-separated"
                value={snipTags}
                onChange={(e) => setSnipTags(e.currentTarget.value)}
              />
            </div>
            <textarea
              rows={3}
              className="dbx-mono"
              placeholder="SELECT ..."
              value={snipSql}
              onChange={(e) => setSnipSql(e.currentTarget.value)}
            />
            <button
              type="submit"
              className="dbx-btn dbx-btn-primary dbx-btn-sm"
              disabled={!snipTitle.trim() || !snipSql.trim()}
            >
              Save Snippet
            </button>
          </form>
        )}

        <div className="dbx-card-list">
          {tab === 'history' ? (
            filteredHistory.length === 0 ? (
              <p className="dbx-tree-empty">{t('No results')}</p>
            ) : (
              filteredHistory.map((item) => (
                <div key={item.id} className="dbx-history-card">
                  <div className="dbx-history-meta">
                    <span className={item.success ? 'dbx-tag dbx-tag-ok' : 'dbx-tag dbx-tag-danger'}>
                      {item.success ? 'OK' : 'ERR'}
                    </span>
                    <span className="dbx-muted">{item.connectionName}</span>
                    <span className="dbx-mono dbx-muted">{`${item.executionMs} ms · ${item.rowCount} rows`}</span>
                    <span className="dbx-spacer" />
                    <span className="dbx-muted">{new Date(item.executedAt).toLocaleTimeString()}</span>
                  </div>
                  <pre className="dbx-history-sql dbx-mono">{item.sql.slice(0, 240)}</pre>
                  <div className="dbx-inline-row">
                    <button
                      type="button"
                      className="dbx-btn dbx-btn-secondary dbx-btn-xs"
                      onClick={() => onInsertSql(item.sql)}
                    >
                      {t('Insert into Editor')}
                    </button>
                    <button
                      type="button"
                      className="dbx-btn dbx-btn-ghost dbx-btn-xs"
                      onClick={() => onOpenNewQuery(item.sql)}
                    >
                      {t('New Query')}
                    </button>
                  </div>
                </div>
              ))
            )
          ) : filteredSnippets.length === 0 ? (
            <p className="dbx-tree-empty">No saved snippets yet.</p>
          ) : (
            filteredSnippets.map((snip) => (
              <div key={snip.id} className="dbx-history-card">
                <div className="dbx-history-meta">
                  <strong>{snip.title}</strong>
                  {snip.tags.map((tag) => (
                    <span key={tag} className="dbx-tag">{tag}</span>
                  ))}
                  <span className="dbx-spacer" />
                  <button
                    type="button"
                    className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
                    onClick={() => onDeleteSnippet(snip.id)}
                  >
                    {t('Delete')}
                  </button>
                </div>
                <pre className="dbx-history-sql dbx-mono">{snip.sql.slice(0, 260)}</pre>
                <div className="dbx-inline-row">
                  <button
                    type="button"
                    className="dbx-btn dbx-btn-secondary dbx-btn-xs"
                    onClick={() => onInsertSql(snip.sql)}
                  >
                    {t('Insert into Editor')}
                  </button>
                  <button
                    type="button"
                    className="dbx-btn dbx-btn-ghost dbx-btn-xs"
                    onClick={() => onOpenNewQuery(snip.sql)}
                  >
                    {t('New Query')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

/* ============================================================================
 * 3. Cell & Row Inspector Drawer
 * ============================================================================ */

export function CellInspectorDrawer({
  target,
  t,
  onSaveCell,
  onCopy,
  onClose,
}: {
  target: InspectorTarget;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onSaveCell?: (rowIndex: number, colName: string, value: string, isNull: boolean) => void;
  onCopy: (text: string, label: string) => void;
  onClose: () => void;
}) {
  const [viewMode, setViewMode] = useState<'cell' | 'row'>('cell');
  const initialCellText = useMemo(() => {
    if (target.value === null || target.value === undefined) return '';
    if (target.value instanceof Uint8Array) {
      return '0x' + Array.from(target.value, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (typeof target.value === 'object') return JSON.stringify(target.value, null, 2);
    const s = String(target.value);
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch {
        return s;
      }
    }
    return s;
  }, [target.value]);

  const [draft, setDraft] = useState(initialCellText);
  const [isNull, setIsNull] = useState(target.value === null || target.value === undefined);
  const rowJson = useMemo(() => JSON.stringify(target.rowObject, null, 2), [target.rowObject]);
  const isJson =
    typeof target.value === 'object' ||
    (draft.trim().startsWith('{') && draft.trim().endsWith('}')) ||
    (draft.trim().startsWith('[') && draft.trim().endsWith(']'));

  return (
    <aside className="dbx-drawer dbx-drawer-wide" role="dialog" aria-label={t('Cell & Row Inspector')}>
      <header className="dbx-drawer-header">
        <div className="dbx-drawer-title-group">
          <Icon name="eye" />
          <div>
            <h2>{t('Cell & Row Inspector')}</h2>
            <p className="dbx-drawer-subtitle dbx-mono">{`Row #${target.rowIndex + 1} · ${target.colName}`}</p>
          </div>
        </div>
        <button type="button" className="dbx-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="dbx-drawer-body dbx-drawer-editor-body">
        <div className="dbx-inline-row">
          <div className="dbx-segmented">
            <button type="button" className={viewMode === 'cell' ? 'is-active' : ''} onClick={() => setViewMode('cell')}>
              Cell Value
            </button>
            <button type="button" className={viewMode === 'row' ? 'is-active' : ''} onClick={() => setViewMode('row')}>
              Full Row JSON
            </button>
          </div>
          <div className="dbx-spacer" />
          <button
            type="button"
            className="dbx-btn dbx-btn-ghost dbx-btn-xs"
            onClick={() => onCopy(viewMode === 'cell' ? (isNull ? 'NULL' : draft) : rowJson, target.colName)}
          >
            {t('Copy')}
          </button>
        </div>

        <div className="dbx-editor-host dbx-drawer-monaco">
          {viewMode === 'cell' ? (
            <PluginCodeEditor
              value={isNull ? '' : draft}
              language={isJson ? 'json' : 'plaintext'}
              readOnly={!target.editable}
              wordWrap="on"
              placeholder={isNull ? 'NULL' : undefined}
              onChange={({ value }) => {
                setIsNull(false);
                setDraft(value);
              }}
            />
          ) : (
            <PluginCodeEditor value={rowJson} language="json" readOnly wordWrap="on" />
          )}
        </div>
      </div>

      {viewMode === 'cell' && target.editable && onSaveCell && (
        <footer className="dbx-drawer-footer">
          <label className="dbx-checkbox-row">
            <input
              type="checkbox"
              checked={isNull}
              onChange={(e) => setIsNull(e.currentTarget.checked)}
            />
            <span>NULL</span>
          </label>
          <div className="dbx-spacer" />
          <button type="button" className="dbx-btn dbx-btn-secondary" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="dbx-btn dbx-btn-primary"
            onClick={() => {
              onSaveCell(target.rowIndex, target.colName, draft, isNull);
              onClose();
            }}
          >
            Apply to Cell
          </button>
        </footer>
      )}
    </aside>
  );
}

/* ============================================================================
 * 4. SQL Preview / Diff Drawer
 * ============================================================================ */

export function SqlPreviewDrawer({
  target,
  t,
  onCopy,
  onClose,
}: {
  target: SqlPreviewTarget;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onCopy: (text: string, label: string) => void;
  onClose: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lang = target.dialect === 'postgres' ? 'pgsql' : target.dialect === 'mysql' ? 'mysql' : 'sql';

  return (
    <aside className="dbx-drawer dbx-drawer-wide" role="dialog" aria-label={target.title}>
      <header className="dbx-drawer-header">
        <div className="dbx-drawer-title-group">
          <Icon name="file-code" />
          <div>
            <h2>{target.title}</h2>
            {target.subtitle && <p className="dbx-drawer-subtitle">{target.subtitle}</p>}
          </div>
        </div>
        <button type="button" className="dbx-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="dbx-drawer-body dbx-drawer-editor-body">
        {error && (
          <div className="dbx-banner dbx-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}
        <div className="dbx-editor-host dbx-drawer-monaco">
          <PluginCodeEditor value={target.sql} language={lang} readOnly wordWrap="on" />
        </div>
      </div>

      <footer className="dbx-drawer-footer">
        <button
          type="button"
          className="dbx-btn dbx-btn-secondary"
          onClick={() => onCopy(target.sql, target.title)}
        >
          {t('Copy')} SQL
        </button>
        <div className="dbx-spacer" />
        <button type="button" className="dbx-btn dbx-btn-ghost" onClick={onClose}>
          {t('Close')}
        </button>
        {target.onConfirm && (
          <button
            type="button"
            className="dbx-btn dbx-btn-primary"
            disabled={applying}
            onClick={async () => {
              setApplying(true);
              setError(null);
              try {
                await target.onConfirm!();
                onClose();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setApplying(false);
              }
            }}
          >
            <Icon name={applying ? 'loader' : 'check'} />
            {target.confirmLabel || t('Commit')}
          </button>
        )}
      </footer>
    </aside>
  );
}

/* ============================================================================
 * 5. Import Wizard Drawer (CSV / JSON / SQL / XLSX)
 * ============================================================================ */

export function ImportWizardDrawer({
  context,
  target,
  session,
  t,
  onImported,
  onClose,
}: {
  context: PluginContext;
  target: ImportWizardTarget;
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onImported: () => void;
  onClose: () => void;
}) {
  const [fileName, setFileName] = useState('');
  const [parsedTable, setParsedTable] = useState<ImportedTableData | null>(null);
  const [sqlStatements, setSqlStatements] = useState<string[] | null>(null);
  const [colMapping, setColMapping] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialect = engineToSqlDialect(session.connection.engine);
  const targetCols = useMemo(
    () => (target.structure?.columns ?? []).map((c) => c.name),
    [target.structure],
  );

  const handlePickFile = async () => {
    setError(null);
    try {
      const res = await context.ui.openFile({
        title: t('Import Data'),
        filters: [{ name: 'Data Files', extensions: ['csv', 'json', 'ndjson', 'sql', 'xlsx'] }],
        readAs: 'bytes',
      });
      if (res.cancelled) return;
      const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(0);
      setFileName(res.name);
      const lower = res.name.toLowerCase();
      if (lower.endsWith('.xlsx')) {
        const parsed = await importXlsx(bytes, dialect);
        setParsedTable(parsed);
        setSqlStatements(null);
        setColMapping(autoMapImportColumns(parsed.columns, targetCols));
      } else {
        const text = new TextDecoder('utf-8').decode(bytes);
        if (lower.endsWith('.sql')) {
          const parsed = importSqlScript(text, dialect);
          setSqlStatements(parsed.statements);
          setParsedTable(null);
        } else if (lower.endsWith('.json') || lower.endsWith('.ndjson')) {
          const parsed = importJson(text, dialect);
          setParsedTable(parsed);
          setSqlStatements(null);
          setColMapping(autoMapImportColumns(parsed.columns, targetCols));
        } else {
          const parsed = importCsv(text, { dialect });
          setParsedTable(parsed);
          setSqlStatements(null);
          setColMapping(autoMapImportColumns(parsed.columns, targetCols));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExecuteImport = async () => {
    const driver = session.driver as RelationalDriver;
    setBusy(true);
    setError(null);
    try {
      if (sqlStatements && sqlStatements.length > 0) {
        await driver.applyBatchMutations(sqlStatements);
      } else if (parsedTable && target.structure) {
        const inserts = parsedTable.rows.map((row) => {
          const values: Record<string, CellValue> = {};
          parsedTable.columns.forEach((srcCol, i) => {
            const dst = colMapping[srcCol];
            if (dst) values[dst] = row[i] ?? null;
          });
          return { values };
        });
        const preview = driver.generateBatchMutations(
          target.database,
          target.schema,
          target.table,
          target.structure,
          { inserts },
        );
        await driver.applyBatchMutations(preview.statements);
      }
      onImported();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="dbx-drawer dbx-drawer-wide" role="dialog" aria-label={t('Import Data')}>
      <header className="dbx-drawer-header">
        <div className="dbx-drawer-title-group">
          <Icon name="folder" />
          <div>
            <h2>{t('Import Data')}</h2>
            <p className="dbx-drawer-subtitle dbx-mono">{`Target: ${target.table}`}</p>
          </div>
        </div>
        <button type="button" className="dbx-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="dbx-drawer-body dbx-form-body">
        <div className="dbx-file-row">
          <span className="dbx-mono dbx-truncate">{fileName || 'Choose CSV, JSON, SQL, or XLSX file'}</span>
          <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={() => void handlePickFile()}>
            <Icon name="folder" />
            Choose File...
          </button>
        </div>

        {error && (
          <div className="dbx-banner dbx-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}

        {sqlStatements && (
          <div className="dbx-section-box">
            <strong>{`${sqlStatements.length} SQL statements ready to execute`}</strong>
            <pre className="dbx-history-sql dbx-mono">{sqlStatements.slice(0, 5).join('\n')}</pre>
          </div>
        )}

        {parsedTable && (
          <>
            <div className="dbx-section-box">
              <strong>{`Column Mapping (${parsedTable.rows.length} rows parsed)`}</strong>
              <div className="dbx-mapping-list">
                {parsedTable.columns.map((srcCol) => (
                  <div key={srcCol} className="dbx-mapping-row">
                    <span className="dbx-mono dbx-truncate">{srcCol}</span>
                    <span className="dbx-muted">→</span>
                    <select
                      className="dbx-mono"
                      value={colMapping[srcCol] ?? ''}
                      onChange={(e) =>
                        setColMapping((prev) => ({
                          ...prev,
                          [srcCol]: e.currentTarget.value || null,
                        }))
                      }
                    >
                      <option value="">(Skip column)</option>
                      {targetCols.map((tc) => (
                        <option key={tc} value={tc}>{tc}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <footer className="dbx-drawer-footer">
        <div className="dbx-spacer" />
        <button type="button" className="dbx-btn dbx-btn-ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className="dbx-btn dbx-btn-primary"
          disabled={busy || (!parsedTable && !sqlStatements)}
          onClick={() => void handleExecuteImport()}
        >
          <Icon name={busy ? 'loader' : 'check'} />
          {busy ? 'Importing...' : `Import ${parsedTable ? `${parsedTable.rows.length} Rows` : 'SQL'}`}
        </button>
      </footer>
    </aside>
  );
}

/* ============================================================================
 * 6. Create Table Drawer
 * ============================================================================ */

export function CreateTableDrawer({
  target,
  session,
  t,
  onCreated,
  onClose,
}: {
  target: CreateTableTarget;
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onCreated: (tableName: string) => void;
  onClose: () => void;
}) {
  const driver = session.driver as RelationalDriver;
  const [tableName, setTableName] = useState('new_table');
  const [columns, setColumns] = useState<CreateColumnSpec[]>([
    { name: 'id', dataType: session.family === 'sqlite' ? 'INTEGER' : 'BIGINT', isPrimaryKey: true, isAutoIncrement: true, nullable: false },
    { name: 'name', dataType: session.family === 'sqlite' ? 'TEXT' : 'VARCHAR(255)', nullable: false },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewDdl = useMemo(() => {
    if (!tableName.trim() || columns.length === 0) return '';
    try {
      return driver.generateCreateTableDdl(target.database, target.schema, {
        name: tableName.trim(),
        columns,
        ifNotExists: true,
      });
    } catch {
      return '';
    }
  }, [driver, target, tableName, columns]);

  const handleCreate = async () => {
    if (!previewDdl) return;
    setBusy(true);
    setError(null);
    try {
      await driver.query(previewDdl);
      onCreated(tableName.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="dbx-drawer dbx-drawer-wide" role="dialog" aria-label={t('Create Table')}>
      <header className="dbx-drawer-header">
        <div className="dbx-drawer-title-group">
          <Icon name="table" />
          <div>
            <h2>{t('Create Table')}</h2>
            <p className="dbx-drawer-subtitle dbx-mono">{`${target.database} / ${target.schema}`}</p>
          </div>
        </div>
        <button type="button" className="dbx-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="dbx-drawer-body dbx-form-body">
        <label className="dbx-field">
          <span>Table Name</span>
          <input
            type="text"
            className="dbx-mono"
            value={tableName}
            onChange={(e) => setTableName(e.currentTarget.value)}
          />
        </label>

        <div className="dbx-section-box">
          <div className="dbx-inline-row">
            <strong>{t('Columns')}</strong>
            <div className="dbx-spacer" />
            <button
              type="button"
              className="dbx-btn dbx-btn-secondary dbx-btn-xs"
              onClick={() =>
                setColumns((prev) => [
                  ...prev,
                  { name: `col_${prev.length + 1}`, dataType: 'TEXT', nullable: true },
                ])
              }
            >
              <Icon name="plus" />
              {t('Add Column')}
            </button>
          </div>

          {columns.map((col, idx) => (
            <div key={idx} className="dbx-create-col-row">
              <input
                type="text"
                className="dbx-mono"
                value={col.name}
                onChange={(e) =>
                  setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, name: e.currentTarget.value } : c)))
                }
              />
              <input
                type="text"
                className="dbx-mono"
                value={col.dataType}
                onChange={(e) =>
                  setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, dataType: e.currentTarget.value } : c)))
                }
              />
              <label className="dbx-checkbox-row">
                <input
                  type="checkbox"
                  checked={Boolean(col.isPrimaryKey)}
                  onChange={(e) =>
                    setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, isPrimaryKey: e.currentTarget.checked } : c)))
                  }
                />
                <span>PK</span>
              </label>
              <label className="dbx-checkbox-row">
                <input
                  type="checkbox"
                  checked={col.nullable !== false}
                  onChange={(e) =>
                    setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, nullable: e.currentTarget.checked } : c)))
                  }
                />
                <span>Null</span>
              </label>
              <button
                type="button"
                className="dbx-icon-btn"
                aria-label="Remove column"
                disabled={columns.length <= 1}
                onClick={() => setColumns((prev) => prev.filter((_, i) => i !== idx))}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>

        <div className="dbx-create-preview">
          <PluginCodeEditor
            value={previewDdl}
            language={engineToMonacoLanguage(session.connection.engine)}
            readOnly
            height={160}
          />
        </div>

        {error && (
          <div className="dbx-banner dbx-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <footer className="dbx-drawer-footer">
        <div className="dbx-spacer" />
        <button type="button" className="dbx-btn dbx-btn-ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className="dbx-btn dbx-btn-primary"
          disabled={busy || !previewDdl}
          onClick={() => void handleCreate()}
        >
          <Icon name={busy ? 'loader' : 'check'} />
          {t('Create Table')}
        </button>
      </footer>
    </aside>
  );
}
