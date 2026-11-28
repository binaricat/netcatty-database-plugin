/**
 * Registry & Config KV Specialist Workbench Tab:
 * Supports etcd v3, etcd v2, Consul, and Nacos.
 * - Keys CRUD & value editor (PluginCodeEditor)
 * - etcd v3/v2: Cluster Members, Leases (list/revoke), Watch/Poll feed, RBAC users/roles
 * - Consul: Services, Health Checks, Sessions (list/destroy), ACL / Overview
 * - Nacos: Config History & Diff, Services, Content Search & Replace, Namespaces CRUD
 * - Borderless Monitor-style, zero inline svg/canvas, zero node:* imports
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PluginCodeEditor,
  PluginSplitPane,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import {
  computeSimpleLineDiff,
  type ConsulHealthCheckInfo,
  type ConsulSessionInfo,
} from '../../drivers/kvHttpDriver';
import type {
  KvConfigHistoryEntry,
  KvDriver,
  KvEntry,
  KvLeaseInfo,
  KvMemberInfo,
  KvNamespaceInfo,
  KvServiceInfo,
} from '../../drivers/types';
import type { KvWorkbenchTabState } from '../types';

export interface KvWorkbenchTabProps {
  tab: KvWorkbenchTabState;
  driver: KvDriver;
  readOnly?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<KvWorkbenchTabState>) => void;
  onReload: (prefixOverride?: string) => Promise<void>;
  onSelectKey: (entry: KvEntry) => Promise<void>;
  onNotify: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

type ExtendedKvDriver = KvDriver & {
  revokeLease?: (id: string) => Promise<void>;
  listEtcdRbac?: () => Promise<{ users: string[]; roles: string[] }>;
  manageEtcdRbac?: (
    action: 'user_add' | 'user_delete' | 'role_add' | 'role_delete',
    name: string,
    password?: string,
  ) => Promise<void>;
  listConsulHealthChecks?: () => Promise<ConsulHealthCheckInfo[]>;
  listConsulSessions?: () => Promise<ConsulSessionInfo[]>;
  destroyConsulSession?: (sessionId: string) => Promise<void>;
  getConsulAclOverview?: () => Promise<{
    enabled: boolean;
    tokens: Array<Record<string, unknown>>;
    policies: Array<Record<string, unknown>>;
    note?: string;
  }>;
  createNamespace?: (namespaceId: string, namespaceName: string, description?: string) => Promise<void>;
  deleteNamespace?: (namespaceId: string) => Promise<void>;
};

type KvSubTab =
  | 'keys'
  | 'members'
  | 'leases'
  | 'watch'
  | 'rbac'
  | 'services'
  | 'health'
  | 'sessions'
  | 'acl'
  | 'history'
  | 'search_replace'
  | 'namespaces';

interface WatchEvent {
  ts: number;
  kind: 'PUT' | 'MODIFY' | 'DELETE';
  key: string;
  value?: string;
}

export function KvWorkbenchTab({
  tab,
  driver,
  readOnly = false,
  t,
  onUpdateTab,
  onReload,
  onSelectKey,
  onNotify,
  onShortcut,
}: KvWorkbenchTabProps) {
  const extDriver = driver as ExtendedKvDriver;
  const isEtcdV3 = driver.engine === 'etcd';
  const isEtcdAny = driver.engine === 'etcd' || driver.engine === 'etcd-v2';
  const isConsul = driver.engine === 'consul';
  const isNacos = driver.engine === 'nacos';

  const [subTab, setSubTab] = useState<KvSubTab>('keys');
  const [editValue, setEditValue] = useState(tab.selectedEntry?.value ?? '');
  const [showNew, setShowNew] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [busy, setBusy] = useState(false);

  // etcd / cluster state
  const [members, setMembers] = useState<KvMemberInfo[]>([]);
  const [clusterStatus, setClusterStatus] = useState<Record<string, unknown> | null>(null);
  const [leases, setLeases] = useState<KvLeaseInfo[]>([]);
  const [rbacData, setRbacData] = useState<{ users: string[]; roles: string[] }>({ users: [], roles: [] });
  const [rbacNewUser, setRbacNewUser] = useState('');
  const [rbacNewPass, setRbacNewPass] = useState('');
  const [rbacNewRole, setRbacNewRole] = useState('');

  // Watch / Poll
  const [watchRunning, setWatchRunning] = useState(false);
  const [watchPrefix, setWatchPrefix] = useState(tab.prefix || '');
  const [watchEvents, setWatchEvents] = useState<WatchEvent[]>([]);
  const watchSnapRef = useRef<Map<string, string>>(new Map());

  // Consul state
  const [services, setServices] = useState<KvServiceInfo[]>([]);
  const [healthChecks, setHealthChecks] = useState<ConsulHealthCheckInfo[]>([]);
  const [sessions, setSessions] = useState<ConsulSessionInfo[]>([]);
  const [aclOverview, setAclOverview] = useState<{
    enabled: boolean;
    tokens: Array<Record<string, unknown>>;
    policies: Array<Record<string, unknown>>;
    note?: string;
  } | null>(null);

  // Nacos History & Diff, Search & Replace, Namespaces CRUD
  const [historyEntries, setHistoryEntries] = useState<KvConfigHistoryEntry[]>([]);
  const [diffHistoryId, setDiffHistoryId] = useState<string | null>(null);
  const [contentFind, setContentFind] = useState('');
  const [contentReplace, setContentReplace] = useState('');
  const [namespaces, setNamespaces] = useState<KvNamespaceInfo[]>([]);
  const [newNsId, setNewNsId] = useState('');
  const [newNsName, setNewNsName] = useState('');
  const [newNsDesc, setNewNsDesc] = useState('');

  useEffect(() => {
    setEditValue(tab.selectedEntry?.value ?? '');
  }, [tab.selectedEntry]);

  // Watch/Poll timer
  useEffect(() => {
    if (!watchRunning) return;
    let active = true;
    const poll = async () => {
      try {
        const list = await driver.listKeys(watchPrefix, { namespace: tab.namespace || undefined });
        if (!active) return;
        const nextMap = new Map(list.map((e) => [e.key, e.value]));
        const prev = watchSnapRef.current;
        if (prev.size > 0) {
          const events: WatchEvent[] = [];
          const now = Date.now();
          for (const [k, v] of nextMap.entries()) {
            if (!prev.has(k)) {
              events.push({ ts: now, kind: 'PUT', key: k, value: v });
            } else if (prev.get(k) !== v) {
              events.push({ ts: now, kind: 'MODIFY', key: k, value: v });
            }
          }
          for (const k of prev.keys()) {
            if (!nextMap.has(k)) {
              events.push({ ts: now, kind: 'DELETE', key: k });
            }
          }
          if (events.length > 0) {
            setWatchEvents((old) => [...events, ...old].slice(0, 200));
          }
        }
        watchSnapRef.current = nextMap;
      } catch {
        // ignore transient poll errors
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [watchRunning, watchPrefix, driver, tab.namespace]);

  const loadMembers = async () => {
    setBusy(true);
    try {
      const [m, st] = await Promise.all([
        driver.listMembers ? driver.listMembers() : Promise.resolve([]),
        driver.getClusterStatus ? driver.getClusterStatus() : Promise.resolve(null),
      ]);
      setMembers(m);
      setClusterStatus(st);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadLeases = async () => {
    if (!driver.listLeases) return;
    setBusy(true);
    try {
      setLeases(await driver.listLeases());
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadRbac = async () => {
    if (!extDriver.listEtcdRbac) return;
    setBusy(true);
    try {
      setRbacData(await extDriver.listEtcdRbac());
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadServices = async () => {
    if (!driver.listServices) return;
    setBusy(true);
    try {
      setServices(await driver.listServices({ namespace: tab.namespace || undefined }));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadHealthChecks = async () => {
    if (!extDriver.listConsulHealthChecks) return;
    setBusy(true);
    try {
      setHealthChecks(await extDriver.listConsulHealthChecks());
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadSessions = async () => {
    if (!extDriver.listConsulSessions) return;
    setBusy(true);
    try {
      setSessions(await extDriver.listConsulSessions());
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadAclOverview = async () => {
    setBusy(true);
    try {
      const [acl, status] = await Promise.all([
        extDriver.getConsulAclOverview ? extDriver.getConsulAclOverview() : Promise.resolve(null),
        driver.getClusterStatus ? driver.getClusterStatus() : Promise.resolve(null),
      ]);
      setAclOverview(acl);
      setClusterStatus(status);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadConfigHistory = async () => {
    if (!driver.getConfigHistory || !tab.selectedEntry) return;
    setBusy(true);
    try {
      const list = await driver.getConfigHistory(tab.selectedEntry.key, {
        namespace: tab.namespace || undefined,
        group: tab.selectedEntry.group,
      });
      setHistoryEntries(list);
      setDiffHistoryId(list[0]?.id ?? null);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadNamespaces = async () => {
    setBusy(true);
    try {
      setNamespaces(await driver.listNamespaces());
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const contentSearchMatches = useMemo(() => {
    const q = contentFind.trim();
    if (!q) return [] as KvEntry[];
    return tab.entries.filter((e) => e.value.includes(q));
  }, [tab.entries, contentFind]);

  const diffTargetEntry = useMemo(
    () => historyEntries.find((h) => h.id === diffHistoryId) ?? null,
    [historyEntries, diffHistoryId],
  );

  const diffLines = useMemo(() => {
    if (!diffTargetEntry || !tab.selectedEntry) return [];
    return computeSimpleLineDiff(diffTargetEntry.value, tab.selectedEntry.value);
  }, [diffTargetEntry, tab.selectedEntry]);

  const handleSaveValue = async () => {
    if (!tab.selectedEntry) return;
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    setBusy(true);
    try {
      await driver.putKey(tab.selectedEntry.key, editValue, {
        namespace: tab.namespace || undefined,
        group: tab.selectedEntry.group,
        format: tab.selectedEntry.format,
      });
      onNotify('success', `Saved ${tab.selectedEntry.key}`);
      await onReload();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateKey = async () => {
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    const key = newKey.trim();
    if (!key) return;
    setBusy(true);
    try {
      await driver.putKey(key, newValue, { namespace: tab.namespace || undefined });
      onNotify('success', `Created ${key}`);
      setShowNew(false);
      setNewKey('');
      setNewValue('');
      await onReload();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteKey = async (entry: KvEntry) => {
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    setBusy(true);
    try {
      await driver.deleteKey(entry.key, {
        namespace: tab.namespace || undefined,
        group: entry.group,
      });
      onNotify('success', `Deleted ${entry.key}`);
      onUpdateTab({ selectedKey: null, selectedEntry: null });
      await onReload();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleNacosReplaceAll = async () => {
    if (readOnly || !contentFind.trim() || contentSearchMatches.length === 0) return;
    setBusy(true);
    try {
      let updated = 0;
      for (const entry of contentSearchMatches) {
        const nextVal = entry.value.split(contentFind).join(contentReplace);
        await driver.putKey(entry.key, nextVal, {
          namespace: tab.namespace || undefined,
          group: entry.group,
          format: entry.format,
        });
        updated++;
      }
      onNotify('success', `Updated ${updated} config(s)`);
      await onReload();
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
          <span className="ndb-context-chip ndb-mono">
            {`${driver.engine}${tab.namespace ? ` / ${tab.namespace}` : ''}`}
          </span>

          <div className="ndb-segmented">
            <button
              type="button"
              className={subTab === 'keys' ? 'is-active' : ''}
              onClick={() => setSubTab('keys')}
            >
              {'Keys'}
            </button>

            {isEtcdAny && (
              <button
                type="button"
                className={subTab === 'members' ? 'is-active' : ''}
                onClick={() => {
                  setSubTab('members');
                  void loadMembers();
                }}
              >
                {'Members'}
              </button>
            )}
            {isEtcdV3 && (
              <>
                <button
                  type="button"
                  className={subTab === 'leases' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('leases');
                    void loadLeases();
                  }}
                >
                  {'Leases'}
                </button>
                <button
                  type="button"
                  className={subTab === 'watch' ? 'is-active' : ''}
                  onClick={() => setSubTab('watch')}
                >
                  {'Watch'}
                  {watchRunning && <span className="ndb-online-dot" />}
                </button>
                <button
                  type="button"
                  className={subTab === 'rbac' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('rbac');
                    void loadRbac();
                  }}
                >
                  {'RBAC'}
                </button>
              </>
            )}

            {isConsul && (
              <>
                <button
                  type="button"
                  className={subTab === 'services' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('services');
                    void loadServices();
                  }}
                >
                  {'Services'}
                </button>
                <button
                  type="button"
                  className={subTab === 'health' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('health');
                    void loadHealthChecks();
                  }}
                >
                  {'Health'}
                </button>
                <button
                  type="button"
                  className={subTab === 'sessions' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('sessions');
                    void loadSessions();
                  }}
                >
                  {'Sessions'}
                </button>
                <button
                  type="button"
                  className={subTab === 'acl' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('acl');
                    void loadAclOverview();
                  }}
                >
                  {'ACL / Overview'}
                </button>
              </>
            )}

            {isNacos && (
              <>
                <button
                  type="button"
                  className={subTab === 'history' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('history');
                    void loadConfigHistory();
                  }}
                >
                  {'History & Diff'}
                </button>
                <button
                  type="button"
                  className={subTab === 'services' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('services');
                    void loadServices();
                  }}
                >
                  {'Services'}
                </button>
                <button
                  type="button"
                  className={subTab === 'search_replace' ? 'is-active' : ''}
                  onClick={() => setSubTab('search_replace')}
                >
                  {'Search & Replace'}
                </button>
                <button
                  type="button"
                  className={subTab === 'namespaces' ? 'is-active' : ''}
                  onClick={() => {
                    setSubTab('namespaces');
                    void loadNamespaces();
                  }}
                >
                  {'Namespaces'}
                </button>
              </>
            )}
          </div>

          {subTab === 'keys' && (
            <>
              <div className="ndb-compact-search">
                <Icon name="search" />
                <input
                  type="text"
                  placeholder={t('Filter key prefix...')}
                  value={tab.prefix}
                  onChange={(e) => onUpdateTab({ prefix: e.currentTarget.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onReload();
                  }}
                />
              </div>
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                disabled={tab.loading}
                onClick={() => void onReload()}
              >
                <Icon name={tab.loading ? 'loader' : 'refresh'} />
                {t('Scan')}
              </button>
            </>
          )}
        </div>

        <div className="ndb-spacer" />

        {subTab === 'keys' && !readOnly && (
          <button
            type="button"
            className="ndb-btn ndb-btn-primary ndb-btn-sm"
            onClick={() => setShowNew((v) => !v)}
          >
            <Icon name="plus" />
            {t('New Key')}
          </button>
        )}
      </div>

      {tab.error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      {showNew && subTab === 'keys' && (
        <div className="ndb-inline-panel">
          <div className="ndb-toolbar-group">
            <input
              type="text"
              className="ndb-input ndb-mono"
              placeholder="/config/service/key"
              value={newKey}
              onChange={(e) => setNewKey(e.currentTarget.value)}
            />
            <input
              type="text"
              className="ndb-input ndb-mono"
              placeholder="Value"
              value={newValue}
              onChange={(e) => setNewValue(e.currentTarget.value)}
            />
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={busy}
              onClick={() => void handleCreateKey()}
            >
              {t('Save')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              onClick={() => setShowNew(false)}
            >
              {t('Cancel')}
            </button>
          </div>
        </div>
      )}

      {subTab === 'keys' && (
        <div className="ndb-split-host">
          <PluginSplitPane direction="horizontal" initialSize={280} minSize={180} maxSize={520}>
            <div className="ndb-kv-list">
              {tab.entries.map((entry) => (
                <button
                  key={`${entry.group ?? ''}:${entry.key}`}
                  type="button"
                  className={`ndb-kv-item${tab.selectedKey === entry.key ? ' active' : ''}`}
                  onClick={() => void onSelectKey(entry)}
                >
                  <span className="ndb-kv-item-key ndb-mono">{entry.key}</span>
                  {entry.group && <span className="ndb-tag ndb-mono">{entry.group}</span>}
                </button>
              ))}
              {tab.entries.length === 0 && !tab.loading && (
                <div className="ndb-empty-center">
                  <p className="ndb-muted">{t('No keys found.')}</p>
                </div>
              )}
            </div>

            <div className="ndb-kv-detail">
              {tab.selectedEntry ? (
                <>
                  <div className="ndb-subtoolbar">
                    <strong className="ndb-mono">{tab.selectedEntry.key}</strong>
                    {tab.selectedEntry.revision !== undefined && (
                      <span className="ndb-tag ndb-mono">{`rev ${tab.selectedEntry.revision}`}</span>
                    )}
                    <div className="ndb-spacer" />
                    {!readOnly && (
                      <>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-primary ndb-btn-sm"
                          disabled={busy}
                          onClick={() => void handleSaveValue()}
                        >
                          {t('Save')}
                        </button>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-sm ndb-text-danger"
                          disabled={busy}
                          onClick={() => void handleDeleteKey(tab.selectedEntry!)}
                        >
                          {t('Delete')}
                        </button>
                      </>
                    )}
                  </div>
                  <div className="ndb-editor-pane">
                    <PluginCodeEditor
                      value={editValue}
                      language={
                        tab.selectedEntry.format === 'json' || editValue.trim().startsWith('{')
                          ? 'json'
                          : 'plaintext'
                      }
                      readOnly={readOnly}
                      lineNumbers="on"
                      minimap={false}
                      wordWrap="on"
                      onChange={(d) => setEditValue(d.value)}
                      onShortcut={onShortcut}
                    />
                  </div>
                </>
              ) : (
                <div className="ndb-empty-center">
                  <p className="ndb-muted">{t('Select a key on the left to inspect or edit its value.')}</p>
                </div>
              )}
            </div>
          </PluginSplitPane>
        </div>
      )}

      {subTab === 'members' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Cluster Members (${members.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadMembers()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Client URLs</th>
                <th>Peer URLs</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="ndb-mono">{m.id}</td>
                  <td className="ndb-mono"><strong>{m.name}</strong></td>
                  <td className="ndb-mono">{(m.clientUrls ?? []).join(', ') || '—'}</td>
                  <td className="ndb-mono ndb-muted">{(m.peerUrls ?? []).join(', ') || '—'}</td>
                  <td className="ndb-mono">{m.status || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {clusterStatus && (
            <pre className="ndb-code-pre ndb-mono" style={{ marginTop: '10px' }}>
              {JSON.stringify(clusterStatus, null, 2)}
            </pre>
          )}
        </div>
      )}

      {subTab === 'leases' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Active Leases (${leases.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadLeases()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>Lease ID</th>
                <th>TTL (s)</th>
                <th>Granted TTL</th>
                <th>Attached Keys</th>
                {!readOnly && extDriver.revokeLease && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {leases.map((l) => (
                <tr key={l.id}>
                  <td className="ndb-mono"><strong>{l.id}</strong></td>
                  <td className="ndb-mono">{l.ttlSeconds ?? '—'}</td>
                  <td className="ndb-mono ndb-muted">{l.grantedTtlSeconds ?? '—'}</td>
                  <td className="ndb-mono">{(l.keys ?? []).join(', ') || '—'}</td>
                  {!readOnly && extDriver.revokeLease && (
                    <td>
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await extDriver.revokeLease!(l.id);
                            onNotify('success', `Revoked lease ${l.id}`);
                            await loadLeases();
                          } catch (err) {
                            onNotify('error', err instanceof Error ? err.message : String(err));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {'Revoke'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'watch' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '6px' }}>
            <strong>{'Prefix Watch / Poll'}</strong>
            <input
              type="text"
              className="ndb-mono ndb-input-compact"
              placeholder="/prefix/"
              value={watchPrefix}
              onChange={(e) => setWatchPrefix(e.currentTarget.value)}
            />
            <button
              type="button"
              className={`ndb-btn ndb-btn-xs ${watchRunning ? 'ndb-btn-danger' : 'ndb-btn-primary'}`}
              onClick={() => {
                if (!watchRunning) watchSnapRef.current = new Map();
                setWatchRunning((v) => !v);
              }}
            >
              {watchRunning ? 'Stop Watch' : 'Start Watch'}
            </button>
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setWatchEvents([])}>
              {t('Clear')}
            </button>
          </div>
          {watchEvents.length === 0 ? (
            <p className="ndb-muted">
              {watchRunning ? 'Polling prefix every 3s for PUT / MODIFY / DELETE changes...' : 'Start watch to track key changes.'}
            </p>
          ) : (
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Key</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {watchEvents.map((ev, i) => (
                  <tr key={i}>
                    <td className="ndb-mono ndb-muted">{new Date(ev.ts).toLocaleTimeString()}</td>
                    <td>
                      <span className={`ndb-tag ndb-mono ${ev.kind === 'DELETE' ? 'ndb-tag-danger' : 'ndb-tag-ok'}`}>
                        {ev.kind}
                      </span>
                    </td>
                    <td className="ndb-mono">{ev.key}</td>
                    <td className="ndb-mono ndb-muted">{ev.value ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {subTab === 'rbac' && (
        <div className="ndb-structure-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="ndb-inline-row">
            <strong>{`etcd RBAC (${rbacData.users.length} users · ${rbacData.roles.length} roles)`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadRbac()}>
              {t('Refresh')}
            </button>
          </div>
          <div className="ndb-section-box">
            <strong>{'Users'}</strong>
            <div className="ndb-inline-row" style={{ flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
              {rbacData.users.map((u) => (
                <span key={u} className="ndb-tag ndb-mono">
                  {u}
                  {!readOnly && extDriver.manageEtcdRbac && (
                    <button
                      type="button"
                      className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                      onClick={async () => {
                        await extDriver.manageEtcdRbac!('user_delete', u);
                        await loadRbac();
                      }}
                    >
                      {'x'}
                    </button>
                  )}
                </span>
              ))}
            </div>
            {!readOnly && extDriver.manageEtcdRbac && (
              <div className="ndb-inline-row" style={{ marginTop: '8px', gap: '6px' }}>
                <input type="text" className="ndb-mono ndb-input-compact" placeholder="username" value={rbacNewUser} onChange={(e) => setRbacNewUser(e.currentTarget.value)} />
                <input type="password" className="ndb-mono ndb-input-compact" placeholder="password" value={rbacNewPass} onChange={(e) => setRbacNewPass(e.currentTarget.value)} />
                <button
                  type="button"
                  className="ndb-btn ndb-btn-primary ndb-btn-xs"
                  disabled={busy || !rbacNewUser.trim()}
                  onClick={async () => {
                    await extDriver.manageEtcdRbac!('user_add', rbacNewUser.trim(), rbacNewPass);
                    setRbacNewUser('');
                    setRbacNewPass('');
                    await loadRbac();
                  }}
                >
                  {'Add User'}
                </button>
              </div>
            )}
          </div>

          <div className="ndb-section-box">
            <strong>{'Roles'}</strong>
            <div className="ndb-inline-row" style={{ flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
              {rbacData.roles.map((r) => (
                <span key={r} className="ndb-tag ndb-mono">
                  {r}
                  {!readOnly && extDriver.manageEtcdRbac && (
                    <button
                      type="button"
                      className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                      onClick={async () => {
                        await extDriver.manageEtcdRbac!('role_delete', r);
                        await loadRbac();
                      }}
                    >
                      {'x'}
                    </button>
                  )}
                </span>
              ))}
            </div>
            {!readOnly && extDriver.manageEtcdRbac && (
              <div className="ndb-inline-row" style={{ marginTop: '8px', gap: '6px' }}>
                <input type="text" className="ndb-mono ndb-input-compact" placeholder="role name" value={rbacNewRole} onChange={(e) => setRbacNewRole(e.currentTarget.value)} />
                <button
                  type="button"
                  className="ndb-btn ndb-btn-primary ndb-btn-xs"
                  disabled={busy || !rbacNewRole.trim()}
                  onClick={async () => {
                    await extDriver.manageEtcdRbac!('role_add', rbacNewRole.trim());
                    setRbacNewRole('');
                    await loadRbac();
                  }}
                >
                  {'Add Role'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'services' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Services (${services.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadServices()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Namespace / Group</th>
                <th>Tags</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={`${s.group ?? ''}:${s.name}`}>
                  <td className="ndb-mono"><strong>{s.name}</strong></td>
                  <td className="ndb-mono ndb-muted">{[s.namespace, s.group].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="ndb-mono">{(s.tags ?? []).join(', ') || '—'}</td>
                  <td className="ndb-mono">{s.status || 'active'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'health' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Consul Health Checks (${healthChecks.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadHealthChecks()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>Check</th>
                <th>Status</th>
                <th>Service</th>
                <th>Node</th>
                <th>Output</th>
              </tr>
            </thead>
            <tbody>
              {healthChecks.map((c) => (
                <tr key={`${c.node}:${c.checkId}`}>
                  <td className="ndb-mono"><strong>{c.name}</strong></td>
                  <td>
                    <span className={`ndb-tag ndb-mono ${c.status === 'passing' ? 'ndb-tag-ok' : c.status === 'warning' ? 'ndb-tag-warn' : 'ndb-tag-danger'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="ndb-mono">{c.serviceName || '—'}</td>
                  <td className="ndb-mono">{c.node}</td>
                  <td className="ndb-mono ndb-muted">{c.output || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'sessions' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Consul Sessions (${sessions.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadSessions()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Node</th>
                <th>Behavior</th>
                <th>TTL</th>
                {!readOnly && extDriver.destroyConsulSession && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="ndb-mono">{s.id}</td>
                  <td className="ndb-mono">{s.name || '—'}</td>
                  <td className="ndb-mono">{s.node || '—'}</td>
                  <td className="ndb-mono">{s.behavior || '—'}</td>
                  <td className="ndb-mono">{s.ttl || '—'}</td>
                  {!readOnly && extDriver.destroyConsulSession && (
                    <td>
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                        disabled={busy}
                        onClick={async () => {
                          await extDriver.destroyConsulSession!(s.id);
                          onNotify('success', `Destroyed session ${s.id}`);
                          await loadSessions();
                        }}
                      >
                        {'Destroy'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'acl' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{'Consul ACL & Cluster Overview'}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadAclOverview()}>
              {t('Refresh')}
            </button>
          </div>
          {aclOverview?.note && <p className="ndb-text-amber">{aclOverview.note}</p>}
          <pre className="ndb-code-pre ndb-mono">
            {JSON.stringify({ clusterStatus, acl: aclOverview }, null, 2)}
          </pre>
        </div>
      )}

      {subTab === 'history' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>
              {tab.selectedEntry
                ? `Config History & Diff: ${tab.selectedEntry.key}`
                : 'Select a config in Keys tab first to view history'}
            </strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy || !tab.selectedEntry} onClick={() => void loadConfigHistory()}>
              {t('Refresh')}
            </button>
          </div>
          {historyEntries.length > 0 && (
            <table className="ndb-table" style={{ marginBottom: '10px' }}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Op</th>
                  <th>Updated</th>
                  <th>MD5</th>
                  <th>Diff</th>
                </tr>
              </thead>
              <tbody>
                {historyEntries.map((h) => (
                  <tr key={h.id}>
                    <td className="ndb-mono">{h.id}</td>
                    <td className="ndb-mono">{h.opType || '—'}</td>
                    <td className="ndb-mono ndb-muted">{h.updatedAt || '—'}</td>
                    <td className="ndb-mono ndb-muted">{h.md5 || '—'}</td>
                    <td>
                      <button
                        type="button"
                        className={`ndb-btn ndb-btn-xs ${diffHistoryId === h.id ? 'ndb-btn-primary' : 'ndb-btn-ghost'}`}
                        onClick={() => setDiffHistoryId(h.id)}
                      >
                        {'Compare'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {diffLines.length > 0 && (
            <pre className="ndb-code-pre ndb-mono">
              {diffLines
                .map((l) => `${l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' '} ${l.text}`)
                .join('\n')}
            </pre>
          )}
        </div>
      )}

      {subTab === 'search_replace' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '6px' }}>
            <input
              type="text"
              className="ndb-mono ndb-input-compact"
              placeholder="Find in config content..."
              value={contentFind}
              onChange={(e) => setContentFind(e.currentTarget.value)}
            />
            <input
              type="text"
              className="ndb-mono ndb-input-compact"
              placeholder="Replace with..."
              value={contentReplace}
              onChange={(e) => setContentReplace(e.currentTarget.value)}
            />
            <span className="ndb-tag ndb-mono">{`${contentSearchMatches.length} matched`}</span>
            {!readOnly && (
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-xs"
                disabled={busy || !contentFind.trim() || contentSearchMatches.length === 0}
                onClick={() => void handleNacosReplaceAll()}
              >
                {'Replace All'}
              </button>
            )}
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>Data ID</th>
                <th>Group</th>
                <th>Preview</th>
              </tr>
            </thead>
            <tbody>
              {contentSearchMatches.map((m) => (
                <tr key={`${m.group ?? ''}:${m.key}`}>
                  <td className="ndb-mono"><strong>{m.key}</strong></td>
                  <td className="ndb-mono">{m.group || 'DEFAULT_GROUP'}</td>
                  <td className="ndb-mono ndb-muted">{m.value.slice(0, 120)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'namespaces' && (
        <div className="ndb-structure-scroll">
          <div className="ndb-inline-row" style={{ marginBottom: '8px' }}>
            <strong>{`Nacos Namespaces (${namespaces.length})`}</strong>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-xs" disabled={busy} onClick={() => void loadNamespaces()}>
              {t('Refresh')}
            </button>
          </div>
          <table className="ndb-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Configs</th>
                {!readOnly && extDriver.deleteNamespace && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {namespaces.map((ns) => (
                <tr key={ns.id || 'public'}>
                  <td className="ndb-mono">{ns.id || '(public)'}</td>
                  <td className="ndb-mono"><strong>{ns.name}</strong></td>
                  <td className="ndb-mono">{ns.count ?? '—'}</td>
                  {!readOnly && extDriver.deleteNamespace && (
                    <td>
                      {ns.id && (
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                          disabled={busy}
                          onClick={async () => {
                            await extDriver.deleteNamespace!(ns.id);
                            onNotify('success', `Deleted namespace ${ns.name}`);
                            await loadNamespaces();
                          }}
                        >
                          {'Delete'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!readOnly && extDriver.createNamespace && (
            <div className="ndb-inline-row" style={{ marginTop: '10px', gap: '6px' }}>
              <input type="text" className="ndb-mono ndb-input-compact" placeholder="namespaceId" value={newNsId} onChange={(e) => setNewNsId(e.currentTarget.value)} />
              <input type="text" className="ndb-mono ndb-input-compact" placeholder="display name" value={newNsName} onChange={(e) => setNewNsName(e.currentTarget.value)} />
              <input type="text" className="ndb-mono ndb-input-compact" placeholder="description" value={newNsDesc} onChange={(e) => setNewNsDesc(e.currentTarget.value)} />
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-xs"
                disabled={busy || !newNsName.trim()}
                onClick={async () => {
                  await extDriver.createNamespace!(newNsId.trim(), newNsName.trim(), newNsDesc.trim());
                  setNewNsId('');
                  setNewNsName('');
                  setNewNsDesc('');
                  onNotify('success', 'Created namespace');
                  await loadNamespaces();
                }}
              >
                {'Create Namespace'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="ndb-result-strip ndb-mono">
        <span>{`${tab.entries.length} keys`}</span>
        <span className="ndb-spacer" />
        <span className="ndb-muted">{driver.serverVersion}</span>
      </div>
    </div>
  );
}
