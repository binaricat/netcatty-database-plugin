/**
 * Harmonious `AsidePanel`-style docked right drawers (v0.3.0 — never destroying active tabs):
 * - AI SQL Assistant (`context.ai` via `DraftStream`, supports 1-click Fix with AI pre-fill)
 * - Query History & Saved Snippets
 * - Cell & Row Inspector (Monaco JSON/text editor)
 * - SQL Preview / Diff (read-only Monaco + Commit CTA)
 * - Destructive SQL Confirmation Drawer (P0-2)
 * - SQL Parameter Binding Prompt Drawer (P0-6)
 * - Import Data Wizard (CSV / JSON / SQL / XLSX via `ui.openFile` + column mapping)
 * - Create Table Designer (Columns with Default/Unique/AutoInc/Comment + Foreign Keys + CHECK constraints)
 * - Create MongoDB Collection Drawer
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import { PluginCodeEditor } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import { DraftStream, extractSqlDraft } from '../../domain';
import type {
  CellValue,
  CreateColumnSpec,
  MongoDriver,
  RelationalDriver,
  SqlDialect,
} from '../../drivers/types';
import {
  autoMapImportColumns,
  bindSqlParameters,
  importCsv,
  importJson,
  importSqlScript,
  importXlsx,
  type ImportedTableData,
} from '../../sql/index';
import { engineToMonacoLanguage, engineToSqlDialect, schemaCacheKey } from '../sessionManager';
import type {
  ActiveSession,
  AiDrawerOptions,
  ConfirmSqlTarget,
  CreateTableTarget,
  ImportWizardTarget,
  InspectorTarget,
  QueryHistoryEntry,
  SavedSnippet,
  SqlParameterPromptTarget,
  SqlPreviewTarget,
} from '../types';

/* ============================================================================
 * 1. AI SQL Assistant Drawer
 * ============================================================================ */

