/**
 * Data Dictionary Exporter (Markdown / HTML / DBML) & Model Code Generator (7 Languages) Drawer.
 * Lazy-loaded via React.lazy. No inline SVG/Canvas.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PluginCodeEditor } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { RelationalDriver, TableStructure } from '../../drivers/types';
import {
  MODEL_CODE_FORMATS,
  exportDataDictionaryDbml,
  exportDataDictionaryHtml,
  exportDataDictionaryMarkdown,
  generateModelCode,
  type ModelCodeFormat,
} from '../../sql/dataDictionary';
import { isRelationalDriver, schemaCacheKey } from '../sessionManager';
import type { ActiveSession } from '../types';

export interface DocsAndModelDrawerProps {
  session: ActiveSession;
  initialTab?: 'dictionary' | 'model';
  initialTable?: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onSaveExportFile?: (opts: {
    title: string;
    defaultName: string;
    extension: string;
    filterName: string;
    data: string;
    encoding?: 'utf8' | 'base64';
  }) => Promise<void>;
  onNotify?: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onClose: () => void;
}

export function DocsAndModelDrawer({
  session,
  initialTab = 'dictionary',
  initialTable,
  t,
  onSaveExportFile,
  onNotify,
  onClose,
}: DocsAndModelDrawerProps) {
  const db = session.activeDatabase;
  const schema = session.activeSchema || session.schemas[0]?.name || 'main';
  const cache = session.objectsBySchema[schemaCacheKey(db, schema)];

  const [activeTab, setActiveTab] = useState<'dictionary' | 'model'>(initialTab);
  const [dictFormat, setDictFormat] = useState<'markdown' | 'html' | 'dbml'>('markdown');
  const [modelFormat, setModelFormat] = useState<ModelCodeFormat>('typescript');
  const [selectedTable, setSelectedTable] = useState(initialTable || '');
  const [includeComments, setIncludeComments] = useState(true);
  const [camelCaseFields, setCamelCaseFields] = useState(false);

  const [structures, setStructures] = useState<TableStructure[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSchemaStructures = useCallback(async () => {
    if (!isRelationalDriver(session.driver)) return;
    setLoading(true);
    setError(null);
    const drv = session.driver as RelationalDriver;
    try {
      const tableList = cache?.tables.length ? cache.tables : await drv.listTables(db, schema);
      const cachedMap = cache?.structures ?? {};
      const loaded: TableStructure[] = [];
      for (const tb of tableList.slice(0, 60)) {
        const existing = cachedMap[tb.name];
        if (existing) {
          loaded.push(existing);
        } else {
          try {
            const st = await drv.getTableStructure(db, schema, tb.name);
            loaded.push(st);
          } catch {
            // Skip unreadable table
          }
        }
      }
      setStructures(loaded);
      setSelectedTable((cur) => {
        if (cur && loaded.some((s) => s.table === cur)) return cur;
        if (initialTable && loaded.some((s) => s.table === initialTable)) return initialTable;
        return loaded[0]?.table ?? '';
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cache, db, initialTable, schema, session.driver]);

  useEffect(() => {
    void loadSchemaStructures();
  }, [loadSchemaStructures]);

  const dictionaryOutput = useMemo(() => {
    if (structures.length === 0) return '';
    const input = {
      projectName: session.connection.name || db || 'database',
      engine: session.connection.engine,
      database: db || 'main',
      schema,
      tables: structures,
      views: cache?.views ?? [],
      routines: cache?.routines ?? [],
    };
    if (dictFormat === 'html') return exportDataDictionaryHtml(input);
    if (dictFormat === 'dbml') return exportDataDictionaryDbml(input);
    return exportDataDictionaryMarkdown(input);
  }, [cache?.routines, cache?.views, db, dictFormat, schema, session.connection.engine, session.connection.name, structures]);

  const selectedStruct = useMemo(
    () => structures.find((s) => s.table === selectedTable) ?? structures[0] ?? null,
    [selectedTable, structures],
  );

  const generatedModel = useMemo(() => {
    if (!selectedStruct) return null;
    return generateModelCode(selectedStruct, modelFormat, {
      includeComments,
      camelCaseFields,
    });
  }, [camelCaseFields, includeComments, modelFormat, selectedStruct]);

  const activeCode = activeTab === 'dictionary' ? dictionaryOutput : generatedModel?.code ?? '';

  const handleCopy = async () => {
    if (!activeCode) return;
    try {
      await navigator.clipboard.writeText(activeCode);
      onNotify?.('success', t('Copied to clipboard.'));
    } catch {
      onNotify?.('warning', t('Clipboard write unavailable in this context.'));
    }
  };

  const handleDownload = async () => {
    if (!activeCode || !onSaveExportFile) return;
    if (activeTab === 'dictionary') {
      const ext = dictFormat === 'markdown' ? 'md' : dictFormat;
      const slug = (db || schema || 'schema').replace(/[^a-zA-Z0-9_-]+/g, '_');
      await onSaveExportFile({
        title: t('Export Data Dictionary'),
        defaultName: `${slug}_dictionary.${ext}`,
        extension: ext,
        filterName: `${dictFormat.toUpperCase()} File`,
        data: activeCode,
        encoding: 'utf8',
      });
    } else if (generatedModel) {
      await onSaveExportFile({
        title: t('Save Model Code'),
        defaultName: generatedModel.fileName,
        extension: generatedModel.extension,
        filterName: `${generatedModel.extension.toUpperCase()} File`,
        data: activeCode,
        encoding: 'utf8',
      });
    }
  };

  return (
    <aside className="ndb-drawer ndb-drawer-picker" style={{ width: 580 }}>
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          <h2>{t('Data Dictionary & Model Generator')}</h2>
          <span className="ndb-drawer-subtitle ndb-mono">{`${db}${schema ? `.${schema}` : ''} · ${structures.length} tables`}</span>
        </div>
        <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="ndb-drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Mode Switcher */}
        <div className="ndb-inline-row" style={{ gap: 8 }}>
          <div className="ndb-segmented">
            <button type="button" className={activeTab === 'dictionary' ? 'is-active' : ''} onClick={() => setActiveTab('dictionary')}>
              {t('Data Dictionary')}
            </button>
            <button type="button" className={activeTab === 'model' ? 'is-active' : ''} onClick={() => setActiveTab('model')}>
              {t('Model Code (7 Langs)')}
            </button>
          </div>
          <div className="ndb-spacer" />
          <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" disabled={loading} onClick={() => void loadSchemaStructures()}>
            <Icon name={loading ? 'loader' : 'refresh'} />
            {t('Reload')}
          </button>
        </div>

        {error && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
          </div>
        )}

        {/* Controls per Tab */}
        {activeTab === 'dictionary' ? (
          <div className="ndb-inline-row" style={{ gap: 8 }}>
            <span className="ndb-field-label">{t('Format')}</span>
            <div className="ndb-segmented">
              <button type="button" className={dictFormat === 'markdown' ? 'is-active' : ''} onClick={() => setDictFormat('markdown')}>Markdown</button>
              <button type="button" className={dictFormat === 'html' ? 'is-active' : ''} onClick={() => setDictFormat('html')}>HTML</button>
              <button type="button" className={dictFormat === 'dbml' ? 'is-active' : ''} onClick={() => setDictFormat('dbml')}>DBML</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="ndb-field-label">{t('Table')}</span>
                <select
                  className="ndb-select-sm ndb-mono"
                  value={selectedTable}
                  onChange={(e) => setSelectedTable(e.currentTarget.value)}
                >
                  {structures.map((st) => (
                    <option key={st.table} value={st.table}>{st.table}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="ndb-field-label">{t('Target Language')}</span>
                <select
                  className="ndb-select-sm"
                  value={modelFormat}
                  onChange={(e) => setModelFormat(e.currentTarget.value as ModelCodeFormat)}
                >
                  {MODEL_CODE_FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ndb-inline-row" style={{ gap: 14 }}>
              <label className="ndb-checkbox-row">
                <input type="checkbox" checked={includeComments} onChange={(e) => setIncludeComments(e.currentTarget.checked)} />
                <span>{t('Include comments')}</span>
              </label>
              <label className="ndb-checkbox-row">
                <input type="checkbox" checked={camelCaseFields} onChange={(e) => setCamelCaseFields(e.currentTarget.checked)} />
                <span>{t('camelCase fields')}</span>
              </label>
            </div>
          </div>
        )}

        {/* Code Preview */}
        <div style={{ flex: 1, minHeight: 320, border: '1px solid var(--plugin-hairline)', borderRadius: 'var(--plugin-radius-sm)', overflow: 'hidden' }}>
          <PluginCodeEditor
            value={loading ? '// Loading schema metadata...' : activeCode || '// No tables available in this schema.'}
            language="plaintext"
            readOnly
            wordWrap="on"
            height="100%"
          />
        </div>
      </div>

      <footer className="ndb-drawer-footer">
        <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" disabled={!activeCode} onClick={() => void handleCopy()}>
          <Icon name="file-code" />
          {t('Copy')}
        </button>
        <div className="ndb-spacer" />
        {onSaveExportFile && (
          <button type="button" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={!activeCode} onClick={() => void handleDownload()}>
            <Icon name="book-open" />
            {activeTab === 'dictionary'
              ? `${t('Export')} .${dictFormat === 'markdown' ? 'md' : dictFormat}`
              : `${t('Save')} ${generatedModel?.fileName || ''}`}
          </button>
        )}
      </footer>
    </aside>
  );
}

export default DocsAndModelDrawer;
