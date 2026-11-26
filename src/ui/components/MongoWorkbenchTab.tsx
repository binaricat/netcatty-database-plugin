/**
 * MongoDB Specialist Workbench Tab:
 * - Find / Aggregate mode switch with JSON Filter / Sort / Projection / Limit or Pipeline
 * - Table (`PluginDataGrid`) / Tree (expandable key/value hierarchy) / JSON (`PluginCodeEditor`) views
 * - Insert / Edit / Replace / Delete documents
 * - Indexes sub-tab (list, create, drop indexes) + Collection Stats pill
 */

import React, { useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  PluginDataGrid,
  type PluginDataGridColumn,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { MongoDocument, MongoDriver } from '../../drivers/types';
import { formatBytes } from '../i18n';
import type { MongoWorkbenchTabState } from '../types';

export interface MongoWorkbenchTabProps {
  tab: MongoWorkbenchTabState;
  driver: MongoDriver;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<MongoWorkbenchTabState>) => void;
  onRun: () => Promise<void>;
  onReloadIndexes: () => Promise<void>;
  onNotify: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

function TreeValueNode({ name, value, depth = 0 }: { name: string; value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object';
  const isArr = Array.isArray(value);

  if (!isObj) {
    const cls =
      value === null
        ? 'dbx-json-null'
        : typeof value === 'number'
          ? 'dbx-json-num'
          : typeof value === 'boolean'
            ? 'dbx-json-bool'
            : 'dbx-json-str';
    return (
      <div className="dbx-tree-kv" style={{ paddingLeft: `${depth * 16}px` }}>
        <span className="dbx-json-key dbx-mono">{name}:</span>
        <span className={`${cls} dbx-mono`}>
          {value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value)}
        </span>
      </div>
    );
  }

  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);

  return (
    <div>
      <button
        type="button"
        className="dbx-tree-kv-btn"
        style={{ paddingLeft: `${depth * 16}px` }}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className="dbx-json-key dbx-mono">{name}</span>
        <span className="dbx-muted dbx-mono">
          {isArr ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </button>
      {open &&
        entries.map(([k, v]) => <TreeValueNode key={k} name={k} value={v} depth={depth + 1} />)}
    </div>
  );
}

export function MongoWorkbenchTab({
  tab,
  driver,
  t,
  onUpdateTab,
  onRun,
  onReloadIndexes,
  onNotify,
}: MongoWorkbenchTabProps) {
  const [showInsert, setShowInsert] = useState(false);
  const [insertJson, setInsertJson] = useState('{\n  "name": "example"\n}');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editJson, setEditJson] = useState('');
  const [newIdxKeyJson, setNewIdxKeyJson] = useState('{ "createdAt": -1 }');
  const [newIdxName, setNewIdxName] = useState('');
  const [newIdxUnique, setNewIdxUnique] = useState(false);
  const [busy, setBusy] = useState(false);

  const tableColumns: PluginDataGridColumn[] = useMemo(() => {
    const keys = new Set<string>();
    for (const doc of tab.documents) {
      for (const k of Object.keys(doc)) keys.add(k);
    }
    return Array.from(keys).map((name) => ({
      name,
      primaryKey: name === '_id',
      sortable: false,
    }));
  }, [tab.documents]);

  const jsonAllText = useMemo(
    () => JSON.stringify(tab.documents, null, 2),
    [tab.documents],
  );

  const handleInsertDoc = async () => {
    setBusy(true);
    try {
      const parsed = JSON.parse(insertJson) as MongoDocument;
      await driver.insertOne(tab.database, tab.collection, parsed);
      setShowInsert(false);
      onNotify('success', 'Inserted document');
      await onRun();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEditDoc = async (origDoc: MongoDocument) => {
    setBusy(true);
    try {
      const parsed = JSON.parse(editJson) as MongoDocument;
      await driver.replaceOne(tab.database, tab.collection, { _id: origDoc._id }, parsed);
      setEditingIndex(null);
      onNotify('success', 'Updated document');
      await onRun();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteDoc = async (doc: MongoDocument) => {
    setBusy(true);
    try {
      await driver.deleteOne(tab.database, tab.collection, { _id: doc._id });
      onNotify('success', 'Deleted document');
      await onRun();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateIndex = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const key = JSON.parse(newIdxKeyJson) as Record<string, number | string>;
      await driver.createIndexes(tab.database, tab.collection, [
        {
          key,
          name: newIdxName.trim() || undefined,
          unique: newIdxUnique,
        },
      ]);
      setNewIdxName('');
      onNotify('success', 'Created index');
      await onReloadIndexes();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dbx-tab-pane">
      {/* Top Bar */}
      <div className="dbx-toolbar dbx-toolbar-wrap">
        <div className="dbx-toolbar-group">
          <span className="dbx-context-chip dbx-mono">{`${tab.database}.${tab.collection}`}</span>
          <div className="dbx-segmented">
            <button
              type="button"
              className={tab.activeSubTab === 'documents' ? 'is-active' : ''}
              onClick={() => onUpdateTab({ activeSubTab: 'documents' })}
            >
              {t('Documents')}
            </button>
            <button
              type="button"
              className={tab.activeSubTab === 'indexes' ? 'is-active' : ''}
              onClick={() => {
                onUpdateTab({ activeSubTab: 'indexes' });
                void onReloadIndexes();
              }}
            >
              {`${t('Indexes')} (${tab.indexes.length})`}
            </button>
          </div>

          {tab.activeSubTab === 'documents' && (
            <>
              <div className="dbx-segmented">
                <button
                  type="button"
                  className={tab.mode === 'find' ? 'is-active' : ''}
                  onClick={() => onUpdateTab({ mode: 'find' })}
                >
                  {t('Find')}
                </button>
                <button
                  type="button"
                  className={tab.mode === 'aggregate' ? 'is-active' : ''}
                  onClick={() => onUpdateTab({ mode: 'aggregate' })}
                >
                  {t('Aggregate')}
                </button>
              </div>

              <div className="dbx-segmented">
                <button
                  type="button"
                  className={tab.viewMode === 'table' ? 'is-active' : ''}
                  onClick={() => onUpdateTab({ viewMode: 'table' })}
                >
                  {t('Table')}
                </button>
                <button
                  type="button"
                  className={tab.viewMode === 'tree' ? 'is-active' : ''}
                  onClick={() => onUpdateTab({ viewMode: 'tree' })}
                >
                  {t('Tree')}
                </button>
                <button
                  type="button"
                  className={tab.viewMode === 'json' ? 'is-active' : ''}
                  onClick={() => onUpdateTab({ viewMode: 'json' })}
                >
                  {t('JSON')}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="dbx-spacer" />

        <div className="dbx-toolbar-group">
          {tab.stats && (
            <span className="dbx-tag dbx-mono">
              {`${tab.stats.count} docs · ${formatBytes(tab.stats.size)}`}
            </span>
          )}
          <button
            type="button"
            className="dbx-btn dbx-btn-secondary dbx-btn-sm"
            onClick={() => setShowInsert((v) => !v)}
          >
            <Icon name="plus" />
            {t('Insert Doc')}
          </button>
          <button
            type="button"
            className="dbx-btn dbx-btn-primary dbx-btn-sm"
            disabled={tab.loading}
            onClick={() => void onRun()}
          >
            <Icon name={tab.loading ? 'loader' : 'play'} />
            {t('Run')}
          </button>
        </div>
      </div>

      {/* Query Inputs Bar */}
      {tab.activeSubTab === 'documents' && (
        <div className="dbx-mongo-query-bar">
          {tab.mode === 'find' ? (
            <>
              <label className="dbx-mongo-input-label">
                <span>Filter</span>
                <input
                  type="text"
                  className="dbx-mono"
                  value={tab.filterJson}
                  onChange={(e) => onUpdateTab({ filterJson: e.currentTarget.value })}
                />
              </label>
              <label className="dbx-mongo-input-label">
                <span>Sort</span>
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder='{ "_id": -1 }'
                  value={tab.sortJson}
                  onChange={(e) => onUpdateTab({ sortJson: e.currentTarget.value })}
                />
              </label>
              <label className="dbx-mongo-input-label">
                <span>Projection</span>
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder="{}"
                  value={tab.projectionJson}
                  onChange={(e) => onUpdateTab({ projectionJson: e.currentTarget.value })}
                />
              </label>
              <label className="dbx-mongo-input-label dbx-mongo-limit">
                <span>Limit</span>
                <input
                  type="number"
                  className="dbx-mono"
                  min={1}
                  max={500}
                  value={tab.limit}
                  onChange={(e) => onUpdateTab({ limit: Math.max(1, Number(e.currentTarget.value) || 50) })}
                />
              </label>
            </>
          ) : (
            <label className="dbx-mongo-input-label dbx-flex-1">
              <span>Pipeline JSON Array</span>
              <input
                type="text"
                className="dbx-mono"
                value={tab.pipelineJson}
                onChange={(e) => onUpdateTab({ pipelineJson: e.currentTarget.value })}
              />
            </label>
          )}
        </div>
      )}

      {/* Insert Document Inline Drawer */}
      {showInsert && (
        <div className="dbx-mongo-inline-editor">
          <div className="dbx-mongo-inline-head">
            <strong>{t('Insert Doc')}</strong>
            <div className="dbx-spacer" />
            <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-xs" onClick={() => setShowInsert(false)}>
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="dbx-btn dbx-btn-primary dbx-btn-xs"
              disabled={busy}
              onClick={() => void handleInsertDoc()}
            >
              Insert
            </button>
          </div>
          <div className="dbx-mongo-editor-box">
            <PluginCodeEditor
              value={insertJson}
              language="json"
              height={160}
              onChange={({ value }) => setInsertJson(value)}
            />
          </div>
        </div>
      )}

      {tab.error && (
        <div className="dbx-banner dbx-banner-error dbx-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      {/* Body */}
      <div className="dbx-grid-host">
        {tab.activeSubTab === 'indexes' ? (
          <div className="dbx-structure-scroll">
            <table className="dbx-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key Spec</th>
                  <th>Unique</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {tab.indexes.map((idx) => (
                  <tr key={idx.name}>
                    <td className="dbx-mono"><strong>{idx.name}</strong></td>
                    <td className="dbx-mono">{JSON.stringify(idx.key)}</td>
                    <td>{idx.unique ? 'UNIQUE' : 'No'}</td>
                    <td>
                      {idx.name !== '_id_' && (
                        <button
                          type="button"
                          className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await driver.dropIndexes(tab.database, tab.collection, idx.name);
                              onNotify('success', `Dropped index ${idx.name}`);
                              await onReloadIndexes();
                            } catch (err) {
                              onNotify('error', err instanceof Error ? err.message : String(err));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Drop
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <form className="dbx-add-row-form" onSubmit={(e) => void handleCreateIndex(e)}>
              <strong>{t('Add Index')}</strong>
              <div className="dbx-add-row-inputs">
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder='{ "field": 1 }'
                  value={newIdxKeyJson}
                  onChange={(e) => setNewIdxKeyJson(e.currentTarget.value)}
                />
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder="Index name (optional)"
                  value={newIdxName}
                  onChange={(e) => setNewIdxName(e.currentTarget.value)}
                />
                <label className="dbx-checkbox-row">
                  <input
                    type="checkbox"
                    checked={newIdxUnique}
                    onChange={(e) => setNewIdxUnique(e.currentTarget.checked)}
                  />
                  <span>Unique</span>
                </label>
                <button type="submit" className="dbx-btn dbx-btn-primary dbx-btn-sm" disabled={busy}>
                  Create Index
                </button>
              </div>
            </form>
          </div>
        ) : tab.viewMode === 'table' ? (
          <PluginDataGrid
            columns={tableColumns}
            rows={tab.documents}
            loading={tab.loading}
            emptyMessage="No documents matched"
            onCellSelect={({ rowIndex }) => onUpdateTab({ selectedDocIndex: rowIndex })}
          />
        ) : tab.viewMode === 'json' ? (
          <div className="dbx-editor-host">
            <PluginCodeEditor value={jsonAllText} language="json" readOnly wordWrap="on" />
          </div>
        ) : (
          <div className="dbx-structure-scroll dbx-mongo-tree-list">
            {tab.documents.map((doc, idx) => {
              const isEditing = editingIndex === idx;
              return (
                <div key={String(doc._id ?? idx)} className="dbx-mongo-doc-card">
                  <div className="dbx-mongo-doc-head">
                    <span className="dbx-mono dbx-muted">{`#${idx + 1} · _id: ${JSON.stringify(doc._id)}`}</span>
                    <div className="dbx-spacer" />
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          className="dbx-btn dbx-btn-primary dbx-btn-xs"
                          disabled={busy}
                          onClick={() => void handleSaveEditDoc(doc)}
                        >
                          {t('Save')}
                        </button>
                        <button
                          type="button"
                          className="dbx-btn dbx-btn-ghost dbx-btn-xs"
                          onClick={() => setEditingIndex(null)}
                        >
                          {t('Cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="dbx-btn dbx-btn-ghost dbx-btn-xs"
                          onClick={() => {
                            setEditingIndex(idx);
                            setEditJson(JSON.stringify(doc, null, 2));
                          }}
                        >
                          {t('Edit')}
                        </button>
                        <button
                          type="button"
                          className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
                          disabled={busy}
                          onClick={() => void handleDeleteDoc(doc)}
                        >
                          {t('Delete')}
                        </button>
                      </>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="dbx-mongo-editor-box">
                      <PluginCodeEditor
                        value={editJson}
                        language="json"
                        height={180}
                        onChange={({ value }) => setEditJson(value)}
                      />
                    </div>
                  ) : (
                    <div className="dbx-mongo-doc-tree">
                      {Object.entries(doc).map(([k, v]) => (
                        <TreeValueNode key={k} name={k} value={v} depth={0} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {tab.documents.length === 0 && (
              <div className="dbx-empty-center">
                <p>No documents matched</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Strip */}
      <div className="dbx-result-strip dbx-mono">
        <span>{`${tab.documents.length} of ${tab.totalCount} documents`}</span>
        <span>{`${tab.executionMs} ms`}</span>
        <span className="dbx-spacer" />
        <span className="dbx-muted">{`MongoDB ${driver.serverVersion}`}</span>
      </div>
    </div>
  );
}
