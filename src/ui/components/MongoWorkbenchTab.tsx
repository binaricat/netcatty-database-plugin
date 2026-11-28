/**
 * MongoDB Specialist Workbench Tab (v0.3.0):
 * - Sub-tabs: Documents | Indexes | Schema Analyzer (field presence % + type distribution bars)
 * - EJSON-aware Filter / Sort / Projection / Pipeline & Insert / Replace / Delete (`parseMongoEjson` / `stringifyMongoEjson`)
 * - Pagination (Prev / Next / Skip / Limit)
 * - Table (`PluginDataGrid` with selected row action bar + double-click inline EJSON edit), Tree, JSON views
 * - Visual Aggregation Pipeline editor (Monaco JSON + quick stage presets `+$match`, `+$group`, `+$sort`, `+$project`, `+$limit`)
 * - Read-Only Safe Mode enforcement
 */

import React, { useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  PluginDataGrid,
  type PluginDataGridColumn,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import {
  parseMongoBulkDocuments,
  parseMongoEjson,
  stringifyMongoEjson,
  summarizeMongoExplain,
  type MongoExplainStageNode,
  type MongoExplainSummary,
  type MongoGridFsFileInfo,
  type MongoUserEntry,
} from '../../drivers/mongoDriver';
import type { MongoDocument, MongoDriver } from '../../drivers/types';
import { formatBytes } from '../i18n';
import type { MongoWorkbenchTabState } from '../types';

type ExtendedMongoDriver = MongoDriver & {
  cloneCollection?: (database: string, fromName: string, toName: string) => Promise<void>;
  createDatabase?: (database: string, initialCollection?: string) => Promise<void>;
  listGridFsFiles?: (database: string, bucket: string, limit?: number) => Promise<MongoGridFsFileInfo[]>;
  readGridFsFilePreview?: (
    database: string,
    bucket: string,
    fileId: unknown,
    maxChunks?: number,
  ) => Promise<{ bytesLength: number; truncated: boolean; textPreview: string }>;
  insertMany?: (
    database: string,
    collection: string,
    documents: MongoDocument[],
    ordered?: boolean,
  ) => Promise<{ insertedCount: number }>;
  createUser?: (
    database: string,
    user: string,
    pwd: string,
    roles: Array<{ role: string; db: string }>,
  ) => Promise<void>;
  dropUser?: (database: string, user: string) => Promise<void>;
};

type ExtraMongoSubTab = 'validation' | 'gridfs' | 'console' | 'users' | 'manage';

function ExplainTreeBranch({ node, depth = 0 }: { node: MongoExplainStageNode; depth?: number }) {
  return (
    <div style={{ paddingLeft: `${depth * 16}px`, marginTop: '4px' }}>
      <div className="ndb-inline-row" style={{ gap: '6px' }}>
        <span className={`ndb-tag ndb-mono ${node.stage === 'COLLSCAN' ? 'ndb-tag-warn' : ''}`}>
          {node.stage}
        </span>
        {node.indexName && <span className="ndb-mono ndb-muted">{`index: ${node.indexName}`}</span>}
        {node.nReturned !== undefined && (
          <span className="ndb-mono ndb-muted">{`nReturned: ${node.nReturned}`}</span>
        )}
        {node.executionTimeMillisEstimate !== undefined && (
          <span className="ndb-mono ndb-muted">{`est: ${node.executionTimeMillisEstimate}ms`}</span>
        )}
      </div>
      {node.children.map((ch, idx) => (
        <ExplainTreeBranch key={`${ch.stage}-${idx}`} node={ch} depth={depth + 1} />
      ))}
    </div>
  );
}

export interface MongoWorkbenchTabProps {
  tab: MongoWorkbenchTabState;
  driver: MongoDriver;
  readOnly?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<MongoWorkbenchTabState>) => void;
  onRun: (opts?: { skip?: number }) => Promise<void>;
  onReloadIndexes: () => Promise<void>;
  onAnalyzeSchema: () => Promise<void>;
  onPinToBi?: (payload: {
    title: string;
    collection: string;
    pipelineJson: string;
    documents: MongoDocument[];
    executionMs: number;
  }) => void;
  onCopyText?: (text: string, label: string) => void;
  onNotify: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

const AGG_STAGE_PRESETS: Array<{ label: string; stage: Record<string, unknown> }> = [
  { label: '+$match', stage: { $match: { status: 'active' } } },
  { label: '+$group', stage: { $group: { _id: '$category', count: { $sum: 1 } } } },
  { label: '+$sort', stage: { $sort: { count: -1 } } },
  { label: '+$project', stage: { $project: { _id: 1 } } },
  { label: '+$limit', stage: { $limit: 20 } },
];

function TreeValueNode({ name, value, depth = 0 }: { name: string; value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object' && !(value instanceof Date);
  const isArr = Array.isArray(value);

  if (!isObj) {
    const cls =
      value === null
        ? 'ndb-json-null'
        : typeof value === 'number'
          ? 'ndb-json-num'
          : typeof value === 'boolean'
            ? 'ndb-json-bool'
            : 'ndb-json-str';
    const display =
      value === null
        ? 'null'
        : value instanceof Date
          ? `ISODate("${value.toISOString()}")`
          : typeof value === 'string'
            ? `"${value}"`
            : String(value);
    return (
      <div className="ndb-tree-kv" style={{ paddingLeft: `${depth * 16}px` }}>
        <span className="ndb-json-key ndb-mono">{`${name}:`}</span>
        <span className={`${cls} ndb-mono`}>{display}</span>
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
        className="ndb-tree-kv-btn"
        style={{ paddingLeft: `${depth * 16}px` }}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className="ndb-json-key ndb-mono">{name}</span>
        <span className="ndb-muted ndb-mono">
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
  readOnly = false,
  t,
  onUpdateTab,
  onRun,
  onReloadIndexes,
  onAnalyzeSchema,
  onPinToBi,
  onCopyText,
  onNotify,
  onShortcut,
}: MongoWorkbenchTabProps) {
  const [showInsert, setShowInsert] = useState(false);
  const [insertJson, setInsertJson] = useState('{\n  "name": "example"\n}');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editJson, setEditJson] = useState('');
  const [newIdxKeyJson, setNewIdxKeyJson] = useState('{ "createdAt": -1 }');
  const [newIdxName, setNewIdxName] = useState('');
  const [newIdxUnique, setNewIdxUnique] = useState(false);
  const [busy, setBusy] = useState(false);

  // Wave C MongoDB specialist states
  const extDriver = driver as ExtendedMongoDriver;
  const [extraSubTab, setExtraSubTab] = useState<ExtraMongoSubTab | null>(null);

  // Explain Query
  const [explainSummary, setExplainSummary] = useState<MongoExplainSummary | null>(null);
  const [explainShowRaw, setExplainShowRaw] = useState(false);

  // Distinct Values inspector
  const [showDistinct, setShowDistinct] = useState(false);
  const [distinctField, setDistinctField] = useState('_id');
  const [distinctResult, setDistinctResult] = useState<unknown[] | null>(null);

  // Bulk Import / Export
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkImportText, setBulkImportText] = useState('[\n  { "name": "doc1" },\n  { "name": "doc2" }\n]');

  // Validation Rules
  const [validatorJson, setValidatorJson] = useState('{}');
  const [validationLevel, setValidationLevel] = useState('strict');
  const [validationAction, setValidationAction] = useState('error');
  const [validationLoaded, setValidationLoaded] = useState(false);

  // GridFS Buckets Browser
  const [gridBuckets, setGridBuckets] = useState<Array<{ name: string; filesCount?: number; totalBytes?: number }>>([]);
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [gridFiles, setGridFiles] = useState<MongoGridFsFileInfo[]>([]);
  const [gridPreview, setGridPreview] = useState<{
    filename: string;
    bytesLength: number;
    truncated: boolean;
    textPreview: string;
  } | null>(null);

  // Raw runCommand Console
  const [cmdDb, setCmdDb] = useState(tab.database);
  const [cmdJson, setCmdJson] = useState('{\n  "ping": 1\n}');
  const [cmdOutput, setCmdOutput] = useState<string>('');

  // Users Admin
  const [usersList, setUsersList] = useState<MongoUserEntry[]>([]);
  const [newUserName, setNewUserName] = useState('');
  const [newUserPwd, setNewUserPwd] = useState('');
  const [newUserRole, setNewUserRole] = useState('readWrite');
  const [confirmDropUser, setConfirmDropUser] = useState<string | null>(null);

  // Manage (Rename / Clone Collection, Create / Drop Database)
  const [renameTo, setRenameTo] = useState(`${tab.collection}_renamed`);
  const [renameDropTarget, setRenameDropTarget] = useState(false);
  const [cloneTo, setCloneTo] = useState(`${tab.collection}_copy`);
  const [newDbName, setNewDbName] = useState('');
  const [newDbColl, setNewDbColl] = useState('init');
  const [dropDbConfirmText, setDropDbConfirmText] = useState('');

  const activeSubTab: 'documents' | 'indexes' | 'schema' | ExtraMongoSubTab =
    extraSubTab ?? tab.activeSubTab;

  const handleExplainQuery = async () => {
    if (!driver.explainQuery) return;
    setBusy(true);
    try {
      const filter = parseMongoEjson<MongoDocument>(tab.filterJson);
      const sort = parseMongoEjson<MongoDocument>(tab.sortJson);
      const raw = await driver.explainQuery(tab.database, tab.collection, filter, sort);
      setExplainSummary(summarizeMongoExplain(raw));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRunDistinct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!driver.distinctValues || !distinctField.trim()) return;
    setBusy(true);
    try {
      const filter = parseMongoEjson<MongoDocument>(tab.filterJson);
      const vals = await driver.distinctValues(tab.database, tab.collection, distinctField.trim(), filter);
      setDistinctResult(vals);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleBulkImport = async () => {
    if (readOnly) {
      onNotify('warning', t('Read-only connection: write operation blocked'));
      return;
    }
    setBusy(true);
    try {
      const docs = parseMongoBulkDocuments(bulkImportText);
      if (docs.length === 0) {
        onNotify('warning', 'No documents found in import payload.');
        return;
      }
      if (extDriver.insertMany) {
        const res = await extDriver.insertMany(tab.database, tab.collection, docs, false);
        onNotify('success', `Imported ${res.insertedCount} document(s)`);
      } else {
        for (const doc of docs) {
          await driver.insertOne(tab.database, tab.collection, doc);
        }
        onNotify('success', `Imported ${docs.length} document(s)`);
      }
      setShowBulkImport(false);
      await onRun();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadValidation = async () => {
    if (!driver.getCollectionValidation) return;
    setBusy(true);
    try {
      const res = await driver.getCollectionValidation(tab.database, tab.collection);
      setValidatorJson(stringifyMongoEjson(res.validator ?? {}, true));
      setValidationLevel(res.validationLevel || 'strict');
      setValidationAction(res.validationAction || 'error');
      setValidationLoaded(true);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveValidation = async () => {
    if (readOnly || !driver.setCollectionValidation) return;
    setBusy(true);
    try {
      const validator = parseMongoEjson<MongoDocument>(validatorJson);
      await driver.setCollectionValidation(tab.database, tab.collection, {
        validator,
        validationLevel,
        validationAction,
      });
      onNotify('success', 'Updated collection validation rules');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadGridFsBuckets = async () => {
    if (!driver.listGridFsBuckets) return;
    setBusy(true);
    try {
      const list = await driver.listGridFsBuckets(tab.database);
      setGridBuckets(list);
      if (list.length > 0 && !selectedBucket) {
        await loadGridFsFiles(list[0].name);
      }
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadGridFsFiles = async (bucket: string) => {
    setSelectedBucket(bucket);
    setGridPreview(null);
    if (!extDriver.listGridFsFiles) return;
    try {
      setGridFiles(await extDriver.listGridFsFiles(tab.database, bucket, 100));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    }
  };

  const handlePreviewGridFile = async (file: MongoGridFsFileInfo) => {
    if (!selectedBucket || !extDriver.readGridFsFilePreview) return;
    setBusy(true);
    try {
      const preview = await extDriver.readGridFsFilePreview(tab.database, selectedBucket, file._id, 4);
      setGridPreview({ filename: file.filename, ...preview });
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRunRawCommand = async () => {
    if (readOnly) {
      onNotify('warning', t('Read-only connection: write operation blocked'));
      return;
    }
    setBusy(true);
    try {
      const cmd = parseMongoEjson<MongoDocument>(cmdJson);
      const res = await driver.runCommand(cmdDb.trim() || tab.database, cmd);
      setCmdOutput(stringifyMongoEjson(res, true));
    } catch (err) {
      setCmdOutput(err instanceof Error ? err.message : String(err));
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadUsers = async () => {
    if (!driver.listUsers) return;
    setBusy(true);
    try {
      setUsersList(await driver.listUsers(tab.database));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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
    () => stringifyMongoEjson(tab.documents, true),
    [tab.documents],
  );

  const selectedDoc =
    tab.selectedDocIndex !== null ? tab.documents[tab.selectedDocIndex] ?? null : null;

  const currentPage = Math.floor(tab.skip / Math.max(1, tab.limit)) + 1;
  const totalPages = Math.max(1, Math.ceil(tab.totalCount / Math.max(1, tab.limit)));

  const handleAppendStage = (stage: Record<string, unknown>) => {
    try {
      const parsed = tab.pipelineJson.trim() ? JSON.parse(tab.pipelineJson) : [];
      const arr = Array.isArray(parsed) ? [...parsed, stage] : [stage];
      onUpdateTab({ pipelineJson: JSON.stringify(arr, null, 2) });
    } catch {
      onUpdateTab({ pipelineJson: JSON.stringify([stage], null, 2) });
    }
  };

  const handleInsertDoc = async () => {
    if (readOnly) {
      onNotify('warning', t('Read-only connection: write operation blocked'));
      return;
    }
    setBusy(true);
    try {
      const parsed = parseMongoEjson<MongoDocument>(insertJson);
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
    if (readOnly) {
      onNotify('warning', t('Read-only connection: write operation blocked'));
      return;
    }
    setBusy(true);
    try {
      const parsed = parseMongoEjson<MongoDocument>(editJson);
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
    if (readOnly) {
      onNotify('warning', t('Read-only connection: write operation blocked'));
      return;
    }
    setBusy(true);
    try {
      await driver.deleteOne(tab.database, tab.collection, { _id: doc._id });
      onUpdateTab({ selectedDocIndex: null });
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
    if (readOnly) {
      onNotify('warning', t('Read-only connection: write operation blocked'));
      return;
    }
    setBusy(true);
    try {
      const key = parseMongoEjson<Record<string, number | string>>(newIdxKeyJson);
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
    <div className="ndb-tab-pane">
      {/* Top Bar */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <div className="ndb-toolbar-group">
          <span className="ndb-context-chip ndb-mono">{`${tab.database}.${tab.collection}`}</span>
          <div className="ndb-segmented">
            <button
              type="button"
              className={activeSubTab === 'documents' ? 'is-active' : ''}
              onClick={() => {
                setExtraSubTab(null);
                onUpdateTab({ activeSubTab: 'documents' });
              }}
            >
              {t('Documents')}
            </button>
            <button
              type="button"
              className={activeSubTab === 'indexes' ? 'is-active' : ''}
              onClick={() => {
                setExtraSubTab(null);
                onUpdateTab({ activeSubTab: 'indexes' });
                void onReloadIndexes();
              }}
            >
              {`${t('Indexes')} (${tab.indexes.length})`}
            </button>
            <button
              type="button"
              className={activeSubTab === 'schema' ? 'is-active' : ''}
              onClick={() => {
                setExtraSubTab(null);
                onUpdateTab({ activeSubTab: 'schema' });
                if (!tab.schemaAnalysis) void onAnalyzeSchema();
              }}
            >
              {t('Schema')}
            </button>
            {driver.getCollectionValidation && (
              <button
                type="button"
                className={activeSubTab === 'validation' ? 'is-active' : ''}
                onClick={() => {
                  setExtraSubTab('validation');
                  if (!validationLoaded) void loadValidation();
                }}
              >
                {'Validation'}
              </button>
            )}
            {driver.listGridFsBuckets && (
              <button
                type="button"
                className={activeSubTab === 'gridfs' ? 'is-active' : ''}
                onClick={() => {
                  setExtraSubTab('gridfs');
                  void loadGridFsBuckets();
                }}
              >
                {'GridFS'}
              </button>
            )}
            <button
              type="button"
              className={activeSubTab === 'console' ? 'is-active' : ''}
              onClick={() => setExtraSubTab('console')}
            >
              {'runCommand'}
            </button>
            {driver.listUsers && (
              <button
                type="button"
                className={activeSubTab === 'users' ? 'is-active' : ''}
                onClick={() => {
                  setExtraSubTab('users');
                  void loadUsers();
                }}
              >
                {'Users'}
              </button>
            )}
            <button
              type="button"
              className={activeSubTab === 'manage' ? 'is-active' : ''}
              onClick={() => setExtraSubTab('manage')}
            >
              {'Manage'}
            </button>
          </div>

          {activeSubTab === 'documents' && (
            <>
              <div className="ndb-segmented">
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

              <div className="ndb-segmented">
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

        <div className="ndb-spacer" />

        <div className="ndb-toolbar-group">
          {readOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
          {tab.stats && (
            <span className="ndb-tag ndb-mono">
              {`${tab.stats.count} docs · ${formatBytes(tab.stats.size)}`}
            </span>
          )}
          {activeSubTab === 'documents' && (
            <>
              {driver.explainQuery && tab.mode === 'find' && (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                  disabled={busy}
                  onClick={() => void handleExplainQuery()}
                >
                  {'Explain'}
                </button>
              )}
              {driver.distinctValues && (
                <button
                  type="button"
                  className={`ndb-btn ndb-btn-sm ${showDistinct ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
                  onClick={() => setShowDistinct((v) => !v)}
                >
                  {'Distinct'}
                </button>
              )}
              {!readOnly && (
                <button
                  type="button"
                  className={`ndb-btn ndb-btn-sm ${showBulkImport ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
                  onClick={() => setShowBulkImport((v) => !v)}
                >
                  {'Import'}
                </button>
              )}
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                disabled={tab.documents.length === 0}
                onClick={() => onCopyText?.(jsonAllText, 'EJSON Export')}
              >
                {'Export EJSON'}
              </button>
              {tab.mode === 'aggregate' && onPinToBi && (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                  disabled={tab.documents.length === 0}
                  title={t('Pin to BI Dashboard')}
                  onClick={() =>
                    onPinToBi({
                      title: `${tab.collection} Aggregate`,
                      collection: tab.collection,
                      pipelineJson: tab.pipelineJson || '[]',
                      documents: tab.documents,
                      executionMs: tab.executionMs,
                    })
                  }
                >
                  <Icon name="bar-chart-2" />
                  {t('Pin to BI')}
                </button>
              )}
              {!readOnly && (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                  onClick={() => setShowInsert((v) => !v)}
                >
                  <Icon name="plus" />
                  {t('Insert Doc')}
                </button>
              )}
            </>
          )}
          {activeSubTab === 'schema' ? (
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={tab.schemaLoading}
              onClick={() => void onAnalyzeSchema()}
            >
              <Icon name={tab.schemaLoading ? 'loader' : 'refresh'} />
              {t('Analyze Schema')}
            </button>
          ) : activeSubTab === 'documents' || activeSubTab === 'indexes' ? (
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={tab.loading}
              onClick={() => void onRun({ skip: 0 })}
            >
              <Icon name={tab.loading ? 'loader' : 'play'} />
              {t('Run')}
            </button>
          ) : null}
        </div>
      </div>

      {/* Query Inputs Bar */}
      {activeSubTab === 'documents' && (
        <div className="ndb-mongo-query-bar">
          {tab.mode === 'find' ? (
            <>
              <label className="ndb-mongo-input-label">
                <span>Filter (EJSON)</span>
                <input
                  type="text"
                  className="ndb-mono"
                  placeholder='{ "_id": { "$oid": "..." } }'
                  value={tab.filterJson}
                  onChange={(e) => onUpdateTab({ filterJson: e.currentTarget.value })}
                />
              </label>
              <label className="ndb-mongo-input-label">
                <span>Sort</span>
                <input
                  type="text"
                  className="ndb-mono"
                  placeholder='{ "_id": -1 }'
                  value={tab.sortJson}
                  onChange={(e) => onUpdateTab({ sortJson: e.currentTarget.value })}
                />
              </label>
              <label className="ndb-mongo-input-label">
                <span>Projection</span>
                <input
                  type="text"
                  className="ndb-mono"
                  placeholder="{}"
                  value={tab.projectionJson}
                  onChange={(e) => onUpdateTab({ projectionJson: e.currentTarget.value })}
                />
              </label>
              <label className="ndb-mongo-input-label ndb-mongo-limit">
                <span>Limit</span>
                <input
                  type="number"
                  className="ndb-mono"
                  min={1}
                  max={500}
                  value={tab.limit}
                  onChange={(e) => onUpdateTab({ limit: Math.max(1, Number(e.currentTarget.value) || 50) })}
                />
              </label>
            </>
          ) : (
            <div className="ndb-mongo-agg-editor">
              <div className="ndb-inline-row">
                <span className="ndb-field-label">Aggregation Pipeline (EJSON)</span>
                <div className="ndb-agg-presets">
                  {AGG_STAGE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-mono"
                      onClick={() => handleAppendStage(p.stage)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ndb-mongo-editor-box">
                <PluginCodeEditor
                  value={tab.pipelineJson}
                  language="json"
                  height={120}
                  onChange={({ value }) => onUpdateTab({ pipelineJson: value })}
                  onShortcut={onShortcut}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bulk JSON/EJSON Import Inline Drawer */}
      {showBulkImport && activeSubTab === 'documents' && !readOnly && (
        <div className="ndb-mongo-inline-editor">
          <div className="ndb-mongo-inline-head">
            <strong>{'Bulk Import (JSON Array or NDJSON EJSON)'}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setShowBulkImport(false)}>
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-xs"
              disabled={busy}
              onClick={() => void handleBulkImport()}
            >
              {'Import Documents'}
            </button>
          </div>
          <div className="ndb-mongo-editor-box">
            <PluginCodeEditor
              value={bulkImportText}
              language="json"
              height={150}
              onChange={({ value }) => setBulkImportText(value)}
            />
          </div>
        </div>
      )}

      {/* Distinct Values Inspector */}
      {showDistinct && activeSubTab === 'documents' && (
        <div className="ndb-mongo-inline-editor">
          <form className="ndb-inline-row" onSubmit={(e) => void handleRunDistinct(e)}>
            <strong>{'Distinct Field'}</strong>
            <input
              type="text"
              className="ndb-mono ndb-input-compact"
              placeholder="field.path"
              value={distinctField}
              onChange={(e) => setDistinctField(e.currentTarget.value)}
            />
            <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-xs" disabled={busy || !distinctField.trim()}>
              {'Inspect'}
            </button>
            {distinctResult && (
              <span className="ndb-tag ndb-mono">{`${distinctResult.length} distinct`}</span>
            )}
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setShowDistinct(false)}>
              <Icon name="x" />
            </button>
          </form>
          {distinctResult && (
            <div style={{ marginTop: '6px', maxHeight: '120px', overflow: 'auto', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {distinctResult.slice(0, 200).map((val, i) => (
                <span key={i} className="ndb-tag ndb-mono">
                  {stringifyMongoEjson(val, false)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Explain ExecutionStats Panel */}
      {explainSummary && activeSubTab === 'documents' && (
        <div className="ndb-mongo-inline-editor">
          <div className="ndb-mongo-inline-head">
            <strong>{'Explain Plan (executionStats)'}</strong>
            <span className={`ndb-tag ndb-mono ${explainSummary.isCollectionScan ? 'ndb-tag-warn' : 'ndb-tag-ok'}`}>
              {explainSummary.winningStage}
            </span>
            <span className="ndb-tag ndb-mono">{`returned: ${explainSummary.nReturned}`}</span>
            <span className="ndb-tag ndb-mono">{`keys: ${explainSummary.totalKeysExamined}`}</span>
            <span className="ndb-tag ndb-mono">{`docs: ${explainSummary.totalDocsExamined}`}</span>
            <span className="ndb-tag ndb-mono">{`${explainSummary.executionTimeMillis} ms`}</span>
            <div className="ndb-spacer" />
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
              onClick={() => setExplainShowRaw((v) => !v)}
            >
              {explainShowRaw ? 'Tree View' : 'Raw JSON'}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
              onClick={() => setExplainSummary(null)}
            >
              <Icon name="x" />
            </button>
          </div>
          {explainShowRaw ? (
            <pre className="ndb-code-pre ndb-mono" style={{ maxHeight: '220px', overflow: 'auto' }}>
              {stringifyMongoEjson(explainSummary.raw, true)}
            </pre>
          ) : explainSummary.tree ? (
            <div style={{ padding: '4px 0', maxHeight: '200px', overflow: 'auto' }}>
              <ExplainTreeBranch node={explainSummary.tree} />
            </div>
          ) : null}
        </div>
      )}

      {/* Insert Document Inline Editor */}
      {showInsert && activeSubTab === 'documents' && !readOnly && (
        <div className="ndb-mongo-inline-editor">
          <div className="ndb-mongo-inline-head">
            <strong>{t('Insert Doc')} (EJSON)</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setShowInsert(false)}>
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-xs"
              disabled={busy}
              onClick={() => void handleInsertDoc()}
            >
              Insert
            </button>
          </div>
          <div className="ndb-mongo-editor-box">
            <PluginCodeEditor
              value={insertJson}
              language="json"
              height={160}
              onChange={({ value }) => setInsertJson(value)}
            />
          </div>
        </div>
      )}

      {/* Inline Edit Document Drawer for Table View */}
      {activeSubTab === 'documents' && tab.viewMode === 'table' && editingIndex !== null && tab.documents[editingIndex] && (
        <div className="ndb-mongo-inline-editor">
          <div className="ndb-mongo-inline-head">
            <strong className="ndb-mono">{`${t('Edit')} #${editingIndex + 1} (EJSON)`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setEditingIndex(null)}>
              {t('Cancel')}
            </button>
            {!readOnly && (
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-xs"
                disabled={busy}
                onClick={() => void handleSaveEditDoc(tab.documents[editingIndex])}
              >
                {t('Save')}
              </button>
            )}
          </div>
          <div className="ndb-mongo-editor-box">
            <PluginCodeEditor
              value={editJson}
              language="json"
              readOnly={readOnly}
              height={180}
              onChange={({ value }) => setEditJson(value)}
            />
          </div>
        </div>
      )}

      {/* Table View Selected Row Action Strip */}
      {activeSubTab === 'documents' && tab.viewMode === 'table' && selectedDoc && editingIndex === null && (
        <div className="ndb-mongo-selection-bar">
          <span className="ndb-mono ndb-muted">{`Selected #${(tab.selectedDocIndex ?? 0) + 1}`}</span>
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary ndb-btn-xs"
            onClick={() => {
              setEditingIndex(tab.selectedDocIndex);
              setEditJson(stringifyMongoEjson(selectedDoc, true));
            }}
          >
            {readOnly ? t('Inspect / Edit Cell') : t('Edit')}
          </button>
          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
            onClick={() => onCopyText?.(stringifyMongoEjson(selectedDoc, true), 'Document JSON')}
          >
            {t('Copy')} JSON
          </button>
          {!readOnly && (
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
              disabled={busy}
              onClick={() => void handleDeleteDoc(selectedDoc)}
            >
              {t('Delete')}
            </button>
          )}
        </div>
      )}

      {tab.error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      {/* Body */}
      <div className="ndb-grid-host">
        {activeSubTab === 'validation' ? (
          <div className="ndb-structure-scroll">
            <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '8px' }}>
              <strong>{`Validation Rules (${tab.database}.${tab.collection})`}</strong>
              <select
                className="ndb-select-sm ndb-mono"
                disabled={readOnly}
                value={validationLevel}
                onChange={(e) => setValidationLevel(e.currentTarget.value)}
              >
                <option value="strict">strict</option>
                <option value="moderate">moderate</option>
                <option value="off">off</option>
              </select>
              <select
                className="ndb-select-sm ndb-mono"
                disabled={readOnly}
                value={validationAction}
                onChange={(e) => setValidationAction(e.currentTarget.value)}
              >
                <option value="error">error</option>
                <option value="warn">warn</option>
              </select>
              <div className="ndb-spacer" />
              <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadValidation()}>
                {t('Refresh')}
              </button>
              {!readOnly && driver.setCollectionValidation && (
                <button type="button" className="ndb-btn ndb-btn-primary ndb-btn-xs" disabled={busy} onClick={() => void saveValidation()}>
                  {'Apply collMod'}
                </button>
              )}
            </div>
            <div className="ndb-mongo-editor-box">
              <PluginCodeEditor
                value={validatorJson}
                language="json"
                readOnly={readOnly}
                height={300}
                onChange={({ value }) => setValidatorJson(value)}
                onShortcut={onShortcut}
              />
            </div>
          </div>
        ) : activeSubTab === 'gridfs' ? (
          <div className="ndb-structure-scroll">
            <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '8px' }}>
              <strong>{`GridFS Buckets (${gridBuckets.length})`}</strong>
              {gridBuckets.map((b) => (
                <button
                  key={b.name}
                  type="button"
                  className={`ndb-btn ndb-btn-xs ${selectedBucket === b.name ? 'ndb-btn-primary' : 'ndb-btn-secondary'}`}
                  onClick={() => void loadGridFsFiles(b.name)}
                >
                  {`${b.name} (${b.filesCount ?? 0}${b.totalBytes !== undefined ? ` · ${formatBytes(b.totalBytes)}` : ''})`}
                </button>
              ))}
              <div className="ndb-spacer" />
              <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" disabled={busy} onClick={() => void loadGridFsBuckets()}>
                {t('Refresh')}
              </button>
            </div>
            {gridBuckets.length === 0 ? (
              <div className="ndb-empty-center">
                <p className="ndb-muted">No GridFS buckets (*.files / *.chunks) detected in this database.</p>
              </div>
            ) : (
              <>
                <table className="ndb-table">
                  <thead>
                    <tr>
                      <th>Filename</th>
                      <th>Size</th>
                      <th>Content-Type</th>
                      <th>Uploaded</th>
                      <th>Metadata</th>
                      <th>Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gridFiles.map((f, idx) => (
                      <tr key={String(f._id ?? idx)}>
                        <td className="ndb-mono"><strong>{f.filename || '(unnamed)'}</strong></td>
                        <td className="ndb-mono">{formatBytes(f.length)}</td>
                        <td className="ndb-mono ndb-muted">{f.contentType || '—'}</td>
                        <td className="ndb-mono ndb-muted">{f.uploadDate || '—'}</td>
                        <td className="ndb-mono ndb-muted">{f.metadata ? JSON.stringify(f.metadata) : '—'}</td>
                        <td>
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                            disabled={busy}
                            onClick={() => void handlePreviewGridFile(f)}
                          >
                            {'Preview'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {gridPreview && (
                  <div className="ndb-section-box" style={{ marginTop: '10px' }}>
                    <div className="ndb-inline-row" style={{ marginBottom: '6px' }}>
                      <strong className="ndb-mono">{`${gridPreview.filename} (${formatBytes(gridPreview.bytesLength)}${gridPreview.truncated ? ', truncated' : ''})`}</strong>
                      <div className="ndb-spacer" />
                      {onCopyText && (
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() => onCopyText(gridPreview.textPreview, gridPreview.filename)}
                        >
                          {'Copy Content'}
                        </button>
                      )}
                    </div>
                    <pre className="ndb-code-pre ndb-mono" style={{ maxHeight: '220px', overflow: 'auto' }}>
                      {gridPreview.textPreview}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        ) : activeSubTab === 'console' ? (
          <div className="ndb-structure-scroll">
            <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '6px' }}>
              <strong>{'runCommand Console'}</strong>
              <input
                type="text"
                className="ndb-mono ndb-input-compact"
                placeholder="Database"
                value={cmdDb}
                onChange={(e) => setCmdDb(e.currentTarget.value)}
              />
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-mono"
                onClick={() => setCmdJson('{\n  "ping": 1\n}')}
              >
                {'ping'}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-mono"
                onClick={() => setCmdJson('{\n  "serverStatus": 1\n}')}
              >
                {'serverStatus'}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-mono"
                onClick={() => setCmdJson(`{\n  "collStats": "${tab.collection}"\n}`)}
              >
                {'collStats'}
              </button>
              <div className="ndb-spacer" />
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-xs"
                disabled={busy || readOnly}
                onClick={() => void handleRunRawCommand()}
              >
                <Icon name="play" />
                {'Execute'}
              </button>
            </div>
            <div className="ndb-mongo-editor-box" style={{ marginBottom: '8px' }}>
              <PluginCodeEditor
                value={cmdJson}
                language="json"
                height={140}
                onChange={({ value }) => setCmdJson(value)}
                onShortcut={onShortcut}
              />
            </div>
            <pre className="ndb-code-pre ndb-mono" style={{ minHeight: '140px', maxHeight: '340px', overflow: 'auto' }}>
              {cmdOutput || '// Command output will appear here'}
            </pre>
          </div>
        ) : activeSubTab === 'users' ? (
          <div className="ndb-structure-scroll">
            <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
              <strong>{`Users in ${tab.database} (${usersList.length})`}</strong>
              <div className="ndb-spacer" />
              <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadUsers()}>
                {t('Refresh')}
              </button>
            </div>
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>DB</th>
                  <th>Roles</th>
                  {!readOnly && extDriver.dropUser && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {usersList.map((u) => (
                  <tr key={`${u.db}.${u.user}`}>
                    <td className="ndb-mono"><strong>{u.user}</strong></td>
                    <td className="ndb-mono">{u.db}</td>
                    <td className="ndb-mono">{u.roles.map((r) => `${r.role}@${r.db}`).join(', ') || '—'}</td>
                    {!readOnly && extDriver.dropUser && (
                      <td>
                        {confirmDropUser === u.user ? (
                          <div className="ndb-inline-row">
                            <button
                              type="button"
                              className="ndb-btn ndb-btn-danger ndb-btn-xs"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  await extDriver.dropUser!(tab.database, u.user);
                                  setConfirmDropUser(null);
                                  onNotify('success', `Dropped user ${u.user}`);
                                  await loadUsers();
                                } catch (err) {
                                  onNotify('error', err instanceof Error ? err.message : String(err));
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              {'Confirm Drop'}
                            </button>
                            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setConfirmDropUser(null)}>
                              {t('Cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                            onClick={() => setConfirmDropUser(u.user)}
                          >
                            {'Drop'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!readOnly && extDriver.createUser && (
              <form
                className="ndb-add-row-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newUserName.trim() || !newUserPwd) return;
                  setBusy(true);
                  try {
                    await extDriver.createUser!(tab.database, newUserName.trim(), newUserPwd, [
                      { role: newUserRole, db: tab.database },
                    ]);
                    setNewUserName('');
                    setNewUserPwd('');
                    onNotify('success', `Created user ${newUserName.trim()}`);
                    await loadUsers();
                  } catch (err) {
                    onNotify('error', err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <strong>{'Create User'}</strong>
                <div className="ndb-add-row-inputs">
                  <input type="text" className="ndb-mono" placeholder="username" value={newUserName} onChange={(e) => setNewUserName(e.currentTarget.value)} />
                  <input type="password" className="ndb-mono" placeholder="password" value={newUserPwd} onChange={(e) => setNewUserPwd(e.currentTarget.value)} />
                  <select className="ndb-select-sm ndb-mono" value={newUserRole} onChange={(e) => setNewUserRole(e.currentTarget.value)}>
                    <option value="read">read</option>
                    <option value="readWrite">readWrite</option>
                    <option value="dbAdmin">dbAdmin</option>
                    <option value="dbOwner">dbOwner</option>
                    <option value="userAdmin">userAdmin</option>
                  </select>
                  <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={busy || !newUserName.trim() || !newUserPwd}>
                    {'Create User'}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : activeSubTab === 'manage' ? (
          <div className="ndb-structure-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="ndb-section-box">
              <strong>{`Rename Collection (${tab.collection})`}</strong>
              <div className="ndb-inline-row" style={{ marginTop: '6px', gap: '8px' }}>
                <input type="text" className="ndb-mono" value={renameTo} onChange={(e) => setRenameTo(e.currentTarget.value)} placeholder="new_collection_name" />
                <label className="ndb-checkbox-row">
                  <input type="checkbox" checked={renameDropTarget} onChange={(e) => setRenameDropTarget(e.currentTarget.checked)} />
                  <span>dropTarget</span>
                </label>
                <button
                  type="button"
                  className="ndb-btn ndb-btn-primary ndb-btn-sm"
                  disabled={busy || readOnly || !renameTo.trim() || !driver.renameCollection}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await driver.renameCollection!(tab.database, tab.collection, renameTo.trim(), renameDropTarget);
                      onUpdateTab({ collection: renameTo.trim() });
                      onNotify('success', `Renamed collection to ${renameTo.trim()}`);
                    } catch (err) {
                      onNotify('error', err instanceof Error ? err.message : String(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {'Rename'}
                </button>
              </div>
            </div>

            <div className="ndb-section-box">
              <strong>{`Clone Collection via $out (${tab.collection})`}</strong>
              <div className="ndb-inline-row" style={{ marginTop: '6px', gap: '8px' }}>
                <input type="text" className="ndb-mono" value={cloneTo} onChange={(e) => setCloneTo(e.currentTarget.value)} placeholder="target_collection" />
                <button
                  type="button"
                  className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                  disabled={busy || readOnly || !cloneTo.trim() || !extDriver.cloneCollection}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await extDriver.cloneCollection!(tab.database, tab.collection, cloneTo.trim());
                      onNotify('success', `Cloned ${tab.collection} to ${cloneTo.trim()}`);
                    } catch (err) {
                      onNotify('error', err instanceof Error ? err.message : String(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {'Clone'}
                </button>
              </div>
            </div>

            <div className="ndb-section-box">
              <strong>{'Create Database'}</strong>
              <div className="ndb-inline-row" style={{ marginTop: '6px', gap: '8px' }}>
                <input type="text" className="ndb-mono" value={newDbName} onChange={(e) => setNewDbName(e.currentTarget.value)} placeholder="new_database" />
                <input type="text" className="ndb-mono" value={newDbColl} onChange={(e) => setNewDbColl(e.currentTarget.value)} placeholder="initial collection" />
                <button
                  type="button"
                  className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                  disabled={busy || readOnly || !newDbName.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      if (extDriver.createDatabase) {
                        await extDriver.createDatabase(newDbName.trim(), newDbColl.trim() || 'init');
                      } else {
                        await driver.createCollection(newDbName.trim(), newDbColl.trim() || 'init');
                      }
                      onNotify('success', `Created database ${newDbName.trim()}`);
                      setNewDbName('');
                    } catch (err) {
                      onNotify('error', err instanceof Error ? err.message : String(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {'Create DB'}
                </button>
              </div>
            </div>

            {driver.dropDatabase && (
              <div className="ndb-section-box">
                <strong className="ndb-text-danger">{`Drop Database (${tab.database})`}</strong>
                <div className="ndb-inline-row" style={{ marginTop: '6px', gap: '8px' }}>
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder={`Type "${tab.database}" to confirm`}
                    value={dropDbConfirmText}
                    onChange={(e) => setDropDbConfirmText(e.currentTarget.value)}
                  />
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-danger ndb-btn-sm"
                    disabled={busy || readOnly || dropDbConfirmText.trim() !== tab.database}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await driver.dropDatabase!(tab.database);
                        setDropDbConfirmText('');
                        onNotify('success', `Dropped database ${tab.database}`);
                      } catch (err) {
                        onNotify('error', err instanceof Error ? err.message : String(err));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {'Drop Database'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : activeSubTab === 'schema' ? (
          <div className="ndb-structure-scroll">
            {tab.schemaLoading ? (
              <div className="ndb-empty-center">
                <Icon name="loader" />
                <p>{t('Loading...')}</p>
              </div>
            ) : !tab.schemaAnalysis ? (
              <div className="ndb-empty-center">
                <p>Click Analyze Schema to inspect field types and coverage.</p>
              </div>
            ) : (
              <>
                <div className="ndb-diff-summary-bar ndb-mono">
                  <span className="ndb-tag">{`Sampled ${tab.schemaAnalysis.sampleCount} of ${tab.schemaAnalysis.totalDocuments} docs`}</span>
                  <span className="ndb-tag">{`${tab.schemaAnalysis.fields.length} unique paths`}</span>
                </div>
                <table className="ndb-table">
                  <thead>
                    <tr>
                      <th>Field Path</th>
                      <th>Presence</th>
                      <th>Type Distribution</th>
                      <th>Sample Values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tab.schemaAnalysis.fields.map((field) => (
                      <tr key={field.path}>
                        <td className="ndb-mono"><strong>{field.path}</strong></td>
                        <td className="ndb-mono">{`${field.percentage}% (${field.count})`}</td>
                        <td>
                          <div className="ndb-schema-types">
                            {field.types.map((tp) => (
                              <div key={tp.type} className="ndb-schema-type-row">
                                <span className="ndb-type-chip ndb-mono">{tp.type}</span>
                                <span className="ndb-schema-bar">
                                  <span className="ndb-schema-bar-fill" style={{ width: `${tp.percentage}%` }} />
                                </span>
                                <span className="ndb-mono ndb-muted">{`${tp.percentage}%`}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="ndb-mono ndb-muted">{field.samples.slice(0, 3).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        ) : activeSubTab === 'indexes' ? (
          <div className="ndb-structure-scroll">
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>Key Spec</th>
                  <th>{t('Unique')}</th>
                  {!readOnly && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {tab.indexes.map((idx) => (
                  <tr key={idx.name}>
                    <td className="ndb-mono"><strong>{idx.name}</strong></td>
                    <td className="ndb-mono">{JSON.stringify(idx.key)}</td>
                    <td>{idx.unique ? 'UNIQUE' : 'No'}</td>
                    {!readOnly && (
                      <td>
                        {idx.name !== '_id_' && (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
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
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {!readOnly && (
              <form className="ndb-add-row-form" onSubmit={(e) => void handleCreateIndex(e)}>
                <strong>{t('Add Index')}</strong>
                <div className="ndb-add-row-inputs">
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder='{ "field": 1 }'
                    value={newIdxKeyJson}
                    onChange={(e) => setNewIdxKeyJson(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder="Index name (optional)"
                    value={newIdxName}
                    onChange={(e) => setNewIdxName(e.currentTarget.value)}
                  />
                  <label className="ndb-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newIdxUnique}
                      onChange={(e) => setNewIdxUnique(e.currentTarget.checked)}
                    />
                    <span>{t('Unique')}</span>
                  </label>
                  <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={busy}>
                    Create Index
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : tab.viewMode === 'table' ? (
          <PluginDataGrid
            columns={tableColumns}
            rows={tab.documents}
            loading={tab.loading}
            emptyMessage="No documents matched"
            onCellSelect={({ rowIndex }) => onUpdateTab({ selectedDocIndex: rowIndex })}
            onCellDoubleClick={({ rowIndex }) => {
              const doc = tab.documents[rowIndex];
              if (!doc) return;
              onUpdateTab({ selectedDocIndex: rowIndex });
              setEditingIndex(rowIndex);
              setEditJson(stringifyMongoEjson(doc, true));
            }}
            onCellCopy={({ text }) => onCopyText?.(text, 'Field')}
            onShortcut={onShortcut}
          />
        ) : tab.viewMode === 'json' ? (
          <div className="ndb-editor-host">
            <PluginCodeEditor value={jsonAllText} language="json" readOnly wordWrap="on" onShortcut={onShortcut} />
          </div>
        ) : (
          <div className="ndb-structure-scroll ndb-mongo-tree-list">
            {tab.documents.map((doc, idx) => {
              const isEditing = editingIndex === idx;
              return (
                <div key={String(doc._id ?? idx)} className="ndb-mongo-doc-card">
                  <div className="ndb-mongo-doc-head">
                    <span className="ndb-mono ndb-muted">{`#${tab.skip + idx + 1} · _id: ${stringifyMongoEjson(doc._id, false)}`}</span>
                    <div className="ndb-spacer" />
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-primary ndb-btn-xs"
                          disabled={busy}
                          onClick={() => void handleSaveEditDoc(doc)}
                        >
                          {t('Save')}
                        </button>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() => setEditingIndex(null)}
                        >
                          {t('Cancel')}
                        </button>
                      </>
                    ) : (
                      !readOnly && (
                        <>
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                            onClick={() => {
                              setEditingIndex(idx);
                              setEditJson(stringifyMongoEjson(doc, true));
                            }}
                          >
                            {t('Edit')}
                          </button>
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                            disabled={busy}
                            onClick={() => void handleDeleteDoc(doc)}
                          >
                            {t('Delete')}
                          </button>
                        </>
                      )
                    )}
                  </div>
                  {isEditing ? (
                    <div className="ndb-mongo-editor-box">
                      <PluginCodeEditor
                        value={editJson}
                        language="json"
                        height={180}
                        onChange={({ value }) => setEditJson(value)}
                      />
                    </div>
                  ) : (
                    <div className="ndb-mongo-doc-tree">
                      {Object.entries(doc).map(([k, v]) => (
                        <TreeValueNode key={k} name={k} value={v} depth={0} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {tab.documents.length === 0 && (
              <div className="ndb-empty-center">
                <p>No documents matched</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Strip with Pagination */}
      <div className="ndb-result-strip ndb-mono">
        {activeSubTab === 'documents' && tab.mode === 'find' && (
          <div className="ndb-pager">
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
              disabled={tab.loading || tab.skip <= 0}
              onClick={() => void onRun({ skip: Math.max(0, tab.skip - tab.limit) })}
            >
              {t('Prev')}
            </button>
            <span>{`${t('Page')} ${currentPage} / ${totalPages}`}</span>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
              disabled={tab.loading || tab.skip + tab.limit >= tab.totalCount}
              onClick={() => void onRun({ skip: tab.skip + tab.limit })}
            >
              {t('Next')}
            </button>
          </div>
        )}
        <span>{`${tab.documents.length} of ${tab.totalCount} documents`}</span>
        <span>{`${tab.executionMs} ms`}</span>
        <span className="ndb-spacer" />
        <span className="ndb-muted">{`MongoDB ${driver.serverVersion}`}</span>
      </div>
    </div>
  );
}
