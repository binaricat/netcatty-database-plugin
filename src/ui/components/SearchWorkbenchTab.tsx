/**
 * Search, Document & Vector HTTP Specialist Workbench Tab:
 * Supports Elasticsearch, Easysearch, Meilisearch, CouchDB, Qdrant, ChromaDB, Weaviate,
 * Apache Solr, Milvus REST v2, Amazon DynamoDB (AWS SigV4), and Apache HBase REST.
 * - ES/OS depth: Settings, Stats, Aliases (view/add/remove), Cluster Health & Nodes,
 *   Truncate / _delete_by_query, _profile query breakdown
 * - Meilisearch depth: dedicated Tasks, API Keys, and Index Settings sub-tabs
 * - Strictly borderless Monitor-style, zero inline svg/canvas, zero node:* imports
 */

import React, { useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  PluginDataGrid,
  type PluginDataGridColumn,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { SearchDriver, SearchQueryResult } from '../../drivers/types';
import type { SearchWorkbenchTabState } from '../types';

export interface SearchWorkbenchTabProps {
  tab: SearchWorkbenchTabState;
  driver: SearchDriver;
  readOnly?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<SearchWorkbenchTabState>) => void;
  onRunSearch: (opts?: { from?: number }) => Promise<void>;
  onLoadMapping: () => Promise<void>;
  onNotify: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

type ExtendedSearchDriver = SearchDriver & {
  getClusterNodes?: () => Promise<Array<Record<string, unknown>>>;
  getIndexSettings?: (index: string) => Promise<Record<string, unknown>>;
  updateIndexSettings?: (index: string, settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateIndexAliases?: (actions: Array<Record<string, unknown>>) => Promise<Record<string, unknown>>;
  profileSearch?: (
    index: string,
    query: string | Record<string, unknown>,
    options?: { from?: number; size?: number },
  ) => Promise<SearchQueryResult & { profile?: unknown }>;
  listMeiliTasks?: (limit?: number) => Promise<Array<Record<string, unknown>>>;
  listMeiliKeys?: (limit?: number) => Promise<Array<Record<string, unknown>>>;
  renameIndex?: (index: string, newName: string) => Promise<void>;
};

type ExtraSearchSubTab = 'settings' | 'stats' | 'aliases' | 'cluster' | 'tasks' | 'keys';

function queryPlaceholderForEngine(engine: string): string {
  switch (engine) {
    case 'solr':
      return 'Solr query (e.g. *:* or title:search) or JSON request';
    case 'milvus':
      return 'Milvus filter (e.g. id > 0) or {"vector":[0.1,0.2,...]}';
    case 'dynamodb':
      return 'DynamoDB JSON: {} (Scan), {"Key":{"id":"1"}} (GetItem), or {"KeyConditionExpression":...}';
    case 'hbase':
      return 'HBase scan JSON (e.g. {}) or row:<rowKey>';
    case 'meilisearch':
      return 'Meilisearch search text or JSON options';
    default:
      return 'JSON query DSL (e.g. {"match_all":{}}) or search text';
  }
}

export function SearchWorkbenchTab({
  tab,
  driver,
  readOnly = false,
  t,
  onUpdateTab,
  onRunSearch,
  onLoadMapping,
  onNotify,
  onShortcut,
}: SearchWorkbenchTabProps) {
  const extDriver = driver as ExtendedSearchDriver;
  const isEsLike = driver.engine === 'elasticsearch' || driver.engine === 'easysearch';
  const isMeili = driver.engine === 'meilisearch';

  const [extraSubTab, setExtraSubTab] = useState<ExtraSearchSubTab | null>(null);
  const [showInsert, setShowInsert] = useState(false);
  const [insertId, setInsertId] = useState('');
  const [insertJson, setInsertJson] = useState('{\n  "title": "Sample document"\n}');
  const [busy, setBusy] = useState(false);

  // ES/OS _profile & _delete_by_query / Truncate
  const [profileOutput, setProfileOutput] = useState<unknown | null>(null);
  const [showDeleteByQuery, setShowDeleteByQuery] = useState(false);
  const [deleteQueryJson, setDeleteQueryJson] = useState('{\n  "match_all": {}\n}');
  const [confirmDeleteByQuery, setConfirmDeleteByQuery] = useState(false);

  // Settings / Stats / Aliases / Cluster
  const [settingsJson, setSettingsJson] = useState('');
  const [statsData, setStatsData] = useState<Record<string, unknown> | null>(null);
  const [aliasesData, setAliasesData] = useState<Record<string, unknown> | null>(null);
  const [newAliasName, setNewAliasName] = useState('');
  const [clusterHealth, setClusterHealth] = useState<Record<string, unknown> | null>(null);
  const [clusterNodes, setClusterNodes] = useState<Array<Record<string, unknown>>>([]);

  // Meilisearch Tasks & Keys
  const [meiliTasks, setMeiliTasks] = useState<Array<Record<string, unknown>>>([]);
  const [meiliKeys, setMeiliKeys] = useState<Array<Record<string, unknown>>>([]);

  // Milvus rename collection
  const [milvusRenameTo, setMilvusRenameTo] = useState('');

  // REST console
  const [rawMethod, setRawMethod] = useState<'GET' | 'POST' | 'PUT' | 'DELETE'>('GET');
  const [rawPath, setRawPath] = useState(isEsLike ? '/_cluster/health' : '/');
  const [rawBody, setRawBody] = useState('');
  const [rawResult, setRawResult] = useState<{ status: number; body: string } | null>(null);

  const activeSubTab: 'documents' | 'mapping' | 'raw' | ExtraSearchSubTab =
    extraSubTab ?? tab.activeSubTab;

  const { columns, rows } = useMemo(() => {
    const keySet = new Set<string>(['_id']);
    if (tab.documents.some((d) => d.score !== undefined)) keySet.add('_score');
    for (const doc of tab.documents) {
      for (const k of Object.keys(doc.source)) {
        keySet.add(k);
        if (keySet.size >= 24) break;
      }
    }
    const cols: PluginDataGridColumn[] = Array.from(keySet).map((name) => ({
      name,
      type: name === '_id' ? 'id' : name === '_score' ? 'number' : 'json',
    }));
    const rowData = tab.documents.map((doc) =>
      cols.map((col) => {
        if (col.name === '_id') return doc.id;
        if (col.name === '_score') return doc.score ?? null;
        const v = doc.source[col.name];
        if (v === undefined) return null;
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
      }),
    );
    return { columns: cols, rows: rowData };
  }, [tab.documents]);

  const aliasNames = useMemo(() => {
    if (!aliasesData) return [] as string[];
    const entry = aliasesData[tab.index] as { aliases?: Record<string, unknown> } | undefined;
    if (entry?.aliases && typeof entry.aliases === 'object') {
      return Object.keys(entry.aliases);
    }
    const out: string[] = [];
    for (const val of Object.values(aliasesData)) {
      if (val && typeof val === 'object' && 'aliases' in val) {
        const a = (val as { aliases?: Record<string, unknown> }).aliases;
        if (a) out.push(...Object.keys(a));
      }
    }
    return Array.from(new Set(out));
  }, [aliasesData, tab.index]);

  const loadSettings = async () => {
    if (!extDriver.getIndexSettings) return;
    setBusy(true);
    try {
      const data = await extDriver.getIndexSettings(tab.index);
      setSettingsJson(JSON.stringify(data, null, 2));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSettings = async () => {
    if (readOnly || !extDriver.updateIndexSettings) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
      await extDriver.updateIndexSettings(tab.index, parsed);
      onNotify('success', 'Updated index settings');
      await loadSettings();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadStats = async () => {
    if (!driver.getIndexStats) return;
    setBusy(true);
    try {
      setStatsData(await driver.getIndexStats(tab.index));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadAliases = async () => {
    if (!driver.getIndexAliases) return;
    setBusy(true);
    try {
      setAliasesData(await driver.getIndexAliases(tab.index));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadCluster = async () => {
    setBusy(true);
    try {
      const [health, nodes] = await Promise.all([
        driver.getClusterHealth ? driver.getClusterHealth() : Promise.resolve(null),
        extDriver.getClusterNodes ? extDriver.getClusterNodes() : Promise.resolve([]),
      ]);
      setClusterHealth(health);
      setClusterNodes(nodes);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadMeiliTasks = async () => {
    if (!extDriver.listMeiliTasks) return;
    setBusy(true);
    try {
      setMeiliTasks(await extDriver.listMeiliTasks(50));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadMeiliKeys = async () => {
    if (!extDriver.listMeiliKeys) return;
    setBusy(true);
    try {
      setMeiliKeys(await extDriver.listMeiliKeys(50));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleProfileSearch = async () => {
    if (!extDriver.profileSearch) return;
    setBusy(true);
    try {
      const res = await extDriver.profileSearch(tab.index, tab.queryText, {
        from: tab.from,
        size: tab.size,
      });
      setProfileOutput(res.profile ?? res.raw ?? {});
      onNotify('info', `Profiled query in ${res.executionMs} ms`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteByQuery = async () => {
    if (readOnly || !driver.deleteByQuery) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(deleteQueryJson) as Record<string, unknown>;
      const res = await driver.deleteByQuery(tab.index, parsed);
      onNotify('success', `Deleted ${res.deleted} document(s)`);
      setConfirmDeleteByQuery(false);
      setShowDeleteByQuery(false);
      await onRunSearch({ from: 0 });
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAddAlias = async () => {
    if (readOnly || !extDriver.updateIndexAliases || !newAliasName.trim()) return;
    setBusy(true);
    try {
      await extDriver.updateIndexAliases([{ add: { index: tab.index, alias: newAliasName.trim() } }]);
      setNewAliasName('');
      onNotify('success', 'Added alias');
      await loadAliases();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveAlias = async (alias: string) => {
    if (readOnly || !extDriver.updateIndexAliases) return;
    setBusy(true);
    try {
      await extDriver.updateIndexAliases([{ remove: { index: tab.index, alias } }]);
      onNotify('success', `Removed alias ${alias}`);
      await loadAliases();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInsert = async () => {
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    setBusy(true);
    try {
      const parsed = JSON.parse(insertJson) as Record<string, unknown>;
      const res = await driver.upsertDocument(tab.index, parsed, insertId.trim() || undefined);
      onNotify('success', `Saved document ${res.id}`);
      setShowInsert(false);
      setInsertId('');
      await onRunSearch();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteDoc = async (id: string) => {
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    setBusy(true);
    try {
      await driver.deleteDocument(tab.index, id);
      onNotify('success', `Deleted document ${id}`);
      await onRunSearch();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRawRequest = async () => {
    if (!driver.rawRequest) return;
    if (readOnly && rawMethod !== 'GET') {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    setBusy(true);
    try {
      const res = await driver.rawRequest(rawMethod, rawPath, rawBody.trim() ? rawBody : undefined);
      setRawResult(res);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ndb-tab-pane">
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <div className="ndb-toolbar-group">
          <span className="ndb-context-chip ndb-mono">{`${driver.engine} / ${tab.index}`}</span>
          <div className="ndb-segmented">
            <button
              type="button"
              className={`ndb-seg-btn${activeSubTab === 'documents' ? ' active is-active' : ''}`}
              onClick={() => {
                setExtraSubTab(null);
                onUpdateTab({ activeSubTab: 'documents' });
              }}
            >
              {t('Documents')}
            </button>
            <button
              type="button"
              className={`ndb-seg-btn${activeSubTab === 'mapping' ? ' active is-active' : ''}`}
              onClick={() => {
                setExtraSubTab(null);
                onUpdateTab({ activeSubTab: 'mapping' });
                if (!tab.mapping) void onLoadMapping();
              }}
            >
              {t('Mapping / Schema')}
            </button>
            {(isEsLike || isMeili) && extDriver.getIndexSettings && (
              <button
                type="button"
                className={`ndb-seg-btn${activeSubTab === 'settings' ? ' active is-active' : ''}`}
                onClick={() => {
                  setExtraSubTab('settings');
                  void loadSettings();
                }}
              >
                {'Settings'}
              </button>
            )}
            {isEsLike && driver.getIndexStats && (
              <button
                type="button"
                className={`ndb-seg-btn${activeSubTab === 'stats' ? ' active is-active' : ''}`}
                onClick={() => {
                  setExtraSubTab('stats');
                  void loadStats();
                }}
              >
                {'Stats'}
              </button>
            )}
            {isEsLike && driver.getIndexAliases && (
              <button
                type="button"
                className={`ndb-seg-btn${activeSubTab === 'aliases' ? ' active is-active' : ''}`}
                onClick={() => {
                  setExtraSubTab('aliases');
                  void loadAliases();
                }}
              >
                {'Aliases'}
              </button>
            )}
            {isEsLike && driver.getClusterHealth && (
              <button
                type="button"
                className={`ndb-seg-btn${activeSubTab === 'cluster' ? ' active is-active' : ''}`}
                onClick={() => {
                  setExtraSubTab('cluster');
                  void loadCluster();
                }}
              >
                {'Cluster'}
              </button>
            )}
            {isMeili && extDriver.listMeiliTasks && (
              <button
                type="button"
                className={`ndb-seg-btn${activeSubTab === 'tasks' ? ' active is-active' : ''}`}
                onClick={() => {
                  setExtraSubTab('tasks');
                  void loadMeiliTasks();
                }}
              >
                {'Tasks'}
              </button>
            )}
            {isMeili && extDriver.listMeiliKeys && (
              <button
                type="button"
                className={`ndb-seg-btn${activeSubTab === 'keys' ? ' active is-active' : ''}`}
                onClick={() => {
                  setExtraSubTab('keys');
                  void loadMeiliKeys();
                }}
              >
                {'API Keys'}
              </button>
            )}
            {driver.rawRequest && (
              <button
                type="button"
                className={`ndb-seg-btn${activeSubTab === 'raw' ? ' active is-active' : ''}`}
                onClick={() => {
                  setExtraSubTab(null);
                  onUpdateTab({ activeSubTab: 'raw' });
                }}
              >
                {t('REST Console')}
              </button>
            )}
          </div>
        </div>

        <div className="ndb-spacer" />

        {activeSubTab === 'documents' && (
          <div className="ndb-toolbar-group">
            <div className="ndb-segmented">
              <button
                type="button"
                className={`ndb-seg-btn${tab.viewMode === 'table' ? ' active is-active' : ''}`}
                onClick={() => onUpdateTab({ viewMode: 'table' })}
              >
                {t('Table')}
              </button>
              <button
                type="button"
                className={`ndb-seg-btn${tab.viewMode === 'json' ? ' active is-active' : ''}`}
                onClick={() => onUpdateTab({ viewMode: 'json' })}
              >
                {'JSON'}
              </button>
            </div>
            {isEsLike && extDriver.profileSearch && (
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                disabled={busy}
                onClick={() => void handleProfileSearch()}
              >
                {'Profile'}
              </button>
            )}
            {!readOnly && driver.deleteByQuery && (isEsLike || driver.engine === 'solr' || isMeili) && (
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm ndb-text-danger"
                onClick={() => {
                  setShowDeleteByQuery((v) => !v);
                  setConfirmDeleteByQuery(false);
                }}
              >
                {'Truncate / Del Query'}
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                onClick={() => setShowInsert((v) => !v)}
              >
                <Icon name="plus" />
                {t('Insert')}
              </button>
            )}
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={tab.loading}
              onClick={() => void onRunSearch({ from: 0 })}
            >
              <Icon name={tab.loading ? 'loader' : 'play'} />
              {t('Search')}
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

      {activeSubTab === 'documents' && (
        <div className="ndb-search-body">
          <div className="ndb-search-query-bar">
            <input
              type="text"
              className="ndb-input ndb-mono"
              value={tab.queryText}
              placeholder={queryPlaceholderForEngine(driver.engine)}
              onChange={(e) => onUpdateTab({ queryText: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onRunSearch({ from: 0 });
              }}
            />
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              disabled={tab.from <= 0 || tab.loading}
              onClick={() => void onRunSearch({ from: Math.max(0, tab.from - tab.size) })}
            >
              {t('Prev')}
            </button>
            <span className="ndb-muted ndb-mono">
              {`${tab.from + 1}–${Math.min(tab.totalCount, tab.from + tab.documents.length)} / ${tab.totalCount}`}
            </span>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              disabled={tab.from + tab.size >= tab.totalCount || tab.loading}
              onClick={() => void onRunSearch({ from: tab.from + tab.size })}
            >
              {t('Next')}
            </button>
          </div>

          {showDeleteByQuery && !readOnly && (
            <div className="ndb-inline-panel">
              <div className="ndb-toolbar-group">
                <strong className="ndb-text-danger">
                  {isEsLike ? '_delete_by_query / Truncate' : 'Truncate / Delete by Query'}
                </strong>
                <div className="ndb-spacer" />
                {!confirmDeleteByQuery ? (
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-secondary ndb-btn-xs ndb-text-danger"
                    onClick={() => setConfirmDeleteByQuery(true)}
                  >
                    {'Execute Delete'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-danger ndb-btn-xs"
                    disabled={busy}
                    onClick={() => void handleDeleteByQuery()}
                  >
                    {'Confirm Delete Matching Docs'}
                  </button>
                )}
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                  onClick={() => {
                    setShowDeleteByQuery(false);
                    setConfirmDeleteByQuery(false);
                  }}
                >
                  {t('Cancel')}
                </button>
              </div>
              <div className="ndb-inline-editor">
                <PluginCodeEditor
                  value={deleteQueryJson}
                  language="json"
                  lineNumbers="on"
                  minimap={false}
                  height={100}
                  onChange={(d) => setDeleteQueryJson(d.value)}
                />
              </div>
            </div>
          )}

          {profileOutput !== null && (
            <div className="ndb-inline-panel">
              <div className="ndb-toolbar-group">
                <strong>{'Query _profile Breakdown'}</strong>
                <div className="ndb-spacer" />
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                  onClick={() => setProfileOutput(null)}
                >
                  <Icon name="x" />
                </button>
              </div>
              <pre className="ndb-code-pre ndb-mono" style={{ maxHeight: '220px', overflow: 'auto' }}>
                {JSON.stringify(profileOutput, null, 2)}
              </pre>
            </div>
          )}

          {showInsert && (
            <div className="ndb-inline-panel">
              <div className="ndb-toolbar-group">
                <input
                  type="text"
                  className="ndb-input ndb-mono"
                  placeholder="Optional Document / Point / Row Key ID"
                  value={insertId}
                  onChange={(e) => setInsertId(e.currentTarget.value)}
                />
                <button
                  type="button"
                  className="ndb-btn ndb-btn-primary ndb-btn-sm"
                  disabled={busy}
                  onClick={() => void handleInsert()}
                >
                  {t('Save')}
                </button>
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                  onClick={() => setShowInsert(false)}
                >
                  {t('Cancel')}
                </button>
              </div>
              <div className="ndb-inline-editor">
                <PluginCodeEditor
                  value={insertJson}
                  language="json"
                  lineNumbers="on"
                  minimap={false}
                  height={140}
                  onChange={(d) => setInsertJson(d.value)}
                  onShortcut={onShortcut}
                />
              </div>
            </div>
          )}

          {tab.viewMode === 'table' ? (
            <div className="ndb-grid-host">
              <PluginDataGrid
                columns={columns}
                rows={rows}
                loading={tab.loading}
                emptyMessage={t('No documents found.')}
                onShortcut={onShortcut}
              />
            </div>
          ) : (
            <div className="ndb-json-scroll">
              {tab.documents.map((doc) => (
                <div key={doc.id} className="ndb-doc-card">
                  <div className="ndb-doc-card-head">
                    <span className="ndb-mono">
                      {`id: ${doc.id}${doc.score !== undefined ? `  score: ${doc.score}` : ''}`}
                    </span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                        disabled={busy}
                        onClick={() => void handleDeleteDoc(doc.id)}
                      >
                        {t('Delete')}
                      </button>
                    )}
                  </div>
                  <pre className="ndb-code-pre ndb-mono">{JSON.stringify(doc.source, null, 2)}</pre>
                </div>
              ))}
              {tab.documents.length === 0 && (
                <div className="ndb-empty-center">
                  <p className="ndb-muted">{t('No documents found.')}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'mapping' && (
        <div className="ndb-json-scroll">
          {driver.engine === 'milvus' && !readOnly && extDriver.renameIndex && (
            <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '6px' }}>
              <input
                type="text"
                className="ndb-mono ndb-input-compact"
                placeholder="Rename collection to..."
                value={milvusRenameTo}
                onChange={(e) => setMilvusRenameTo(e.currentTarget.value)}
              />
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                disabled={busy || !milvusRenameTo.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await extDriver.renameIndex!(tab.index, milvusRenameTo.trim());
                    onUpdateTab({ index: milvusRenameTo.trim() });
                    setMilvusRenameTo('');
                    onNotify('success', 'Renamed Milvus collection');
                  } catch (err) {
                    onNotify('error', err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {'Rename Collection'}
              </button>
            </div>
          )}
          <pre className="ndb-code-pre ndb-mono">
            {JSON.stringify(tab.mapping ?? {}, null, 2)}
          </pre>
        </div>
      )}

      {activeSubTab === 'settings' && (
        <div className="ndb-search-body">
          <div className="ndb-inline-row" style={{ padding: '6px 8px', gap: '8px' }}>
            <strong>{`Index Settings (${tab.index})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadSettings()}>
              {t('Refresh')}
            </button>
            {!readOnly && extDriver.updateIndexSettings && (
              <button type="button" className="ndb-btn ndb-btn-primary ndb-btn-xs" disabled={busy} onClick={() => void handleSaveSettings()}>
                {'Update Settings'}
              </button>
            )}
          </div>
          <div className="ndb-editor-host">
            <PluginCodeEditor
              value={settingsJson || '{}'}
              language="json"
              readOnly={readOnly}
              lineNumbers="on"
              minimap={false}
              wordWrap="on"
              onChange={(d) => setSettingsJson(d.value)}
              onShortcut={onShortcut}
            />
          </div>
        </div>
      )}

      {activeSubTab === 'stats' && (
        <div className="ndb-json-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Index Stats (${tab.index})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadStats()}>
              {t('Refresh')}
            </button>
          </div>
          <pre className="ndb-code-pre ndb-mono">{JSON.stringify(statsData ?? {}, null, 2)}</pre>
        </div>
      )}

      {activeSubTab === 'aliases' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '8px' }}>
            <strong>{`Aliases for ${tab.index} (${aliasNames.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadAliases()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>Alias</th>
                {!readOnly && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {aliasNames.map((alias) => (
                <tr key={alias}>
                  <td className="ndb-mono"><strong>{alias}</strong></td>
                  {!readOnly && (
                    <td>
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                        disabled={busy}
                        onClick={() => void handleRemoveAlias(alias)}
                      >
                        {'Remove'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {aliasNames.length === 0 && (
                <tr>
                  <td colSpan={readOnly ? 1 : 2} className="ndb-muted">No aliases assigned to this index.</td>
                </tr>
              )}
            </tbody>
          </table>
          {!readOnly && extDriver.updateIndexAliases && (
            <div className="ndb-inline-row" style={{ marginTop: '8px', gap: '6px' }}>
              <input
                type="text"
                className="ndb-mono ndb-input-compact"
                placeholder="new_alias_name"
                value={newAliasName}
                onChange={(e) => setNewAliasName(e.currentTarget.value)}
              />
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-xs"
                disabled={busy || !newAliasName.trim()}
                onClick={() => void handleAddAlias()}
              >
                {'Add Alias'}
              </button>
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'cluster' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '8px' }}>
            <strong>{'Cluster Health & Nodes'}</strong>
            {clusterHealth && (
              <>
                <span
                  className={`ndb-tag ndb-mono ${
                    clusterHealth.status === 'green'
                      ? 'ndb-tag-ok'
                      : clusterHealth.status === 'yellow'
                        ? 'ndb-tag-warn'
                        : 'ndb-tag-danger'
                  }`}
                >
                  {String(clusterHealth.status ?? 'unknown')}
                </span>
                <span className="ndb-tag ndb-mono">{`nodes: ${String(clusterHealth.number_of_nodes ?? 0)}`}</span>
                <span className="ndb-tag ndb-mono">{`active_shards: ${String(clusterHealth.active_shards ?? 0)}`}</span>
                <span className="ndb-tag ndb-mono">{`unassigned: ${String(clusterHealth.unassigned_shards ?? 0)}`}</span>
              </>
            )}
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadCluster()}>
              {t('Refresh')}
            </button>
          </div>

          {clusterNodes.length > 0 && (
            <table className="ndb-table" style={{ marginBottom: '10px' }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>IP</th>
                  <th>Role</th>
                  <th>Master</th>
                  <th>Heap %</th>
                  <th>RAM %</th>
                  <th>CPU</th>
                  <th>Load 1m</th>
                </tr>
              </thead>
              <tbody>
                {clusterNodes.map((n, idx) => (
                  <tr key={String(n.name ?? idx)}>
                    <td className="ndb-mono"><strong>{String(n.name ?? '—')}</strong></td>
                    <td className="ndb-mono">{String(n.ip ?? '—')}</td>
                    <td className="ndb-mono">{String(n['node.role'] ?? '—')}</td>
                    <td className="ndb-mono">{String(n.master ?? '—')}</td>
                    <td className="ndb-mono">{String(n['heap.percent'] ?? '—')}</td>
                    <td className="ndb-mono">{String(n['ram.percent'] ?? '—')}</td>
                    <td className="ndb-mono">{String(n.cpu ?? '—')}</td>
                    <td className="ndb-mono">{String(n.load_1m ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <pre className="ndb-code-pre ndb-mono">{JSON.stringify(clusterHealth ?? {}, null, 2)}</pre>
        </div>
      )}

      {activeSubTab === 'tasks' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Meilisearch Tasks (${meiliTasks.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadMeiliTasks()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>UID</th>
                <th>Index</th>
                <th>Type</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Enqueued At</th>
              </tr>
            </thead>
            <tbody>
              {meiliTasks.map((task, idx) => (
                <tr key={String(task.uid ?? idx)}>
                  <td className="ndb-mono">{String(task.uid ?? idx)}</td>
                  <td className="ndb-mono">{String(task.indexUid ?? '—')}</td>
                  <td className="ndb-mono">{String(task.type ?? '—')}</td>
                  <td>
                    <span className={`ndb-tag ndb-mono ${task.status === 'succeeded' ? 'ndb-tag-ok' : task.status === 'failed' ? 'ndb-tag-danger' : 'ndb-tag-warn'}`}>
                      {String(task.status ?? '—')}
                    </span>
                  </td>
                  <td className="ndb-mono ndb-muted">{String(task.duration ?? '—')}</td>
                  <td className="ndb-mono ndb-muted">{String(task.enqueuedAt ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeSubTab === 'keys' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Meilisearch API Keys (${meiliKeys.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadMeiliKeys()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>UID</th>
                <th>Actions</th>
                <th>Indexes</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {meiliKeys.map((k, idx) => (
                <tr key={String(k.uid ?? idx)}>
                  <td className="ndb-mono"><strong>{String(k.name ?? '(unnamed)')}</strong></td>
                  <td className="ndb-mono">{String(k.uid ?? '—')}</td>
                  <td className="ndb-mono">{Array.isArray(k.actions) ? k.actions.join(', ') : '—'}</td>
                  <td className="ndb-mono">{Array.isArray(k.indexes) ? k.indexes.join(', ') : '—'}</td>
                  <td className="ndb-mono ndb-muted">{String(k.expiresAt ?? 'never')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeSubTab === 'raw' && (
        <div className="ndb-search-body">
          <div className="ndb-search-query-bar">
            <select
              className="ndb-select"
              value={rawMethod}
              onChange={(e) => setRawMethod(e.currentTarget.value as 'GET' | 'POST' | 'PUT' | 'DELETE')}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
            </select>
            <input
              type="text"
              className="ndb-input ndb-mono"
              value={rawPath}
              placeholder="/_cluster/health"
              onChange={(e) => setRawPath(e.currentTarget.value)}
            />
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={busy}
              onClick={() => void handleRawRequest()}
            >
              {t('Send')}
            </button>
          </div>
          <div className="ndb-inline-editor">
            <PluginCodeEditor
              value={rawBody}
              language="json"
              lineNumbers="on"
              minimap={false}
              height={140}
              placeholder="Optional JSON request body"
              onChange={(d) => setRawBody(d.value)}
              onShortcut={onShortcut}
            />
          </div>
          <div className="ndb-json-scroll">
            {rawResult ? (
              <pre className="ndb-code-pre ndb-mono">
                {`HTTP ${rawResult.status}\n\n${rawResult.body}`}
              </pre>
            ) : (
              <div className="ndb-empty-center">
                <p className="ndb-muted">{t('Send a REST request to inspect the raw response.')}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="ndb-result-strip ndb-mono">
        <span>{`${tab.documents.length} / ${tab.totalCount} docs`}</span>
        <span>{`${tab.executionMs} ms`}</span>
        <span className="ndb-spacer" />
        <span className="ndb-muted">{driver.serverVersion}</span>
      </div>
    </div>
  );
}