export function AiAssistantDrawer({
  context,
  session,
  currentSql,
  options,
  t,
  onInsertSql,
  onClose,
}: {
  context: PluginContext;
  session: ActiveSession | undefined;
  currentSql: string;
  options?: AiDrawerOptions;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onInsertSql: (sql: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'generate' | 'explain' | 'optimize' | 'fix'>(
    options?.initialMode ?? 'generate',
  );
  const [prompt, setPrompt] = useState(options?.initialPrompt ?? '');
  const [output, setOutput] = useState('');
  const [modelName, setModelName] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<DraftStream | null>(null);

  useEffect(() => {
    if (options?.initialMode) setMode(options.initialMode);
    if (options?.initialPrompt !== undefined) setPrompt(options.initialPrompt);
  }, [options?.initialMode, options?.initialPrompt]);

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
    <aside className="ndb-drawer ndb-drawer-wide" role="dialog" aria-label={t('AI SQL Assistant')}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="sparkles" />
          <div>
            <h2>{t('AI SQL Assistant')}</h2>
            <p className="ndb-drawer-subtitle">
              {modelName || (session ? `${session.connection.name} · ${session.activeSchema || session.activeDatabase}` : 'Schema-aware SQL drafting')}
            </p>
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body ndb-form-body">
        <div className="ndb-pill-tabs">
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
              className={`ndb-pill-tab ${mode === id ? 'is-active' : ''}`}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ndb-ai-composer">
          <textarea
            className="ndb-ai-textarea"
            rows={4}
            aria-label={mode === 'generate' ? 'Describe the query you need' : 'Additional instructions (optional)'}
            placeholder={
              mode === 'generate'
                ? 'Describe the query you need, e.g. Top 10 customers by total order amount in the last 30 days...'
                : 'Additional instructions (optional), e.g. Focus on index usage or explain error message...'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />
          <div className="ndb-ai-composer-bar">
            {extractedSql && (
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                onClick={() => onInsertSql(extractedSql)}
              >
                <Icon name="arrow-right" />
                {t('Insert into Editor')}
              </button>
            )}
            {running && (
              <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={handleStop}>
                {t('Stop')}
              </button>
            )}
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={running}
              onClick={() => void handleRun()}
            >
              <Icon name={running ? 'loader' : 'sparkles'} />
              {running ? t('Generating...') : t('Run Assistant')}
            </button>
          </div>
        </div>

        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}

        {output && (
          <div className="ndb-ai-output">
            <pre className="ndb-mono">{output}</pre>
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
    <aside className="ndb-drawer ndb-drawer-wide" role="dialog" aria-label={t('Query History & Snippets')}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="book-open" />
          <div>
            <h2>{t('Query History & Snippets')}</h2>
            <p className="ndb-drawer-subtitle">{`${history.length} executed · ${snippets.length} saved`}</p>
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body ndb-form-body">
        <div className="ndb-inline-row">
          <div className="ndb-segmented">
            <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>
              {`${t('History')} (${history.length})`}
            </button>
            <button type="button" className={tab === 'snippets' ? 'is-active' : ''} onClick={() => setTab('snippets')}>
              {`${t('Snippets')} (${snippets.length})`}
            </button>
          </div>
          <div className="ndb-spacer" />
          {tab === 'history' && history.length > 0 && (
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={onClearHistory}>
              {t('Clear')}
            </button>
          )}
        </div>

        <div className="ndb-picker-search">
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
            className="ndb-section-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (!snipTitle.trim() || !snipSql.trim()) return;
              const tags = snipTags.split(',').map((s) => s.trim()).filter(Boolean);
              onSaveSnippet(snipTitle.trim(), snipSql.trim(), tags);
              setSnipTitle('');
              setSnipTags('');
            }}
          >
            <strong>{`Save New Snippet (${currentDialect})`}</strong>
            <div className="ndb-form-grid">
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
              className="ndb-mono"
              placeholder="SELECT ..."
              value={snipSql}
              onChange={(e) => setSnipSql(e.currentTarget.value)}
            />
            <button
              type="submit"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={!snipTitle.trim() || !snipSql.trim()}
            >
              Save Snippet
            </button>
          </form>
        )}

        <div className="ndb-card-list">
          {tab === 'history' ? (
            filteredHistory.length === 0 ? (
              <p className="ndb-tree-empty">{t('No results')}</p>
            ) : (
              filteredHistory.map((item) => (
                <div key={item.id} className="ndb-history-card">
                  <div className="ndb-history-meta">
                    <span className={item.success ? 'ndb-tag ndb-tag-ok' : 'ndb-tag ndb-tag-danger'}>
                      {item.success ? 'OK' : 'ERR'}
                    </span>
                    <span className="ndb-muted">{item.connectionName}</span>
                    <span className="ndb-mono ndb-muted">{`${item.executionMs} ms · ${item.rowCount} rows`}</span>
                    <span className="ndb-spacer" />
                    <span className="ndb-muted">{new Date(item.executedAt).toLocaleTimeString()}</span>
                  </div>
                  <pre className="ndb-history-sql ndb-mono">{item.sql.slice(0, 240)}</pre>
                  <div className="ndb-inline-row">
                    <button
                      type="button"
                      className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                      onClick={() => onInsertSql(item.sql)}
                    >
                      {t('Insert into Editor')}
                    </button>
                    <button
                      type="button"
                      className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                      onClick={() => onOpenNewQuery(item.sql)}
                    >
                      {t('New Query')}
                    </button>
                  </div>
                </div>
              ))
            )
          ) : filteredSnippets.length === 0 ? (
            <p className="ndb-tree-empty">No saved snippets yet.</p>
          ) : (
            filteredSnippets.map((snip) => (
              <div key={snip.id} className="ndb-history-card">
                <div className="ndb-history-meta">
                  <strong>{snip.title}</strong>
                  {snip.tags.map((tag) => (
                    <span key={tag} className="ndb-tag">{tag}</span>
                  ))}
                  <span className="ndb-spacer" />
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                    onClick={() => onDeleteSnippet(snip.id)}
                  >
                    {t('Delete')}
                  </button>
                </div>
                <pre className="ndb-history-sql ndb-mono">{snip.sql.slice(0, 260)}</pre>
                <div className="ndb-inline-row">
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                    onClick={() => onInsertSql(snip.sql)}
                  >
                    {t('Insert into Editor')}
                  </button>
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
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
  const [viewMode, setViewMode] = useState<'cell' | 'hex' | 'row'>('cell');
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
  const isXml = !isJson && draft.trim().startsWith('<') && draft.trim().endsWith('>');

  const hexDump = useMemo(() => {
    const bytes =
      target.value instanceof Uint8Array
        ? target.value
        : new TextEncoder().encode(isNull ? '' : draft);
    if (bytes.length === 0) return '(empty — 0 bytes)';
    const lines: string[] = [];
    const maxBytes = Math.min(bytes.length, 4096);
    for (let off = 0; off < maxBytes; off += 16) {
      const slice = bytes.subarray(off, Math.min(off + 16, maxBytes));
      const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
      const ascii = Array.from(slice, (b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${off.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
    }
    if (bytes.length > maxBytes) lines.push(`... (${bytes.length - maxBytes} more bytes)`);
    return lines.join('\n');
  }, [target.value, draft, isNull]);

  return (
    <aside className="ndb-drawer ndb-drawer-wide" role="dialog" aria-label={t('Cell & Row Inspector')}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="eye" />
          <div>
            <h2>{t('Cell & Row Inspector')}</h2>
            <p className="ndb-drawer-subtitle ndb-mono">{`Row #${target.rowIndex + 1} · ${target.colName}`}</p>
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body ndb-drawer-editor-body">
        <div className="ndb-inline-row">
          <div className="ndb-segmented">
            <button type="button" className={viewMode === 'cell' ? 'is-active' : ''} onClick={() => setViewMode('cell')}>
              Cell Value
            </button>
            <button type="button" className={viewMode === 'hex' ? 'is-active' : ''} onClick={() => setViewMode('hex')}>
              Hex / Binary
            </button>
            <button type="button" className={viewMode === 'row' ? 'is-active' : ''} onClick={() => setViewMode('row')}>
              Full Row JSON
            </button>
          </div>
          <div className="ndb-spacer" />
          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
            onClick={() =>
              onCopy(
                viewMode === 'cell' ? (isNull ? 'NULL' : draft) : viewMode === 'hex' ? hexDump : rowJson,
                target.colName,
              )
            }
          >
            {t('Copy')}
          </button>
        </div>

        <div className="ndb-editor-host ndb-drawer-monaco">
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
          ) : viewMode === 'hex' ? (
            <PluginCodeEditor value={hexDump} language="plaintext" readOnly wordWrap="off" />
          ) : (
            <PluginCodeEditor value={rowJson} language="json" readOnly wordWrap="on" />
          )}
        </div>
      </div>

      {viewMode === 'cell' && target.editable && onSaveCell && (
        <footer className="ndb-drawer-footer">
          <label className="ndb-checkbox-row">
            <input
              type="checkbox"
              checked={isNull}
              onChange={(e) => setIsNull(e.currentTarget.checked)}
            />
            <span>NULL</span>
          </label>
          <div className="ndb-spacer" />
          <button type="button" className="ndb-btn ndb-btn-secondary" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="ndb-btn ndb-btn-primary"
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
    <aside className="ndb-drawer ndb-drawer-wide" role="dialog" aria-label={target.title}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="file-code" />
          <div>
            <h2>{target.title}</h2>
            {target.subtitle && <p className="ndb-drawer-subtitle">{target.subtitle}</p>}
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body ndb-drawer-editor-body">
        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}
        <div className="ndb-editor-host ndb-drawer-monaco">
          <PluginCodeEditor value={target.sql} language={lang} readOnly wordWrap="on" />
        </div>
      </div>

      <footer className="ndb-drawer-footer">
        <button
          type="button"
          className="ndb-btn ndb-btn-secondary"
          onClick={() => onCopy(target.sql, target.title)}
        >
          {`${t('Copy')} SQL`}
        </button>
        <div className="ndb-spacer" />
        <button type="button" className="ndb-btn ndb-btn-ghost" onClick={onClose}>
          {t('Close')}
        </button>
        {target.onConfirm && (
          <button
            type="button"
            className={`ndb-btn ${target.danger ? 'ndb-btn-danger' : 'ndb-btn-primary'}`}
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
 * 5. Destructive SQL Confirmation Drawer (P0-2)
 * ============================================================================ */

export function ConfirmSqlDrawer({
  target,
  t,
  onClose,
}: {
  target: ConfirmSqlTarget;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lang = target.dialect === 'postgres' ? 'pgsql' : target.dialect === 'mysql' ? 'mysql' : 'sql';

  return (
    <aside className="ndb-drawer ndb-drawer-wide" role="dialog" aria-label={t('Destructive SQL Warning')}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="alert-circle" />
          <div>
            <h2>{t('Destructive SQL Warning')}</h2>
            <p className="ndb-drawer-subtitle">{target.title}</p>
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body ndb-drawer-editor-body">
        <div className="ndb-banner ndb-banner-error" role="alert">
          <Icon name="alert-circle" />
          <div>
            <strong>{t('This statement may modify or delete large amounts of data.')}</strong>
            <ul className="ndb-risk-list">
              {target.assessment.destructiveReasons.map((reason, idx) => (
                <li key={idx}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>

        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <span>{error}</span>
          </div>
        )}

        <div className="ndb-editor-host ndb-drawer-monaco">
          <PluginCodeEditor value={target.sql} language={lang} readOnly wordWrap="on" />
        </div>
      </div>

      <footer className="ndb-drawer-footer">
        <div className="ndb-spacer" />
        <button type="button" className="ndb-btn ndb-btn-secondary" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className="ndb-btn ndb-btn-danger"
          disabled={running}
          onClick={async () => {
            setRunning(true);
            setError(null);
            try {
              await target.onConfirm();
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setRunning(false);
            }
          }}
        >
          <Icon name={running ? 'loader' : 'play'} />
          {t('Execute Anyway')}
        </button>
      </footer>
    </aside>
  );
}

/* ============================================================================
 * 6. SQL Parameter Binding Drawer (P0-6)
 * ============================================================================ */

function parseParamValue(raw: string, isNull: boolean): CellValue {
  if (isNull) return null;
  const trimmed = raw.trim();
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) return n;
  }
  return raw;
}

export function SqlParameterDrawer({
  target,
  t,
  onClose,
}: {
  target: SqlParameterPromptTarget;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of target.parameters) {
      init[p.name] = target.initialValues[p.name] ?? '';
    }
    return init;
  });
  const [nullFlags, setNullFlags] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);

  const boundSql = useMemo(() => {
    const typed: Record<string, CellValue> = {};
    for (const p of target.parameters) {
      typed[p.name] = parseParamValue(values[p.name] ?? '', Boolean(nullFlags[p.name]));
    }
    return bindSqlParameters(target.sql, typed, target.dialect);
  }, [target.sql, target.parameters, target.dialect, values, nullFlags]);

  const lang = target.dialect === 'postgres' ? 'pgsql' : target.dialect === 'mysql' ? 'mysql' : 'sql';

  return (
    <aside className="ndb-drawer ndb-drawer-wide" role="dialog" aria-label={t('Bind SQL Parameters')}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="file-code" />
          <div>
            <h2>{t('Bind SQL Parameters')}</h2>
            <p className="ndb-drawer-subtitle">{`${target.parameters.length} parameter(s) detected`}</p>
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body ndb-form-body">
        <div className="ndb-section-box">
          {target.parameters.map((param) => (
            <div key={param.name} className="ndb-param-row">
              <span className="ndb-tag ndb-mono">{param.raw}</span>
              <input
                type="text"
                className="ndb-mono ndb-flex-1"
                disabled={Boolean(nullFlags[param.name])}
                placeholder={nullFlags[param.name] ? 'NULL' : `Value for ${param.name}`}
                value={values[param.name] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [param.name]: e.currentTarget.value }))}
              />
              <label className="ndb-checkbox-row">
                <input
                  type="checkbox"
                  checked={Boolean(nullFlags[param.name])}
                  onChange={(e) => setNullFlags((prev) => ({ ...prev, [param.name]: e.currentTarget.checked }))}
                />
                <span>NULL</span>
              </label>
            </div>
          ))}
        </div>

        <div className="ndb-create-preview">
          <PluginCodeEditor value={boundSql} language={lang} readOnly height={160} wordWrap="on" />
        </div>
      </div>

      <footer className="ndb-drawer-footer">
        <div className="ndb-spacer" />
        <button type="button" className="ndb-btn ndb-btn-ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className="ndb-btn ndb-btn-primary"
          disabled={running}
          onClick={async () => {
            setRunning(true);
            try {
              await target.onExecute(boundSql, values);
              onClose();
            } finally {
              setRunning(false);
            }
          }}
        >
          <Icon name={running ? 'loader' : 'play'} />
          {t('Run with Parameters')}
        </button>
      </footer>
    </aside>
  );
}

/* ============================================================================
 * 7. Import Wizard Drawer (CSV / JSON / SQL / XLSX)
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
    <aside className="ndb-drawer ndb-drawer-wide" role="dialog" aria-label={t('Import Data')}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="folder" />
          <div>
            <h2>{t('Import Data')}</h2>
            <p className="ndb-drawer-subtitle ndb-mono">{`Target: ${target.table}`}</p>
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body ndb-form-body">
        <div className="ndb-file-row">
          <span className="ndb-mono ndb-truncate">{fileName || 'Choose CSV, JSON, SQL, or XLSX file'}</span>
          <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={() => void handlePickFile()}>
            <Icon name="folder" />
            Choose File...
          </button>
        </div>

        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}

        {sqlStatements && (
          <div className="ndb-section-box">
            <strong>{`${sqlStatements.length} SQL statements ready to execute`}</strong>
            <pre className="ndb-history-sql ndb-mono">{sqlStatements.slice(0, 5).join('\n')}</pre>
          </div>
        )}

        {parsedTable && (
          <div className="ndb-section-box">
            <strong>{`Column Mapping (${parsedTable.rows.length} rows parsed)`}</strong>
            <div className="ndb-mapping-list">
              {parsedTable.columns.map((srcCol) => (
                <div key={srcCol} className="ndb-mapping-row">
                  <span className="ndb-mono ndb-truncate">{srcCol}</span>
                  <span className="ndb-muted">→</span>
                  <select
                    className="ndb-mono"
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
        )}
      </div>

      <footer className="ndb-drawer-footer">
        <div className="ndb-spacer" />
        <button type="button" className="ndb-btn ndb-btn-ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className="ndb-btn ndb-btn-primary"
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
 * 8. Create Table Drawer (with Default, Unique, AutoInc, Comment, FKs & CHECKs)
 * ============================================================================ */

interface DraftFk {
  name: string;
  columns: string;
  referencedTable: string;
  referencedColumns: string;
  onDelete: string;
}

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
  const [foreignKeys, setForeignKeys] = useState<DraftFk[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewDdl = useMemo(() => {
    if (!tableName.trim() || columns.length === 0) return '';
    try {
      const validFks = foreignKeys
        .filter((f) => f.columns.trim() && f.referencedTable.trim() && f.referencedColumns.trim())
        .map((f) => ({
          name: f.name.trim() || undefined,
          columns: f.columns.split(',').map((s) => s.trim()).filter(Boolean),
          referencedTable: f.referencedTable.trim(),
          referencedColumns: f.referencedColumns.split(',').map((s) => s.trim()).filter(Boolean),
          onDelete: f.onDelete || undefined,
        }));
      return driver.generateCreateTableDdl(target.database, target.schema, {
        name: tableName.trim(),
        columns,
        foreignKeys: validFks.length > 0 ? validFks : undefined,
        ifNotExists: true,
      });
    } catch {
      return '';
    }
  }, [driver, target, tableName, columns, foreignKeys]);

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
    <aside className="ndb-drawer ndb-drawer-picker" role="dialog" aria-label={t('Create Table')}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="table" />
          <div>
            <h2>{t('Create Table')}</h2>
            <p className="ndb-drawer-subtitle ndb-mono">{`${target.database} / ${target.schema}`}</p>
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body ndb-form-body">
        <label className="ndb-field">
          <span>{t('Table Name')}</span>
          <input
            type="text"
            className="ndb-mono"
            value={tableName}
            onChange={(e) => setTableName(e.currentTarget.value)}
          />
        </label>

        <div className="ndb-section-box">
          <div className="ndb-inline-row">
            <strong>{t('Columns')}</strong>
            <div className="ndb-spacer" />
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-xs"
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
            <div key={idx} className="ndb-create-col-card">
              <div className="ndb-create-col-row">
                <input
                  type="text"
                  className="ndb-mono"
                  placeholder="name"
                  value={col.name}
                  onChange={(e) =>
                    setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, name: e.currentTarget.value } : c)))
                  }
                />
                <input
                  type="text"
                  className="ndb-mono"
                  placeholder="type"
                  value={col.dataType}
                  onChange={(e) =>
                    setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, dataType: e.currentTarget.value } : c)))
                  }
                />
                <input
                  type="text"
                  className="ndb-mono"
                  placeholder={t('Default')}
                  value={col.defaultValue ?? ''}
                  onChange={(e) =>
                    setColumns((prev) =>
                      prev.map((c, i) => (i === idx ? { ...c, defaultValue: e.currentTarget.value || null } : c)),
                    )
                  }
                />
                <button
                  type="button"
                  className="ndb-icon-btn"
                  aria-label="Remove column"
                  disabled={columns.length <= 1}
                  onClick={() => setColumns((prev) => prev.filter((_, i) => i !== idx))}
                >
                  <Icon name="x" />
                </button>
              </div>
              <div className="ndb-create-col-flags">
                <label className="ndb-checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(col.isPrimaryKey)}
                    onChange={(e) =>
                      setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, isPrimaryKey: e.currentTarget.checked } : c)))
                    }
                  />
                  <span>PK</span>
                </label>
                <label className="ndb-checkbox-row">
                  <input
                    type="checkbox"
                    checked={col.nullable !== false}
                    onChange={(e) =>
                      setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, nullable: e.currentTarget.checked } : c)))
                    }
                  />
                  <span>Null</span>
                </label>
                <label className="ndb-checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(col.unique)}
                    onChange={(e) =>
                      setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, unique: e.currentTarget.checked } : c)))
                    }
                  />
                  <span>{t('Unique')}</span>
                </label>
                <label className="ndb-checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(col.isAutoIncrement)}
                    onChange={(e) =>
                      setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, isAutoIncrement: e.currentTarget.checked } : c)))
                    }
                  />
                  <span>{t('Auto Inc')}</span>
                </label>
                <input
                  type="text"
                  className="ndb-input-xs ndb-flex-1"
                  placeholder={t('Comment')}
                  value={col.comment ?? ''}
                  onChange={(e) =>
                    setColumns((prev) =>
                      prev.map((c, i) => (i === idx ? { ...c, comment: e.currentTarget.value || undefined } : c)),
                    )
                  }
                />
              </div>
            </div>
          ))}
        </div>

        {/* Foreign Keys Section */}
        <div className="ndb-section-box">
          <div className="ndb-inline-row">
            <strong>{t('Foreign Keys')}</strong>
            <div className="ndb-spacer" />
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-xs"
              onClick={() =>
                setForeignKeys((prev) => [
                  ...prev,
                  { name: '', columns: '', referencedTable: '', referencedColumns: 'id', onDelete: 'NO ACTION' },
                ])
              }
            >
              <Icon name="plus" />
              {t('Add Foreign Key')}
            </button>
          </div>
          {foreignKeys.map((fk, idx) => (
            <div key={idx} className="ndb-create-col-row">
              <input
                type="text"
                className="ndb-mono"
                placeholder="col (e.g. user_id)"
                value={fk.columns}
                onChange={(e) =>
                  setForeignKeys((prev) => prev.map((f, i) => (i === idx ? { ...f, columns: e.currentTarget.value } : f)))
                }
              />
              <input
                type="text"
                className="ndb-mono"
                placeholder="ref_table"
                value={fk.referencedTable}
                onChange={(e) =>
                  setForeignKeys((prev) => prev.map((f, i) => (i === idx ? { ...f, referencedTable: e.currentTarget.value } : f)))
                }
              />
              <input
                type="text"
                className="ndb-mono"
                placeholder="ref_col"
                value={fk.referencedColumns}
                onChange={(e) =>
                  setForeignKeys((prev) => prev.map((f, i) => (i === idx ? { ...f, referencedColumns: e.currentTarget.value } : f)))
                }
              />
              <button
                type="button"
                className="ndb-icon-btn"
                onClick={() => setForeignKeys((prev) => prev.filter((_, i) => i !== idx))}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>

        <div className="ndb-create-preview">
          <PluginCodeEditor
            value={previewDdl}
            language={engineToMonacoLanguage(session.connection.engine)}
            readOnly
            height={160}
          />
        </div>

        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <footer className="ndb-drawer-footer">
        <div className="ndb-spacer" />
        <button type="button" className="ndb-btn ndb-btn-ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className="ndb-btn ndb-btn-primary"
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

/* ============================================================================
 * 9. Create MongoDB Collection Drawer
 * ============================================================================ */

export function CreateCollectionDrawer({
  database,
  driver,
  t,
  onCreated,
  onClose,
}: {
  database: string;
  driver: MongoDriver;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onCreated: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await driver.createCollection(database, trimmed);
      onCreated(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="ndb-drawer" role="dialog" aria-label={t('Create Collection')}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <Icon name="folder" />
          <div>
            <h2>{t('Create Collection')}</h2>
            <p className="ndb-drawer-subtitle ndb-mono">{database}</p>
          </div>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <form className="ndb-drawer-body ndb-form-body" onSubmit={(e) => void handleSubmit(e)}>
        <label className="ndb-field">
          <span>{t('Collection Name')}</span>
          <input
            type="text"
            className="ndb-mono"
            placeholder="users"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            autoFocus
          />
        </label>
        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <span>{error}</span>
          </div>
        )}
        <div className="ndb-inline-row">
          <div className="ndb-spacer" />
          <button type="button" className="ndb-btn ndb-btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="ndb-btn ndb-btn-primary" disabled={busy || !name.trim()}>
            <Icon name={busy ? 'loader' : 'check'} />
            {t('Create')}
          </button>
        </div>
      </form>
    </aside>
  );
}
