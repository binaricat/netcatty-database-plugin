/**
 * Redis Specialist Workbench Tab (v0.3.0):
 * - Sub-tabs: Keys | Server Info (sectioned dashboard + searchable raw INFO) | Pub/Sub (live publish + subscribe)
 * - DB 0..15 switcher, MATCH filter, SCAN Load More cursor pagination, Tree (:) vs Flat toggle
 * - Structured CRUD + inline editing for all 6 Redis data types:
 *   String (Monaco), Hash (inline value edit), List (inline LSET edit), Set, ZSet (inline score edit), Stream
 * - Interactive CLI Console with Up/Down command history
 * - Read-Only Safe Mode enforcement
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PluginCodeEditor,
  PluginSplitPane,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import {
  decodeRedisValueCodec,
  parseRedisInfoSections,
  type RedisCommandStatEntry,
  type RedisMonitorSubscription,
  type RedisValueCodec,
  type RedisValueSearchHit,
} from '../../drivers/redisDriver';
import type {
  RedisClientInfo,
  RedisDriver,
  RedisKeyEntry,
  RedisKeyType,
  RedisNamespaceNode,
  RedisSlowlogEntry,
  RedisStreamConsumerInfo,
  RedisStreamEntry,
  RedisStreamGroupInfo,
  RedisStreamPendingEntry,
  RedisSubscription,
} from '../../drivers/types';
import { formatBytes, formatTtl } from '../i18n';
import type { RedisWorkbenchTabState } from '../types';

type ExtendedRedisDriver = RedisDriver & {
  getCommandStats?: () => Promise<RedisCommandStatEntry[]>;
  searchKeyValues?: (
    keys: readonly RedisKeyEntry[],
    query: string,
    maxCheck?: number,
  ) => Promise<RedisValueSearchHit[]>;
  startMonitor?: (
    onEntry: (line: string, timestamp: number) => void,
  ) => Promise<RedisMonitorSubscription>;
};

type ExtraRedisSubTab = 'slowlog' | 'clients' | 'monitor';

export interface RedisWorkbenchTabProps {
  tab: RedisWorkbenchTabState;
  driver: RedisDriver;
  readOnly?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<RedisWorkbenchTabState>) => void;
  onScan: (opts?: { db?: number; match?: string; append?: boolean }) => Promise<void>;
  onSelectKey: (key: string) => Promise<void>;
  onNotify: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

const TYPE_LABEL: Record<RedisKeyType, string> = {
  string: 'STR',
  hash: 'HASH',
  list: 'LIST',
  set: 'SET',
  zset: 'ZSET',
  stream: 'STREAM',
  none: 'NONE',
  unknown: 'KEY',
};

function isJsonLike(val: string): boolean {
  const s = val.trim();
  return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'));
}

export function RedisWorkbenchTab({
  tab,
  driver,
  readOnly = false,
  t,
  onUpdateTab,
  onScan,
  onSelectKey,
  onNotify,
  onShortcut,
}: RedisWorkbenchTabProps) {
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [showNewKey, setShowNewKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyType, setNewKeyType] = useState<'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'>('string');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [newKeyField, setNewKeyField] = useState('field1');
  const [newKeyScore, setNewKeyScore] = useState('1');
  const [newKeyTtl, setNewKeyTtl] = useState('');

  // Value editing drafts
  const [stringDraft, setStringDraft] = useState<string | null>(null);
  const [ttlDraft, setTtlDraft] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [hashField, setHashField] = useState('');
  const [hashVal, setHashVal] = useState('');
  const [editingHashField, setEditingHashField] = useState<string | null>(null);
  const [editingHashVal, setEditingHashVal] = useState('');
  const [listVal, setListVal] = useState('');
  const [editingListIdx, setEditingListIdx] = useState<number | null>(null);
  const [editingListVal, setEditingListVal] = useState('');
  const [setMember, setSetMember] = useState('');
  const [zsetMember, setZsetMember] = useState('');
  const [zsetScore, setZsetScore] = useState('1');
  const [editingZsetMember, setEditingZsetMember] = useState<string | null>(null);
  const [editingZsetScore, setEditingZsetScore] = useState('');
  const [streamField, setStreamField] = useState('event');
  const [streamVal, setStreamVal] = useState('');
  const [busy, setBusy] = useState(false);

  // Wave C specialist sub-tabs & tools
  const extDriver = driver as ExtendedRedisDriver;
  const [extraSubTab, setExtraSubTab] = useState<ExtraRedisSubTab | null>(null);
  const [keySeparator, setKeySeparator] = useState<string>(':');
  const [customSepMode, setCustomSepMode] = useState(false);

  // Multi-select & Batch Delete / FLUSHDB confirm
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [showBatchPanel, setShowBatchPanel] = useState(false);
  const [batchPattern, setBatchPattern] = useState('');
  const [confirmFlushDb, setConfirmFlushDb] = useState(false);
  const [confirmBatchPattern, setConfirmBatchPattern] = useState(false);

  // Value content search across scanned keys
  const [valueSearchQuery, setValueSearchQuery] = useState('');
  const [valueSearchHits, setValueSearchHits] = useState<RedisValueSearchHit[] | null>(null);
  const [valueSearchLoading, setValueSearchLoading] = useState(false);

  // String Value Codecs (Raw / JSON / Hex / Base64 / Gzip)
  const [valueCodec, setValueCodec] = useState<RedisValueCodec>('raw');
  const [codecPreview, setCodecPreview] = useState<{ text: string; error?: string }>({ text: '' });

  // Stream Consumer Groups / Consumers / Pending
  const [streamGroups, setStreamGroups] = useState<RedisStreamGroupInfo[]>([]);
  const [streamGroupsLoading, setStreamGroupsLoading] = useState(false);
  const [selectedStreamGroup, setSelectedStreamGroup] = useState<string | null>(null);
  const [streamConsumers, setStreamConsumers] = useState<RedisStreamConsumerInfo[]>([]);
  const [streamPending, setStreamPending] = useState<RedisStreamPendingEntry[]>([]);

  // Slowlog panel
  const [slowlogEntries, setSlowlogEntries] = useState<RedisSlowlogEntry[]>([]);
  const [slowlogLoading, setSlowlogLoading] = useState(false);
  const [confirmSlowlogReset, setConfirmSlowlogReset] = useState(false);

  // Connected Clients panel
  const [clientsList, setClientsList] = useState<RedisClientInfo[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsFilter, setClientsFilter] = useState('');
  const [confirmKillClientId, setConfirmKillClientId] = useState<string | null>(null);

  // Live Monitor / Command Activity
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [monitorLogs, setMonitorLogs] = useState<Array<{ ts: number; line: string }>>([]);
  const [monitorFilter, setMonitorFilter] = useState('');
  const [commandStats, setCommandStats] = useState<RedisCommandStatEntry[]>([]);
  const monitorRef = useRef<RedisMonitorSubscription | null>(null);

  // CLI command history cursor (-1 = fresh input)
  const [cliHistIdx, setCliHistIdx] = useState(-1);

  // Pub/Sub subscription lifecycle
  const subRef = useRef<RedisSubscription | null>(null);
  const pubsubLogRef = useRef(tab.pubsubLog);
  pubsubLogRef.current = tab.pubsubLog;

  useEffect(() => {
    return () => {
      if (subRef.current) {
        void subRef.current.unsubscribe().catch(() => {});
        subRef.current = null;
      }
      if (monitorRef.current) {
        void monitorRef.current.stop().catch(() => {});
        monitorRef.current = null;
      }
    };
  }, []);

  const keyspaceCounts = useMemo(
    () => new Map((tab.info?.keyspace ?? []).map((k) => [k.db, k.keys])),
    [tab.info],
  );

  const infoSections = useMemo(
    () => (tab.info?.raw ? parseRedisInfoSections(tab.info.raw) : []),
    [tab.info],
  );

  const filteredRawInfo = useMemo(() => {
    if (!tab.info?.sections) return [] as Array<[string, string, string]>;
    const q = (tab.infoFilter || '').trim().toLowerCase();
    const rows: Array<[string, string, string]> = [];
    for (const [sec, kv] of Object.entries(tab.info.sections)) {
      for (const [k, v] of Object.entries(kv)) {
        if (!q || sec.toLowerCase().includes(q) || k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) {
          rows.push([sec, k, v]);
        }
      }
    }
    return rows;
  }, [tab.info, tab.infoFilter]);

  const treeNodes = useMemo(
    () => driver.buildNamespaceTree(tab.keys, keySeparator || ':'),
    [driver, tab.keys, keySeparator],
  );

  const detail = tab.keyDetail;
  const activeStringValue =
    detail?.type === 'string' ? (stringDraft ?? String(detail.value ?? '')) : '';

  useEffect(() => {
    if (detail?.type !== 'string' || valueCodec === 'raw') {
      setCodecPreview({ text: activeStringValue });
      return;
    }
    let cancelled = false;
    void decodeRedisValueCodec(activeStringValue, valueCodec).then((res) => {
      if (!cancelled) setCodecPreview(res);
    });
    return () => {
      cancelled = true;
    };
  }, [detail?.type, activeStringValue, valueCodec]);

  useEffect(() => {
    if (detail?.type !== 'stream' || !driver.getStreamGroups) {
      setStreamGroups([]);
      setSelectedStreamGroup(null);
      setStreamConsumers([]);
      setStreamPending([]);
      return;
    }
    let cancelled = false;
    setStreamGroupsLoading(true);
    void driver
      .getStreamGroups(detail.key)
      .then((groups) => {
        if (!cancelled) {
          setStreamGroups(groups);
          setSelectedStreamGroup(null);
          setStreamConsumers([]);
          setStreamPending([]);
        }
      })
      .catch(() => {
        if (!cancelled) setStreamGroups([]);
      })
      .finally(() => {
        if (!cancelled) setStreamGroupsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.key, detail?.type, driver]);

  const loadSlowlog = async () => {
    if (!driver.getSlowlog) return;
    setSlowlogLoading(true);
    try {
      setSlowlogEntries(await driver.getSlowlog(128));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSlowlogLoading(false);
    }
  };

  const loadClients = async () => {
    if (!driver.listClients) return;
    setClientsLoading(true);
    try {
      setClientsList(await driver.listClients());
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setClientsLoading(false);
    }
  };

  const loadCommandStats = async () => {
    if (!extDriver.getCommandStats) return;
    try {
      setCommandStats(await extDriver.getCommandStats());
    } catch {
      // optional
    }
  };

  const handleToggleMonitor = async () => {
    if (monitorRef.current) {
      await monitorRef.current.stop().catch(() => {});
      monitorRef.current = null;
      setMonitorRunning(false);
      return;
    }
    if (!extDriver.startMonitor) {
      onNotify('warning', 'MONITOR is not supported by this Redis driver.');
      return;
    }
    setBusy(true);
    try {
      const sub = await extDriver.startMonitor((line, ts) => {
        setMonitorLogs((prev) => [...prev.slice(-299), { ts, line }]);
      });
      monitorRef.current = sub;
      setMonitorRunning(true);
      void loadCommandStats();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInspectStreamGroup = async (streamKey: string, groupName: string) => {
    setSelectedStreamGroup(groupName);
    try {
      const [consumers, pending] = await Promise.all([
        driver.getStreamConsumers ? driver.getStreamConsumers(streamKey, groupName) : Promise.resolve([]),
        driver.getStreamPending ? driver.getStreamPending(streamKey, groupName, 100) : Promise.resolve([]),
      ]);
      setStreamConsumers(consumers);
      setStreamPending(pending);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    }
  };

  const handleValueContentSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = valueSearchQuery.trim();
    if (!q) {
      setValueSearchHits(null);
      return;
    }
    if (!extDriver.searchKeyValues) return;
    setValueSearchLoading(true);
    try {
      const hits = await extDriver.searchKeyValues(tab.keys, q, 200);
      setValueSearchHits(hits);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setValueSearchLoading(false);
    }
  };

  const toggleKeySelection = (key: string) => {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const runMutation = async (fn: () => Promise<void>, successMsg: string) => {
    if (readOnly) {
      onNotify('warning', t('Read-only connection: write operation blocked'));
      return;
    }
    setBusy(true);
    try {
      await fn();
      onNotify('success', successMsg);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const k = newKeyName.trim();
    if (!k) return;
    await runMutation(async () => {
      const ttlNum = newKeyTtl.trim() ? Number(newKeyTtl.trim()) : undefined;
      if (newKeyType === 'string') {
        await driver.setString(k, newKeyValue, ttlNum && ttlNum > 0 ? ttlNum : undefined);
      } else if (newKeyType === 'hash') {
        await driver.setHashField(k, newKeyField.trim() || 'field', newKeyValue);
        if (ttlNum && ttlNum > 0) await driver.setTtl(k, ttlNum);
      } else if (newKeyType === 'list') {
        await driver.pushList(k, newKeyValue || 'item', 'right');
        if (ttlNum && ttlNum > 0) await driver.setTtl(k, ttlNum);
      } else if (newKeyType === 'set') {
        await driver.addSetMembers(k, newKeyValue || 'member');
        if (ttlNum && ttlNum > 0) await driver.setTtl(k, ttlNum);
      } else if (newKeyType === 'zset') {
        await driver.addZSetMember(k, Number(newKeyScore) || 0, newKeyValue || 'member');
        if (ttlNum && ttlNum > 0) await driver.setTtl(k, ttlNum);
      } else if (newKeyType === 'stream') {
        await driver.addStreamEntry(k, { [newKeyField.trim() || 'event']: newKeyValue || 'created' });
        if (ttlNum && ttlNum > 0) await driver.setTtl(k, ttlNum);
      }
      setShowNewKey(false);
      setNewKeyName('');
      setNewKeyValue('');
      setNewKeyTtl('');
      await onScan();
      await onSelectKey(k);
    }, `Created key ${k}`);
  };

  const handleCliSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = tab.cliInput.trim();
    if (!cmd) return;
    const nextCmdHist = [...(tab.cliCommandHistory ?? []).filter((c) => c !== cmd).slice(-49), cmd];
    setCliHistIdx(-1);
    onUpdateTab({ cliInput: '', cliCommandHistory: nextCmdHist });
    try {
      const res = await driver.executeCli(cmd);
      onUpdateTab({ cliHistory: [...tab.cliHistory.slice(-49), res] });
    } catch (err) {
      onUpdateTab({
        cliHistory: [
          ...tab.cliHistory.slice(-49),
          {
            command: cmd.split(/\s+/)[0] || cmd,
            args: [],
            output: null,
            formatted: err instanceof Error ? err.message : String(err),
            executionMs: 0,
            isError: true,
          },
        ],
      });
    }
  };

  const handleCliKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hist = tab.cliCommandHistory ?? [];
    if (hist.length === 0) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIdx = cliHistIdx < 0 ? hist.length - 1 : Math.max(0, cliHistIdx - 1);
      setCliHistIdx(nextIdx);
      onUpdateTab({ cliInput: hist[nextIdx] });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cliHistIdx < 0) return;
      const nextIdx = cliHistIdx + 1;
      if (nextIdx >= hist.length) {
        setCliHistIdx(-1);
        onUpdateTab({ cliInput: '' });
      } else {
        setCliHistIdx(nextIdx);
        onUpdateTab({ cliInput: hist[nextIdx] });
      }
    }
  };

  const handleToggleSubscribe = async () => {
    if (subRef.current) {
      try {
        await subRef.current.unsubscribe();
      } catch {
        // ignore close errors
      }
      subRef.current = null;
      onUpdateTab({ pubsubSubscribed: [] });
      onNotify('info', t('Unsubscribe'));
      return;
    }
    const channels = tab.pubsubChannel
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (channels.length === 0) return;
    setBusy(true);
    try {
      const sub = await driver.subscribe(channels, (msg) => {
        const nextLog = [...(pubsubLogRef.current ?? []).slice(-199), msg];
        pubsubLogRef.current = nextLog;
        onUpdateTab({ pubsubLog: nextLog });
      });
      subRef.current = sub;
      onUpdateTab({ pubsubSubscribed: sub.channels });
      onNotify('success', `Subscribed to ${sub.channels.join(', ')}`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    const channel = tab.pubsubChannel.split(',')[0]?.trim();
    if (!channel) return;
    await runMutation(async () => {
      const receivers = await driver.publish(channel, tab.pubsubMessage);
      onUpdateTab({ pubsubMessage: '' });
      onNotify('info', `Delivered to ${receivers} subscriber(s)`);
    }, `Published to ${channel}`);
  };

  const renderTreeNode = (node: RedisNamespaceNode, depth = 0): React.ReactNode => {
    if (node.isLeaf && node.key) {
      return renderKeyRow(node.key, node.name, depth);
    }
    const open = expandedFolders[node.fullPath] ?? depth === 0;
    return (
      <div key={`ns:${node.fullPath}`}>
        <button
          type="button"
          className="ndb-tree-row ndb-tree-folder"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() =>
            setExpandedFolders((prev) => ({ ...prev, [node.fullPath]: !open }))
          }
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <Icon name="folder" />
          <span className="ndb-truncate">{node.name}</span>
          <span className="ndb-count-pill ndb-mono">{node.keyCount}</span>
        </button>
        {open && node.children.map((ch) => renderTreeNode(ch, depth + 1))}
      </div>
    );
  };

  const renderKeyRow = (entry: RedisKeyEntry, displayLabel?: string, depth = 0) => {
    const active = tab.selectedKey === entry.key;
    const checked = selectedKeys.includes(entry.key);
    return (
      <div
        key={entry.key}
        className={`ndb-redis-key-row ${active ? 'is-active' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px`, display: 'flex', alignItems: 'center', gap: '4px' }}
        title={entry.key}
      >
        {!readOnly && (
          <input
            type="checkbox"
            aria-label={`Select ${entry.key}`}
            checked={checked}
            onChange={() => toggleKeySelection(entry.key)}
          />
        )}
        <button
          type="button"
          className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-flex-1"
          style={{ justifyContent: 'flex-start', padding: '0 4px', minHeight: '22px', gap: '6px' }}
          onClick={() => {
            setStringDraft(null);
            setValueCodec('raw');
            setTtlDraft('');
            setRenameDraft(entry.key);
            setEditingHashField(null);
            setEditingListIdx(null);
            setEditingZsetMember(null);
            void onSelectKey(entry.key);
          }}
        >
          <span className={`ndb-rtype ndb-rtype-${entry.type}`}>{TYPE_LABEL[entry.type] ?? 'KEY'}</span>
          <span className="ndb-truncate ndb-mono">{displayLabel ?? entry.key}</span>
          {entry.ttlMs !== -1 && (
            <span className="ndb-ttl-pill ndb-mono">{formatTtl(entry.ttlMs)}</span>
          )}
        </button>
      </div>
    );
  };

  const activeSubTab: 'keys' | 'info' | 'pubsub' | ExtraRedisSubTab = extraSubTab ?? (tab.activeSubTab || 'keys');

  const filteredClients = useMemo(() => {
    const q = clientsFilter.trim().toLowerCase();
    if (!q) return clientsList;
    return clientsList.filter(
      (c) =>
        c.id.toLowerCase().includes(q) ||
        c.addr.toLowerCase().includes(q) ||
        (c.name ?? '').toLowerCase().includes(q) ||
        (c.cmd ?? '').toLowerCase().includes(q),
    );
  }, [clientsList, clientsFilter]);

  const filteredMonitorLogs = useMemo(() => {
    const q = monitorFilter.trim().toLowerCase();
    if (!q) return monitorLogs;
    return monitorLogs.filter((m) => m.line.toLowerCase().includes(q));
  }, [monitorLogs, monitorFilter]);

  return (
    <div className="ndb-tab-pane">
      {/* Top Bar */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <div className="ndb-toolbar-group">
          <div className="ndb-segmented">
            <button
              type="button"
              className={activeSubTab === 'keys' ? 'is-active' : ''}
              onClick={() => {
                setExtraSubTab(null);
                onUpdateTab({ activeSubTab: 'keys' });
              }}
            >
              {t('Keys')}
            </button>
            <button
              type="button"
              className={activeSubTab === 'info' ? 'is-active' : ''}
              onClick={() => {
                setExtraSubTab(null);
                onUpdateTab({ activeSubTab: 'info' });
              }}
            >
              {t('Server Info')}
            </button>
            <button
              type="button"
              className={activeSubTab === 'pubsub' ? 'is-active' : ''}
              onClick={() => {
                setExtraSubTab(null);
                onUpdateTab({ activeSubTab: 'pubsub' });
              }}
            >
              {t('Pub/Sub')}
              {tab.pubsubSubscribed.length > 0 && (
                <span className="ndb-count-pill ndb-mono">{tab.pubsubSubscribed.length}</span>
              )}
            </button>
            {driver.getSlowlog && (
              <button
                type="button"
                className={activeSubTab === 'slowlog' ? 'is-active' : ''}
                onClick={() => {
                  setExtraSubTab('slowlog');
                  void loadSlowlog();
                }}
              >
                {'Slowlog'}
              </button>
            )}
            {driver.listClients && (
              <button
                type="button"
                className={activeSubTab === 'clients' ? 'is-active' : ''}
                onClick={() => {
                  setExtraSubTab('clients');
                  void loadClients();
                }}
              >
                {'Clients'}
              </button>
            )}
            {extDriver.startMonitor && (
              <button
                type="button"
                className={activeSubTab === 'monitor' ? 'is-active' : ''}
                onClick={() => {
                  setExtraSubTab('monitor');
                  void loadCommandStats();
                }}
              >
                {'Monitor'}
                {monitorRunning && <span className="ndb-online-dot" />}
              </button>
            )}
          </div>

          {activeSubTab === 'keys' && (
            <>
              <select
                aria-label="Redis database"
                className="ndb-mono ndb-select-sm"
                value={tab.db}
                onChange={(e) => {
                  setSelectedKeys([]);
                  setValueSearchHits(null);
                  void onScan({ db: Number(e.currentTarget.value) });
                }}
              >
                {Array.from({ length: 16 }, (_, i) => {
                  const cnt = keyspaceCounts.get(i);
                  return (
                    <option key={i} value={i}>
                      {cnt !== undefined ? `DB ${i} (${cnt})` : `DB ${i}`}
                    </option>
                  );
                })}
              </select>

              <form
                className="ndb-inline-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onScan({ match: tab.matchPattern });
                }}
              >
                <input
                  type="text"
                  className="ndb-mono ndb-input-compact"
                  placeholder="MATCH *"
                  value={tab.matchPattern}
                  onChange={(e) => onUpdateTab({ matchPattern: e.currentTarget.value })}
                />
                <button type="submit" className="ndb-btn ndb-btn-secondary ndb-btn-sm" disabled={tab.loading}>
                  <Icon name="search" />
                  Scan
                </button>
              </form>

              <div className="ndb-segmented">
                <button
                  type="button"
                  className={tab.viewMode === 'tree' ? 'is-active' : ''}
                  onClick={() => onUpdateTab({ viewMode: 'tree' })}
                >
                  {`${t('Tree')} (${keySeparator || ':'})`}
                </button>
                <button
                  type="button"
                  className={tab.viewMode === 'flat' ? 'is-active' : ''}
                  onClick={() => onUpdateTab({ viewMode: 'flat' })}
                >
                  {t('Flat')}
                </button>
              </div>

              {tab.viewMode === 'tree' && (
                <div className="ndb-inline-row">
                  <select
                    aria-label="Key separator"
                    className="ndb-mono ndb-select-sm"
                    value={customSepMode ? '__custom__' : keySeparator}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      if (val === '__custom__') {
                        setCustomSepMode(true);
                      } else {
                        setCustomSepMode(false);
                        setKeySeparator(val);
                      }
                    }}
                  >
                    <option value=":">Sep :</option>
                    <option value="/">Sep /</option>
                    <option value=".">Sep .</option>
                    <option value="__custom__">Custom...</option>
                  </select>
                  {customSepMode && (
                    <input
                      type="text"
                      className="ndb-mono ndb-input-xs"
                      placeholder="sep"
                      value={keySeparator}
                      onChange={(e) => setKeySeparator(e.currentTarget.value)}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="ndb-spacer" />

        <div className="ndb-toolbar-group">
          {readOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
          {activeSubTab === 'keys' && !readOnly && (
            <>
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-sm"
                onClick={() => setShowNewKey((v) => !v)}
              >
                <Icon name="plus" />
                {t('New Key')}
              </button>
              <button
                type="button"
                className={`ndb-btn ndb-btn-sm ${showBatchPanel ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
                onClick={() => {
                  setShowBatchPanel((v) => !v);
                  setConfirmFlushDb(false);
                  setConfirmBatchPattern(false);
                }}
              >
                {'Batch / Flush'}
                {selectedKeys.length > 0 && (
                  <span className="ndb-count-pill ndb-mono">{selectedKeys.length}</span>
                )}
              </button>
            </>
          )}
          <button
            type="button"
            className={`ndb-btn ndb-btn-sm ${tab.showCli ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
            onClick={() => onUpdateTab({ showCli: !tab.showCli })}
          >
            <Icon name="file-code" />
            {t('CLI Console')}
          </button>
          <button
            type="button"
            className="ndb-icon-btn"
            title={t('Refresh')}
            disabled={tab.loading}
            onClick={() => {
              if (activeSubTab === 'slowlog') void loadSlowlog();
              else if (activeSubTab === 'clients') void loadClients();
              else if (activeSubTab === 'monitor') void loadCommandStats();
              else void onScan();
            }}
          >
            <Icon name={tab.loading ? 'loader' : 'refresh'} />
          </button>
        </div>
      </div>

      {/* Batch Delete / FLUSHDB Bar */}
      {showBatchPanel && activeSubTab === 'keys' && !readOnly && (
        <div className="ndb-newkey-bar">
          {selectedKeys.length > 0 && (
            <>
              <span className="ndb-tag ndb-mono">{`${selectedKeys.length} selected`}</span>
              <button
                type="button"
                className="ndb-btn ndb-btn-danger ndb-btn-xs"
                disabled={busy}
                onClick={() =>
                  void runMutation(async () => {
                    const count = await driver.deleteKeys(selectedKeys);
                    if (tab.selectedKey && selectedKeys.includes(tab.selectedKey)) {
                      onUpdateTab({ selectedKey: null, keyDetail: null });
                    }
                    setSelectedKeys([]);
                    await onScan();
                    onNotify('info', `Deleted ${count} selected key(s)`);
                  }, 'Batch deleted selected keys')
                }
              >
                {`Delete Selected (${selectedKeys.length})`}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                onClick={() => setSelectedKeys([])}
              >
                {'Clear Selection'}
              </button>
            </>
          )}

          {driver.batchDeleteByPattern && (
            <div className="ndb-inline-row">
              <input
                type="text"
                className="ndb-mono ndb-input-compact"
                placeholder="Delete pattern (e.g. cache:*)"
                value={batchPattern}
                onChange={(e) => {
                  setBatchPattern(e.currentTarget.value);
                  setConfirmBatchPattern(false);
                }}
              />
              {!confirmBatchPattern ? (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-secondary ndb-btn-xs ndb-text-danger"
                  disabled={busy || !batchPattern.trim()}
                  onClick={() => setConfirmBatchPattern(true)}
                >
                  {'Delete Pattern'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-danger ndb-btn-xs"
                    disabled={busy}
                    onClick={() =>
                      void runMutation(async () => {
                        const deleted = await driver.batchDeleteByPattern!(batchPattern.trim());
                        setConfirmBatchPattern(false);
                        setBatchPattern('');
                        setSelectedKeys([]);
                        onUpdateTab({ selectedKey: null, keyDetail: null });
                        await onScan();
                        onNotify('info', `Deleted ${deleted} matching key(s)`);
                      }, `Batch deleted pattern`)
                    }
                  >
                    {`Confirm DEL ${batchPattern.trim()}`}
                  </button>
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                    onClick={() => setConfirmBatchPattern(false)}
                  >
                    {t('Cancel')}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="ndb-spacer" />

          {driver.flushDb && (
            !confirmFlushDb ? (
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                disabled={busy}
                onClick={() => setConfirmFlushDb(true)}
              >
                {`FLUSHDB (db${tab.db})`}
              </button>
            ) : (
              <div className="ndb-inline-row">
                <button
                  type="button"
                  className="ndb-btn ndb-btn-danger ndb-btn-xs"
                  disabled={busy}
                  onClick={() =>
                    void runMutation(async () => {
                      await driver.flushDb!();
                      setConfirmFlushDb(false);
                      setSelectedKeys([]);
                      onUpdateTab({ selectedKey: null, keyDetail: null });
                      await onScan();
                    }, `Flushed DB ${tab.db}`)
                  }
                >
                  {`Confirm FLUSHDB db${tab.db}`}
                </button>
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                  onClick={() => setConfirmFlushDb(false)}
                >
                  {t('Cancel')}
                </button>
              </div>
            )
          )}
        </div>
      )}

      {/* Inline New Key Form */}
      {showNewKey && activeSubTab === 'keys' && !readOnly && (
        <form className="ndb-newkey-bar" onSubmit={(e) => void handleCreateKey(e)}>
          <select
            className="ndb-mono ndb-select-sm"
            value={newKeyType}
            onChange={(e) => setNewKeyType(e.currentTarget.value as typeof newKeyType)}
          >
            <option value="string">STRING</option>
            <option value="hash">HASH</option>
            <option value="list">LIST</option>
            <option value="set">SET</option>
            <option value="zset">ZSET</option>
            <option value="stream">STREAM</option>
          </select>
          <input
            type="text"
            className="ndb-mono"
            placeholder="namespace:key"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.currentTarget.value)}
          />
          {(newKeyType === 'hash' || newKeyType === 'stream') && (
            <input
              type="text"
              className="ndb-mono"
              placeholder="field"
              value={newKeyField}
              onChange={(e) => setNewKeyField(e.currentTarget.value)}
            />
          )}
          {newKeyType === 'zset' && (
            <input
              type="number"
              className="ndb-mono ndb-input-xs"
              placeholder="score"
              value={newKeyScore}
              onChange={(e) => setNewKeyScore(e.currentTarget.value)}
            />
          )}
          <input
            type="text"
            className="ndb-mono"
            placeholder="value"
            value={newKeyValue}
            onChange={(e) => setNewKeyValue(e.currentTarget.value)}
          />
          <input
            type="number"
            className="ndb-mono ndb-input-xs"
            placeholder="TTL (s)"
            value={newKeyTtl}
            onChange={(e) => setNewKeyTtl(e.currentTarget.value)}
          />
          <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={busy || !newKeyName.trim()}>
            {t('Create')}
          </button>
          <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={() => setShowNewKey(false)}>
            {t('Cancel')}
          </button>
        </form>
      )}

      {/* Main Content Area by Sub-tab */}
      {activeSubTab === 'info' ? (
        <div className="ndb-structure-scroll ndb-redis-dashboard">
          {!tab.info ? (
            <div className="ndb-empty-center">
              <p>{t('Loading...')}</p>
            </div>
          ) : (
            <>
              <div className="ndb-info-cards-grid">
                {infoSections.map((sec) => (
                  <div key={sec.id} className="ndb-info-card">
                    <h4 className="ndb-info-card-title">{sec.title}</h4>
                    <div className="ndb-info-metrics">
                      {sec.metrics.map((m) => (
                        <div key={m.key} className="ndb-info-metric-row">
                          <span className="ndb-muted">{m.label}</span>
                          <strong className="ndb-mono">{m.value}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="ndb-section-box">
                <div className="ndb-inline-row">
                  <strong>Raw INFO</strong>
                  <div className="ndb-spacer" />
                  <div className="ndb-compact-search">
                    <Icon name="search" />
                    <input
                      type="text"
                      placeholder={t('Filter INFO keys...')}
                      value={tab.infoFilter || ''}
                      onChange={(e) => onUpdateTab({ infoFilter: e.currentTarget.value })}
                    />
                  </div>
                </div>
                <table className="ndb-table">
                  <thead>
                    <tr>
                      <th>Section</th>
                      <th>Key</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRawInfo.slice(0, 200).map(([sec, k, v]) => (
                      <tr key={`${sec}:${k}`}>
                        <td className="ndb-mono ndb-muted">{sec}</td>
                        <td className="ndb-mono"><strong>{k}</strong></td>
                        <td className="ndb-mono">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : activeSubTab === 'pubsub' ? (
        <div className="ndb-structure-scroll ndb-pubsub-pane">
          <div className="ndb-pubsub-controls">
            <div className="ndb-section-box">
              <strong>{t('Subscribe')}</strong>
              <div className="ndb-inline-row">
                <input
                  type="text"
                  className="ndb-mono ndb-flex-1"
                  placeholder="channel1, channel2"
                  value={tab.pubsubChannel}
                  onChange={(e) => onUpdateTab({ pubsubChannel: e.currentTarget.value })}
                />
                <button
                  type="button"
                  className={`ndb-btn ndb-btn-sm ${tab.pubsubSubscribed.length > 0 ? 'ndb-btn-danger' : 'ndb-btn-primary'}`}
                  disabled={busy || (!tab.pubsubSubscribed.length && !tab.pubsubChannel.trim())}
                  onClick={() => void handleToggleSubscribe()}
                >
                  {tab.pubsubSubscribed.length > 0 ? t('Unsubscribe') : t('Subscribe')}
                </button>
              </div>
              {tab.pubsubSubscribed.length > 0 && (
                <div className="ndb-inline-row">
                  <span className="ndb-tag ndb-tag-ok">{t('Subscribed')}</span>
                  {tab.pubsubSubscribed.map((ch) => (
                    <span key={ch} className="ndb-tag ndb-mono">{ch}</span>
                  ))}
                </div>
              )}
            </div>

            {!readOnly && (
              <form className="ndb-section-box" onSubmit={(e) => void handlePublish(e)}>
                <strong>{t('Publish')}</strong>
                <div className="ndb-inline-row">
                  <input
                    type="text"
                    className="ndb-mono ndb-flex-1"
                    placeholder={`${t('Message')}...`}
                    value={tab.pubsubMessage}
                    onChange={(e) => onUpdateTab({ pubsubMessage: e.currentTarget.value })}
                  />
                  <button
                    type="submit"
                    className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                    disabled={busy || !tab.pubsubChannel.trim() || !tab.pubsubMessage}
                  >
                    {t('Publish')}
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="ndb-section-box ndb-pubsub-feed">
            <div className="ndb-inline-row">
              <strong>{`${t('Messages')} (${tab.pubsubLog.length})`}</strong>
              <div className="ndb-spacer" />
              {tab.pubsubLog.length > 0 && (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                  onClick={() => onUpdateTab({ pubsubLog: [] })}
                >
                  {t('Clear')}
                </button>
              )}
            </div>
            {tab.pubsubLog.length === 0 ? (
              <p className="ndb-tree-empty">{t('No messages received yet')}</p>
            ) : (
              <div className="ndb-pubsub-log-list ndb-mono">
                {tab.pubsubLog.map((m, idx) => (
                  <div key={idx} className="ndb-pubsub-log-row">
                    <span className="ndb-muted">{new Date(m.timestamp).toLocaleTimeString()}</span>
                    <span className="ndb-tag">{m.channel}</span>
                    <span>{m.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : activeSubTab === 'slowlog' ? (
        <div className="ndb-structure-scroll ndb-redis-dashboard">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Slowlog (${slowlogEntries.length})`}</strong>
            <div className="ndb-spacer" />
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-xs"
              disabled={slowlogLoading}
              onClick={() => void loadSlowlog()}
            >
              <Icon name={slowlogLoading ? 'loader' : 'refresh'} />
              {t('Refresh')}
            </button>
            {!readOnly && driver.resetSlowlog && (
              !confirmSlowlogReset ? (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                  onClick={() => setConfirmSlowlogReset(true)}
                >
                  {'SLOWLOG RESET'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-danger ndb-btn-xs"
                    disabled={busy}
                    onClick={() =>
                      void runMutation(async () => {
                        await driver.resetSlowlog!();
                        setConfirmSlowlogReset(false);
                        await loadSlowlog();
                      }, 'Reset Redis slowlog')
                    }
                  >
                    {'Confirm Reset'}
                  </button>
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                    onClick={() => setConfirmSlowlogReset(false)}
                  >
                    {t('Cancel')}
                  </button>
                </>
              )
            )}
          </div>
          {slowlogEntries.length === 0 ? (
            <div className="ndb-empty-center">
              <p className="ndb-muted">{slowlogLoading ? t('Loading...') : 'No slowlog entries recorded.'}</p>
            </div>
          ) : (
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Time</th>
                  <th>Duration</th>
                  <th>Command</th>
                  <th>Client</th>
                </tr>
              </thead>
              <tbody>
                {slowlogEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="ndb-mono">{entry.id}</td>
                    <td className="ndb-mono ndb-muted">
                      {entry.timestamp ? new Date(entry.timestamp * 1000).toLocaleString() : '—'}
                    </td>
                    <td className="ndb-mono">
                      {entry.durationUs >= 1000
                        ? `${(entry.durationUs / 1000).toFixed(2)} ms`
                        : `${entry.durationUs} us`}
                    </td>
                    <td className="ndb-mono">{entry.command.join(' ')}</td>
                    <td className="ndb-mono ndb-muted">
                      {[entry.clientAddr, entry.clientName].filter(Boolean).join(' ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : activeSubTab === 'clients' ? (
        <div className="ndb-structure-scroll ndb-redis-dashboard">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Connected Clients (${filteredClients.length})`}</strong>
            <div className="ndb-spacer" />
            <div className="ndb-compact-search">
              <Icon name="search" />
              <input
                type="text"
                placeholder="Filter addr, name, cmd..."
                value={clientsFilter}
                onChange={(e) => setClientsFilter(e.currentTarget.value)}
              />
            </div>
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-xs"
              disabled={clientsLoading}
              onClick={() => void loadClients()}
            >
              <Icon name={clientsLoading ? 'loader' : 'refresh'} />
              {t('Refresh')}
            </button>
          </div>
          {filteredClients.length === 0 ? (
            <div className="ndb-empty-center">
              <p className="ndb-muted">{clientsLoading ? t('Loading...') : 'No connected clients.'}</p>
            </div>
          ) : (
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Address</th>
                  <th>Name</th>
                  <th>DB</th>
                  <th>Age / Idle</th>
                  <th>Flags</th>
                  <th>Last Cmd</th>
                  {!readOnly && driver.killClient && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {filteredClients.map((client) => (
                  <tr key={client.id || client.addr}>
                    <td className="ndb-mono">{client.id}</td>
                    <td className="ndb-mono">{client.addr}</td>
                    <td className="ndb-mono">{client.name || '—'}</td>
                    <td className="ndb-mono">{client.db ?? '—'}</td>
                    <td className="ndb-mono ndb-muted">{`${client.ageSec ?? 0}s / ${client.idleSec ?? 0}s`}</td>
                    <td className="ndb-mono">{client.flags || '—'}</td>
                    <td className="ndb-mono">{client.cmd || '—'}</td>
                    {!readOnly && driver.killClient && (
                      <td>
                        {confirmKillClientId === client.id ? (
                          <div className="ndb-inline-row">
                            <button
                              type="button"
                              className="ndb-btn ndb-btn-danger ndb-btn-xs"
                              disabled={busy}
                              onClick={() =>
                                void runMutation(async () => {
                                  await driver.killClient!(client.id);
                                  setConfirmKillClientId(null);
                                  await loadClients();
                                }, `Killed client ${client.id}`)
                              }
                            >
                              {'Confirm Kill'}
                            </button>
                            <button
                              type="button"
                              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                              onClick={() => setConfirmKillClientId(null)}
                            >
                              {t('Cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                            disabled={!client.id}
                            onClick={() => setConfirmKillClientId(client.id)}
                          >
                            {'Kill'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : activeSubTab === 'monitor' ? (
        <div className="ndb-structure-scroll ndb-pubsub-pane">
          <div className="ndb-section-box">
            <div className="ndb-inline-row">
              <strong>{'Live MONITOR & Command Activity'}</strong>
              <span className={`ndb-tag ${monitorRunning ? 'ndb-tag-ok' : ''}`}>
                {monitorRunning ? 'Streaming' : 'Stopped'}
              </span>
              <div className="ndb-spacer" />
              <div className="ndb-compact-search">
                <Icon name="search" />
                <input
                  type="text"
                  placeholder="Filter commands..."
                  value={monitorFilter}
                  onChange={(e) => setMonitorFilter(e.currentTarget.value)}
                />
              </div>
              <button
                type="button"
                className={`ndb-btn ndb-btn-sm ${monitorRunning ? 'ndb-btn-danger' : 'ndb-btn-primary'}`}
                disabled={busy}
                onClick={() => void handleToggleMonitor()}
              >
                <Icon name={monitorRunning ? 'square' : 'play'} />
                {monitorRunning ? 'Stop MONITOR' : 'Start MONITOR'}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                onClick={() => setMonitorLogs([])}
              >
                {t('Clear')}
              </button>
            </div>
            {commandStats.length > 0 && (
              <div className="ndb-inline-row" style={{ flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                {commandStats.slice(0, 12).map((st) => (
                  <span key={st.command} className="ndb-tag ndb-mono">
                    {`${st.command}: ${st.calls} (${st.usecPerCall.toFixed(1)}us)`}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="ndb-section-box ndb-pubsub-feed">
            {filteredMonitorLogs.length === 0 ? (
              <p className="ndb-tree-empty">
                {monitorRunning ? 'Listening for Redis commands...' : 'Click Start MONITOR to stream live commands.'}
              </p>
            ) : (
              <div className="ndb-pubsub-log-list ndb-mono">
                {filteredMonitorLogs.map((m, idx) => (
                  <div key={idx} className="ndb-pubsub-log-row">
                    <span className="ndb-muted">{new Date(m.ts).toLocaleTimeString()}</span>
                    <span>{m.line}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Keys Sub-tab: Left = Tree/Flat + Value Search + Load More, Right = Structured Value Editor */
        <div className="ndb-split-host">
          <PluginSplitPane direction="horizontal" initialSize={300} minSize={200} maxSize={520}>
            <div className="ndb-redis-keys-pane">
              {extDriver.searchKeyValues && (
                <form
                  className="ndb-inline-row"
                  style={{ padding: '4px 6px', gap: '4px' }}
                  onSubmit={(e) => void handleValueContentSearch(e)}
                >
                  <input
                    type="text"
                    className="ndb-mono ndb-flex-1"
                    placeholder="Search value content..."
                    value={valueSearchQuery}
                    onChange={(e) => {
                      setValueSearchQuery(e.currentTarget.value);
                      if (!e.currentTarget.value.trim()) setValueSearchHits(null);
                    }}
                  />
                  <button
                    type="submit"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                    disabled={valueSearchLoading || !valueSearchQuery.trim()}
                  >
                    <Icon name={valueSearchLoading ? 'loader' : 'search'} />
                  </button>
                  {valueSearchHits !== null && (
                    <button
                      type="button"
                      className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                      onClick={() => {
                        setValueSearchQuery('');
                        setValueSearchHits(null);
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  )}
                </form>
              )}
              {valueSearchHits !== null && (
                <div style={{ padding: '0 6px 6px' }}>
                  <div className="ndb-muted ndb-mono" style={{ fontSize: '11px', marginBottom: '4px' }}>
                    {`Value matches: ${valueSearchHits.length}`}
                  </div>
                  {valueSearchHits.map((hit) => (
                    <button
                      key={`hit:${hit.key}`}
                      type="button"
                      className="ndb-redis-key-row"
                      style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }}
                      onClick={() => void onSelectKey(hit.key)}
                    >
                      <span className="ndb-mono ndb-truncate">{hit.key}</span>
                      <span className="ndb-muted ndb-mono ndb-truncate" style={{ fontSize: '11px' }}>
                        {hit.snippet}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {tab.keys.length === 0 ? (
                <div className="ndb-empty-center">
                  <Icon name="key" />
                  <p>{tab.loading ? t('Loading...') : 'No keys matched'}</p>
                </div>
              ) : (
                <>
                  {tab.viewMode === 'tree'
                    ? treeNodes.map((n) => renderTreeNode(n, 0))
                    : tab.keys.map((k) => renderKeyRow(k))}
                  {tab.cursor && tab.cursor !== '0' && (
                    <div className="ndb-redis-load-more">
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-secondary ndb-btn-sm ndb-btn-full"
                        disabled={tab.loading}
                        onClick={() => void onScan({ append: true })}
                      >
                        <Icon name={tab.loading ? 'loader' : 'refresh'} />
                        {`${t('Load More')} (cursor ${tab.cursor})`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="ndb-redis-detail-pane">
              {!detail ? (
                <div className="ndb-empty-center">
                  <Icon name="key" />
                  <p>{t('Select a key from the left to inspect or edit')}</p>
                </div>
              ) : (
                <div className="ndb-redis-editor">
                  {/* Key Header + TTL + Rename + Delete */}
                  <div className="ndb-redis-key-header">
                    <span className={`ndb-rtype ndb-rtype-${detail.type}`}>{TYPE_LABEL[detail.type]}</span>
                    <input
                      type="text"
                      className="ndb-mono ndb-redis-key-title"
                      readOnly={readOnly}
                      value={renameDraft || detail.key}
                      onChange={(e) => setRenameDraft(e.currentTarget.value)}
                    />
                    {!readOnly && renameDraft && renameDraft !== detail.key && (
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                        disabled={busy}
                        onClick={() =>
                          void runMutation(async () => {
                            await driver.renameKey(detail.key, renameDraft.trim());
                            await onScan();
                            await onSelectKey(renameDraft.trim());
                          }, `Renamed to ${renameDraft.trim()}`)
                        }
                      >
                        {t('Rename')}
                      </button>
                    )}

                    <span className="ndb-tag ndb-mono">{`TTL: ${formatTtl(detail.ttlMs)}`}</span>
                    {detail.size !== undefined && (
                      <span className="ndb-tag ndb-mono">{formatBytes(detail.size)}</span>
                    )}

                    {!readOnly && (
                      <>
                        <input
                          type="number"
                          className="ndb-mono ndb-input-xs"
                          placeholder="TTL (s)"
                          value={ttlDraft}
                          onChange={(e) => setTtlDraft(e.currentTarget.value)}
                        />
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                          disabled={busy || !ttlDraft.trim()}
                          onClick={() =>
                            void runMutation(async () => {
                              await driver.setTtl(detail.key, Number(ttlDraft));
                              setTtlDraft('');
                              await onSelectKey(detail.key);
                            }, 'Updated TTL')
                          }
                        >
                          Set TTL
                        </button>
                        {detail.ttlMs > 0 && (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                            disabled={busy}
                            onClick={() =>
                              void runMutation(async () => {
                                await driver.persistKey(detail.key);
                                await onSelectKey(detail.key);
                              }, 'Persisted key')
                            }
                          >
                            Persist
                          </button>
                        )}
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-danger ndb-btn-xs"
                          disabled={busy}
                          onClick={() =>
                            void runMutation(async () => {
                              await driver.deleteKeys(detail.key);
                              onUpdateTab({ selectedKey: null, keyDetail: null });
                              await onScan();
                            }, `Deleted ${detail.key}`)
                          }
                        >
                          {t('Delete')}
                        </button>
                      </>
                    )}
                  </div>

                  {/* Type-specific CRUD Editor */}
                  <div className="ndb-redis-value-body">
                    {detail.type === 'string' && (
                      <div className="ndb-redis-string-wrap">
                        <div className="ndb-inline-row" style={{ padding: '4px 8px', gap: '6px' }}>
                          <span className="ndb-muted">Codec</span>
                          <div className="ndb-segmented">
                            {(['raw', 'json', 'hex', 'base64', 'gzip'] as RedisValueCodec[]).map((c) => (
                              <button
                                key={c}
                                type="button"
                                className={valueCodec === c ? 'is-active' : ''}
                                onClick={() => setValueCodec(c)}
                              >
                                {c.toUpperCase()}
                              </button>
                            ))}
                          </div>
                          {codecPreview.error && (
                            <span className="ndb-text-amber ndb-mono" style={{ fontSize: '11px' }}>
                              {codecPreview.error}
                            </span>
                          )}
                        </div>
                        <div className="ndb-editor-host">
                          <PluginCodeEditor
                            value={valueCodec === 'raw' ? activeStringValue : codecPreview.text}
                            language={
                              valueCodec === 'json' || (valueCodec === 'raw' && isJsonLike(activeStringValue))
                                ? 'json'
                                : 'plaintext'
                            }
                            readOnly={readOnly || valueCodec !== 'raw'}
                            wordWrap="on"
                            onChange={({ value }) => {
                              if (valueCodec === 'raw') setStringDraft(value);
                            }}
                            onShortcut={onShortcut}
                          />
                        </div>
                        <div className="ndb-redis-value-footer">
                          {valueCodec === 'raw' && isJsonLike(activeStringValue) && !readOnly && (
                            <button
                              type="button"
                              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                              onClick={() => {
                                try {
                                  setStringDraft(JSON.stringify(JSON.parse(activeStringValue), null, 2));
                                } catch {
                                  // ignore invalid json
                                }
                              }}
                            >
                              Prettify JSON
                            </button>
                          )}
                          <div className="ndb-spacer" />
                          {!readOnly && valueCodec === 'raw' && (
                            <button
                              type="button"
                              className="ndb-btn ndb-btn-primary ndb-btn-sm"
                              disabled={busy || stringDraft === null}
                              onClick={() =>
                                void runMutation(async () => {
                                  await driver.setString(detail.key, activeStringValue);
                                  setStringDraft(null);
                                  await onSelectKey(detail.key);
                                }, 'Saved string value')
                              }
                            >
                              {t('Save')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {detail.type === 'hash' && (
                      <div className="ndb-structure-scroll">
                        <table className="ndb-table">
                          <thead>
                            <tr>
                              <th>Field</th>
                              <th>Value</th>
                              {!readOnly && <th>Action</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries((detail.value as Record<string, string>) ?? {}).map(([f, v]) => {
                              const isEd = editingHashField === f;
                              return (
                                <tr key={f}>
                                  <td className="ndb-mono"><strong>{f}</strong></td>
                                  <td className="ndb-mono">
                                    {isEd ? (
                                      <input
                                        type="text"
                                        className="ndb-mono ndb-input-compact"
                                        value={editingHashVal}
                                        onChange={(e) => setEditingHashVal(e.currentTarget.value)}
                                      />
                                    ) : (
                                      v
                                    )}
                                  </td>
                                  {!readOnly && (
                                    <td className="ndb-cell-actions">
                                      {isEd ? (
                                        <>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-primary ndb-btn-xs"
                                            disabled={busy}
                                            onClick={() =>
                                              void runMutation(async () => {
                                                await driver.setHashField(detail.key, f, editingHashVal);
                                                setEditingHashField(null);
                                                await onSelectKey(detail.key);
                                              }, `Updated field ${f}`)
                                            }
                                          >
                                            {t('Save')}
                                          </button>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                            onClick={() => setEditingHashField(null)}
                                          >
                                            {t('Cancel')}
                                          </button>
                                        </>
                                      ) : (
                                        <>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                            disabled={busy}
                                            onClick={() => {
                                              setEditingHashField(f);
                                              setEditingHashVal(v);
                                            }}
                                          >
                                            {t('Edit')}
                                          </button>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                                            disabled={busy}
                                            onClick={() =>
                                              void runMutation(async () => {
                                                await driver.deleteHashField(detail.key, f);
                                                await onSelectKey(detail.key);
                                              }, `Removed field ${f}`)
                                            }
                                          >
                                            {t('Delete')}
                                          </button>
                                        </>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {!readOnly && (
                          <form
                            className="ndb-add-row-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (!hashField.trim()) return;
                              void runMutation(async () => {
                                await driver.setHashField(detail.key, hashField.trim(), hashVal);
                                setHashField('');
                                setHashVal('');
                                await onSelectKey(detail.key);
                              }, 'Saved hash field');
                            }}
                          >
                            <div className="ndb-add-row-inputs">
                              <input type="text" className="ndb-mono" placeholder="field" value={hashField} onChange={(e) => setHashField(e.currentTarget.value)} />
                              <input type="text" className="ndb-mono" placeholder="value" value={hashVal} onChange={(e) => setHashVal(e.currentTarget.value)} />
                              <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={busy || !hashField.trim()}>
                                HSET
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    )}

                    {detail.type === 'list' && (
                      <div className="ndb-structure-scroll">
                        <table className="ndb-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Element</th>
                              {!readOnly && <th>Action</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {((detail.value as string[]) ?? []).map((item, idx) => {
                              const isEd = editingListIdx === idx;
                              return (
                                <tr key={`${idx}:${item}`}>
                                  <td className="ndb-mono ndb-muted">{idx}</td>
                                  <td className="ndb-mono">
                                    {isEd ? (
                                      <input
                                        type="text"
                                        className="ndb-mono ndb-input-compact"
                                        value={editingListVal}
                                        onChange={(e) => setEditingListVal(e.currentTarget.value)}
                                      />
                                    ) : (
                                      item
                                    )}
                                  </td>
                                  {!readOnly && (
                                    <td className="ndb-cell-actions">
                                      {isEd ? (
                                        <>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-primary ndb-btn-xs"
                                            disabled={busy}
                                            onClick={() =>
                                              void runMutation(async () => {
                                                await driver.setListIndex(detail.key, idx, editingListVal);
                                                setEditingListIdx(null);
                                                await onSelectKey(detail.key);
                                              }, `Updated list index ${idx}`)
                                            }
                                          >
                                            LSET
                                          </button>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                            onClick={() => setEditingListIdx(null)}
                                          >
                                            {t('Cancel')}
                                          </button>
                                        </>
                                      ) : (
                                        <>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                            disabled={busy}
                                            onClick={() => {
                                              setEditingListIdx(idx);
                                              setEditingListVal(item);
                                            }}
                                          >
                                            {t('Edit')}
                                          </button>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                                            disabled={busy}
                                            onClick={() =>
                                              void runMutation(async () => {
                                                await driver.removeListValue(detail.key, item, 1);
                                                await onSelectKey(detail.key);
                                              }, 'Removed element')
                                            }
                                          >
                                            LREM
                                          </button>
                                        </>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {!readOnly && (
                          <form
                            className="ndb-add-row-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (!listVal) return;
                              void runMutation(async () => {
                                await driver.pushList(detail.key, listVal, 'right');
                                setListVal('');
                                await onSelectKey(detail.key);
                              }, 'Appended to list');
                            }}
                          >
                            <div className="ndb-add-row-inputs">
                              <input type="text" className="ndb-mono" placeholder="new element" value={listVal} onChange={(e) => setListVal(e.currentTarget.value)} />
                              <button
                                type="button"
                                className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                                disabled={busy || !listVal}
                                onClick={() =>
                                  void runMutation(async () => {
                                    await driver.pushList(detail.key, listVal, 'left');
                                    setListVal('');
                                    await onSelectKey(detail.key);
                                  }, 'Prepended to list')
                                }
                              >
                                LPUSH
                              </button>
                              <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={busy || !listVal}>
                                RPUSH
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    )}

                    {detail.type === 'set' && (
                      <div className="ndb-structure-scroll">
                        <table className="ndb-table">
                          <thead>
                            <tr>
                              <th>Member</th>
                              {!readOnly && <th>Action</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {((detail.value as string[]) ?? []).map((member) => (
                              <tr key={member}>
                                <td className="ndb-mono">{member}</td>
                                {!readOnly && (
                                  <td>
                                    <button
                                      type="button"
                                      className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                                      disabled={busy}
                                      onClick={() =>
                                        void runMutation(async () => {
                                          await driver.removeSetMembers(detail.key, member);
                                          await onSelectKey(detail.key);
                                        }, 'Removed member')
                                      }
                                    >
                                      SREM
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!readOnly && (
                          <form
                            className="ndb-add-row-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (!setMember) return;
                              void runMutation(async () => {
                                await driver.addSetMembers(detail.key, setMember);
                                setSetMember('');
                                await onSelectKey(detail.key);
                              }, 'Added member');
                            }}
                          >
                            <div className="ndb-add-row-inputs">
                              <input type="text" className="ndb-mono" placeholder="member" value={setMember} onChange={(e) => setSetMember(e.currentTarget.value)} />
                              <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={busy || !setMember}>
                                SADD
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    )}

                    {detail.type === 'zset' && (
                      <div className="ndb-structure-scroll">
                        <table className="ndb-table">
                          <thead>
                            <tr>
                              <th>Score</th>
                              <th>Member</th>
                              {!readOnly && <th>Action</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {((detail.value as Array<{ member: string; score: number }>) ?? []).map((entry) => {
                              const isEd = editingZsetMember === entry.member;
                              return (
                                <tr key={entry.member}>
                                  <td className="ndb-mono">
                                    {isEd ? (
                                      <input
                                        type="number"
                                        className="ndb-mono ndb-input-xs"
                                        value={editingZsetScore}
                                        onChange={(e) => setEditingZsetScore(e.currentTarget.value)}
                                      />
                                    ) : (
                                      entry.score
                                    )}
                                  </td>
                                  <td className="ndb-mono">{entry.member}</td>
                                  {!readOnly && (
                                    <td className="ndb-cell-actions">
                                      {isEd ? (
                                        <>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-primary ndb-btn-xs"
                                            disabled={busy}
                                            onClick={() =>
                                              void runMutation(async () => {
                                                await driver.addZSetMember(detail.key, Number(editingZsetScore) || 0, entry.member);
                                                setEditingZsetMember(null);
                                                await onSelectKey(detail.key);
                                              }, 'Updated ZSet score')
                                            }
                                          >
                                            {t('Save')}
                                          </button>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                            onClick={() => setEditingZsetMember(null)}
                                          >
                                            {t('Cancel')}
                                          </button>
                                        </>
                                      ) : (
                                        <>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                            disabled={busy}
                                            onClick={() => {
                                              setEditingZsetMember(entry.member);
                                              setEditingZsetScore(String(entry.score));
                                            }}
                                          >
                                            {t('Edit')}
                                          </button>
                                          <button
                                            type="button"
                                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                                            disabled={busy}
                                            onClick={() =>
                                              void runMutation(async () => {
                                                await driver.removeZSetMembers(detail.key, entry.member);
                                                await onSelectKey(detail.key);
                                              }, 'Removed member')
                                            }
                                          >
                                            ZREM
                                          </button>
                                        </>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {!readOnly && (
                          <form
                            className="ndb-add-row-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (!zsetMember) return;
                              void runMutation(async () => {
                                await driver.addZSetMember(detail.key, Number(zsetScore) || 0, zsetMember);
                                setZsetMember('');
                                await onSelectKey(detail.key);
                              }, 'Updated sorted set');
                            }}
                          >
                            <div className="ndb-add-row-inputs">
                              <input type="number" className="ndb-mono ndb-input-xs" placeholder="score" value={zsetScore} onChange={(e) => setZsetScore(e.currentTarget.value)} />
                              <input type="text" className="ndb-mono" placeholder="member" value={zsetMember} onChange={(e) => setZsetMember(e.currentTarget.value)} />
                              <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={busy || !zsetMember}>
                                ZADD
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    )}

                    {detail.type === 'stream' && (
                      <div className="ndb-structure-scroll">
                        <table className="ndb-table">
                          <thead>
                            <tr>
                              <th>Stream ID</th>
                              <th>Fields</th>
                              {!readOnly && <th>Action</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {((detail.value as RedisStreamEntry[]) ?? []).map((entry) => (
                              <tr key={entry.id}>
                                <td className="ndb-mono"><strong>{entry.id}</strong></td>
                                <td className="ndb-mono">{JSON.stringify(entry.fields)}</td>
                                {!readOnly && (
                                  <td>
                                    <button
                                      type="button"
                                      className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                                      disabled={busy}
                                      onClick={() =>
                                        void runMutation(async () => {
                                          await driver.deleteStreamEntries(detail.key, entry.id);
                                          await onSelectKey(detail.key);
                                        }, 'Deleted stream entry')
                                      }
                                    >
                                      XDEL
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!readOnly && (
                          <form
                            className="ndb-add-row-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (!streamField.trim()) return;
                              void runMutation(async () => {
                                await driver.addStreamEntry(detail.key, { [streamField.trim()]: streamVal });
                                setStreamVal('');
                                await onSelectKey(detail.key);
                              }, 'Appended stream entry');
                            }}
                          >
                            <div className="ndb-add-row-inputs">
                              <input type="text" className="ndb-mono" placeholder="field" value={streamField} onChange={(e) => setStreamField(e.currentTarget.value)} />
                              <input type="text" className="ndb-mono" placeholder="value" value={streamVal} onChange={(e) => setStreamVal(e.currentTarget.value)} />
                              <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-sm" disabled={busy || !streamField.trim()}>
                                XADD *
                              </button>
                            </div>
                          </form>
                        )}

                        {driver.getStreamGroups && (
                          <div className="ndb-section-box" style={{ marginTop: '12px' }}>
                            <div className="ndb-inline-row" style={{ marginBottom: '6px' }}>
                              <strong>{`Consumer Groups (${streamGroups.length})`}</strong>
                              {streamGroupsLoading && <Icon name="loader" />}
                            </div>
                            {streamGroups.length === 0 ? (
                              <p className="ndb-muted">No consumer groups configured for this stream.</p>
                            ) : (
                              <table className="ndb-table">
                                <thead>
                                  <tr>
                                    <th>Group</th>
                                    <th>Consumers</th>
                                    <th>Pending</th>
                                    <th>Last Delivered ID</th>
                                    <th>Lag</th>
                                    <th>Inspect</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {streamGroups.map((g) => (
                                    <tr key={g.name}>
                                      <td className="ndb-mono"><strong>{g.name}</strong></td>
                                      <td className="ndb-mono">{g.consumers}</td>
                                      <td className="ndb-mono">{g.pending}</td>
                                      <td className="ndb-mono">{g.lastDeliveredId}</td>
                                      <td className="ndb-mono">{g.lag ?? '—'}</td>
                                      <td>
                                        <button
                                          type="button"
                                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                          onClick={() => void handleInspectStreamGroup(detail.key, g.name)}
                                        >
                                          {'Consumers & Pending'}
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}

                            {selectedStreamGroup && (
                              <div style={{ marginTop: '10px' }}>
                                <strong className="ndb-mono">{`Group: ${selectedStreamGroup}`}</strong>
                                <div style={{ marginTop: '6px' }}>
                                  <span className="ndb-muted">{`Consumers (${streamConsumers.length})`}</span>
                                  {streamConsumers.length > 0 && (
                                    <table className="ndb-table">
                                      <thead>
                                        <tr>
                                          <th>Consumer</th>
                                          <th>Pending</th>
                                          <th>Idle (ms)</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {streamConsumers.map((c) => (
                                          <tr key={c.name}>
                                            <td className="ndb-mono">{c.name}</td>
                                            <td className="ndb-mono">{c.pending}</td>
                                            <td className="ndb-mono">{c.idleMs}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                                <div style={{ marginTop: '6px' }}>
                                  <span className="ndb-muted">{`Pending Entries (${streamPending.length})`}</span>
                                  {streamPending.length > 0 && (
                                    <table className="ndb-table">
                                      <thead>
                                        <tr>
                                          <th>Entry ID</th>
                                          <th>Consumer</th>
                                          <th>Idle (ms)</th>
                                          <th>Deliveries</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {streamPending.map((p) => (
                                          <tr key={p.id}>
                                            <td className="ndb-mono">{p.id}</td>
                                            <td className="ndb-mono">{p.consumer}</td>
                                            <td className="ndb-mono">{p.idleMs}</td>
                                            <td className="ndb-mono">{p.deliveryCount}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </PluginSplitPane>
        </div>
      )}

      {/* Collapsible Interactive Redis CLI Console with Up/Down history */}
      {tab.showCli && (
        <div className="ndb-redis-cli">
          <div className="ndb-redis-cli-head">
            <strong className="ndb-mono">{`redis:${tab.db}> CLI`}</strong>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
              onClick={() => onUpdateTab({ cliHistory: [] })}
            >
              {t('Clear')}
            </button>
            <button
              type="button"
              className="ndb-icon-btn"
              onClick={() => onUpdateTab({ showCli: false })}
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="ndb-redis-cli-log ndb-mono">
            {tab.cliHistory.map((item, i) => (
              <div key={i} className="ndb-cli-entry">
                <div className="ndb-cli-cmd">{`> ${item.command}${item.args.length ? ' ' + item.args.join(' ') : ''}`}</div>
                <pre className={item.isError ? 'ndb-cli-err' : 'ndb-cli-out'}>{item.formatted}</pre>
              </div>
            ))}
          </div>
          <form className="ndb-redis-cli-input" onSubmit={(e) => void handleCliSubmit(e)}>
            <span className="ndb-mono ndb-primary-text">{`db${tab.db}>`}</span>
            <input
              type="text"
              className="ndb-mono"
              placeholder="PING, GET mykey, INFO server, KEYS * (↑/↓ history)"
              value={tab.cliInput}
              onKeyDown={handleCliKeyDown}
              onChange={(e) => onUpdateTab({ cliInput: e.currentTarget.value })}
            />
            <button type="submit" className="ndb-btn ndb-btn-primary ndb-btn-xs">
              {t('Run')}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
