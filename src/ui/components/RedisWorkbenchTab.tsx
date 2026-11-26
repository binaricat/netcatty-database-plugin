/**
 * Redis Specialist Workbench Tab:
 * - DB 0..15 switcher with keyspace counts, MATCH filter, Tree (:) vs Flat toggle,
 *   + New Key dialog, Server Info inspector, and collapsible interactive Redis CLI terminal
 * - Structured CRUD editor for all 6 Redis data types:
 *   String (plain/JSON Monaco), Hash, List, Set, ZSet, Stream + TTL / Persist / Rename / Delete
 */

import React, { useMemo, useState } from 'react';
import { PluginCodeEditor, PluginSplitPane } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type {
  RedisDriver,
  RedisKeyEntry,
  RedisKeyType,
  RedisNamespaceNode,
  RedisStreamEntry,
} from '../../drivers/types';
import { formatTtl } from '../i18n';
import type { RedisWorkbenchTabState } from '../types';

export interface RedisWorkbenchTabProps {
  tab: RedisWorkbenchTabState;
  driver: RedisDriver;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<RedisWorkbenchTabState>) => void;
  onScan: (opts?: { db?: number; match?: string }) => Promise<void>;
  onSelectKey: (key: string) => Promise<void>;
  onNotify: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
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
  t,
  onUpdateTab,
  onScan,
  onSelectKey,
  onNotify,
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
  const [listVal, setListVal] = useState('');
  const [setMember, setSetMember] = useState('');
  const [zsetMember, setZsetMember] = useState('');
  const [zsetScore, setZsetScore] = useState('1');
  const [streamField, setStreamField] = useState('event');
  const [streamVal, setStreamVal] = useState('');
  const [busy, setBusy] = useState(false);

  const keyspaceCounts = useMemo(
    () => new Map((tab.info?.keyspace ?? []).map((k) => [k.db, k.keys])),
    [tab.info],
  );

  const treeNodes = useMemo(
    () => driver.buildNamespaceTree(tab.keys, ':'),
    [driver, tab.keys],
  );

  const detail = tab.keyDetail;
  const activeStringValue =
    detail?.type === 'string' ? (stringDraft ?? String(detail.value ?? '')) : '';

  const runMutation = async (fn: () => Promise<void>, successMsg: string) => {
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
    onUpdateTab({ cliInput: '' });
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

  const renderTreeNode = (node: RedisNamespaceNode, depth = 0): React.ReactNode => {
    if (node.isLeaf && node.key) {
      return renderKeyRow(node.key, node.name, depth);
    }
    const open = expandedFolders[node.fullPath] ?? depth === 0;
    return (
      <div key={`ns:${node.fullPath}`}>
        <button
          type="button"
          className="dbx-tree-row dbx-tree-folder"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() =>
            setExpandedFolders((prev) => ({ ...prev, [node.fullPath]: !open }))
          }
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <Icon name="folder" />
          <span className="dbx-truncate">{node.name}</span>
          <span className="dbx-count-pill dbx-mono">{node.keyCount}</span>
        </button>
        {open && node.children.map((ch) => renderTreeNode(ch, depth + 1))}
      </div>
    );
  };

  const renderKeyRow = (entry: RedisKeyEntry, displayLabel?: string, depth = 0) => {
    const active = tab.selectedKey === entry.key;
    return (
      <button
        key={entry.key}
        type="button"
        className={`dbx-redis-key-row ${active ? 'is-active' : ''}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        title={entry.key}
        onClick={() => {
          setStringDraft(null);
          setTtlDraft('');
          setRenameDraft(entry.key);
          void onSelectKey(entry.key);
        }}
      >
        <span className={`dbx-rtype dbx-rtype-${entry.type}`}>{TYPE_LABEL[entry.type] ?? 'KEY'}</span>
        <span className="dbx-truncate dbx-mono">{displayLabel ?? entry.key}</span>
        {entry.ttlMs !== -1 && (
          <span className="dbx-ttl-pill dbx-mono">{formatTtl(entry.ttlMs)}</span>
        )}
      </button>
    );
  };

  return (
    <div className="dbx-tab-pane">
      {/* Top Bar */}
      <div className="dbx-toolbar dbx-toolbar-wrap">
        <div className="dbx-toolbar-group">
          <select
            aria-label="Redis database"
            className="dbx-mono dbx-select-sm"
            value={tab.db}
            onChange={(e) => void onScan({ db: Number(e.currentTarget.value) })}
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
            className="dbx-inline-row"
            onSubmit={(e) => {
              e.preventDefault();
              void onScan({ match: tab.matchPattern });
            }}
          >
            <input
              type="text"
              className="dbx-mono dbx-input-compact"
              placeholder="MATCH *"
              value={tab.matchPattern}
              onChange={(e) => onUpdateTab({ matchPattern: e.currentTarget.value })}
            />
            <button type="submit" className="dbx-btn dbx-btn-secondary dbx-btn-sm" disabled={tab.loading}>
              <Icon name="search" />
              Scan
            </button>
          </form>

          <div className="dbx-segmented">
            <button
              type="button"
              className={tab.viewMode === 'tree' ? 'is-active' : ''}
              onClick={() => onUpdateTab({ viewMode: 'tree' })}
            >
              {t('Tree')} (:)
            </button>
            <button
              type="button"
              className={tab.viewMode === 'flat' ? 'is-active' : ''}
              onClick={() => onUpdateTab({ viewMode: 'flat' })}
            >
              {t('Flat')}
            </button>
          </div>
        </div>

        <div className="dbx-spacer" />

        <div className="dbx-toolbar-group">
          <button
            type="button"
            className="dbx-btn dbx-btn-primary dbx-btn-sm"
            onClick={() => setShowNewKey((v) => !v)}
          >
            <Icon name="plus" />
            {t('New Key')}
          </button>
          <button
            type="button"
            className={`dbx-btn dbx-btn-sm ${tab.showInfo ? 'dbx-btn-secondary' : 'dbx-btn-ghost'}`}
            onClick={() => onUpdateTab({ showInfo: !tab.showInfo })}
          >
            {t('Server Info')}
          </button>
          <button
            type="button"
            className={`dbx-btn dbx-btn-sm ${tab.showCli ? 'dbx-btn-secondary' : 'dbx-btn-ghost'}`}
            onClick={() => onUpdateTab({ showCli: !tab.showCli })}
          >
            <Icon name="file-code" />
            {t('CLI Console')}
          </button>
          <button
            type="button"
            className="dbx-icon-btn"
            title={t('Refresh')}
            disabled={tab.loading}
            onClick={() => void onScan()}
          >
            <Icon name={tab.loading ? 'loader' : 'refresh'} />
          </button>
        </div>
      </div>

      {/* Inline New Key Form */}
      {showNewKey && (
        <form className="dbx-newkey-bar" onSubmit={(e) => void handleCreateKey(e)}>
          <select
            className="dbx-mono dbx-select-sm"
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
            className="dbx-mono"
            placeholder="namespace:key"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.currentTarget.value)}
          />
          {(newKeyType === 'hash' || newKeyType === 'stream') && (
            <input
              type="text"
              className="dbx-mono"
              placeholder="field"
              value={newKeyField}
              onChange={(e) => setNewKeyField(e.currentTarget.value)}
            />
          )}
          {newKeyType === 'zset' && (
            <input
              type="number"
              className="dbx-mono dbx-input-xs"
              placeholder="score"
              value={newKeyScore}
              onChange={(e) => setNewKeyScore(e.currentTarget.value)}
            />
          )}
          <input
            type="text"
            className="dbx-mono"
            placeholder="value"
            value={newKeyValue}
            onChange={(e) => setNewKeyValue(e.currentTarget.value)}
          />
          <input
            type="number"
            className="dbx-mono dbx-input-xs"
            placeholder="TTL (s)"
            value={newKeyTtl}
            onChange={(e) => setNewKeyTtl(e.currentTarget.value)}
          />
          <button type="submit" className="dbx-btn dbx-btn-primary dbx-btn-sm" disabled={busy || !newKeyName.trim()}>
            Create
          </button>
          <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={() => setShowNewKey(false)}>
            {t('Cancel')}
          </button>
        </form>
      )}

      {/* Optional Server Info Strip */}
      {tab.showInfo && tab.info && (
        <div className="dbx-redis-info-bar dbx-mono">
          <span>{`Redis ${tab.info.serverVersion}`}</span>
          <span>{`Memory: ${tab.info.usedMemoryHuman}`}</span>
          <span>{`Clients: ${tab.info.connectedClients}`}</span>
          <span>{`Uptime: ${Math.floor(tab.info.uptimeSeconds / 3600)}h ${Math.floor((tab.info.uptimeSeconds % 3600) / 60)}m`}</span>
          <span>{`Keys loaded: ${tab.keys.length}`}</span>
        </div>
      )}

      {/* Main Split: Left = Keys Tree/Flat, Right = Structured Value Editor */}
      <div className="dbx-split-host">
        <PluginSplitPane direction="horizontal" initialSize={300} minSize={200} maxSize={520}>
          <div className="dbx-redis-keys-pane">
            {tab.keys.length === 0 ? (
              <div className="dbx-empty-center">
                <Icon name="key" />
                <p>{tab.loading ? t('Loading...') : 'No keys matched'}</p>
              </div>
            ) : tab.viewMode === 'tree' ? (
              treeNodes.map((n) => renderTreeNode(n, 0))
            ) : (
              tab.keys.map((k) => renderKeyRow(k))
            )}
          </div>

          <div className="dbx-redis-detail-pane">
            {!detail ? (
              <div className="dbx-empty-center">
                <Icon name="key" />
                <p>Select a key from the left to inspect or edit</p>
              </div>
            ) : (
              <div className="dbx-redis-editor">
                {/* Key Header + TTL + Rename + Delete */}
                <div className="dbx-redis-key-header">
                  <span className={`dbx-rtype dbx-rtype-${detail.type}`}>{TYPE_LABEL[detail.type]}</span>
                  <input
                    type="text"
                    className="dbx-mono dbx-redis-key-title"
                    value={renameDraft || detail.key}
                    onChange={(e) => setRenameDraft(e.currentTarget.value)}
                  />
                  {renameDraft && renameDraft !== detail.key && (
                    <button
                      type="button"
                      className="dbx-btn dbx-btn-secondary dbx-btn-xs"
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

                  <span className="dbx-tag dbx-mono">{`TTL: ${formatTtl(detail.ttlMs)}`}</span>
                  <input
                    type="number"
                    className="dbx-mono dbx-input-xs"
                    placeholder="TTL (s)"
                    value={ttlDraft}
                    onChange={(e) => setTtlDraft(e.currentTarget.value)}
                  />
                  <button
                    type="button"
                    className="dbx-btn dbx-btn-secondary dbx-btn-xs"
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
                      className="dbx-btn dbx-btn-ghost dbx-btn-xs"
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
                    className="dbx-btn dbx-btn-danger dbx-btn-xs"
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
                </div>

                {/* Type-specific CRUD Editor */}
                <div className="dbx-redis-value-body">
                  {detail.type === 'string' && (
                    <div className="dbx-redis-string-wrap">
                      <div className="dbx-editor-host">
                        <PluginCodeEditor
                          value={activeStringValue}
                          language={isJsonLike(activeStringValue) ? 'json' : 'plaintext'}
                          wordWrap="on"
                          onChange={({ value }) => setStringDraft(value)}
                        />
                      </div>
                      <div className="dbx-redis-value-footer">
                        {isJsonLike(activeStringValue) && (
                          <button
                            type="button"
                            className="dbx-btn dbx-btn-ghost dbx-btn-sm"
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
                        <div className="dbx-spacer" />
                        <button
                          type="button"
                          className="dbx-btn dbx-btn-primary dbx-btn-sm"
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
                      </div>
                    </div>
                  )}

                  {detail.type === 'hash' && (
                    <div className="dbx-structure-scroll">
                      <table className="dbx-table">
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Value</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries((detail.value as Record<string, string>) ?? {}).map(([f, v]) => (
                            <tr key={f}>
                              <td className="dbx-mono"><strong>{f}</strong></td>
                              <td className="dbx-mono">{v}</td>
                              <td>
                                <button
                                  type="button"
                                  className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
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
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <form
                        className="dbx-add-row-form"
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
                        <div className="dbx-add-row-inputs">
                          <input type="text" className="dbx-mono" placeholder="field" value={hashField} onChange={(e) => setHashField(e.currentTarget.value)} />
                          <input type="text" className="dbx-mono" placeholder="value" value={hashVal} onChange={(e) => setHashVal(e.currentTarget.value)} />
                          <button type="submit" className="dbx-btn dbx-btn-primary dbx-btn-sm" disabled={busy || !hashField.trim()}>
                            HSET
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {detail.type === 'list' && (
                    <div className="dbx-structure-scroll">
                      <table className="dbx-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Element</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((detail.value as string[]) ?? []).map((item, idx) => (
                            <tr key={`${idx}:${item}`}>
                              <td className="dbx-mono dbx-muted">{idx}</td>
                              <td className="dbx-mono">{item}</td>
                              <td>
                                <button
                                  type="button"
                                  className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
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
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <form
                        className="dbx-add-row-form"
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
                        <div className="dbx-add-row-inputs">
                          <input type="text" className="dbx-mono" placeholder="new element" value={listVal} onChange={(e) => setListVal(e.currentTarget.value)} />
                          <button
                            type="button"
                            className="dbx-btn dbx-btn-secondary dbx-btn-sm"
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
                          <button type="submit" className="dbx-btn dbx-btn-primary dbx-btn-sm" disabled={busy || !listVal}>
                            RPUSH
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {detail.type === 'set' && (
                    <div className="dbx-structure-scroll">
                      <table className="dbx-table">
                        <thead>
                          <tr>
                            <th>Member</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((detail.value as string[]) ?? []).map((member) => (
                            <tr key={member}>
                              <td className="dbx-mono">{member}</td>
                              <td>
                                <button
                                  type="button"
                                  className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
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
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <form
                        className="dbx-add-row-form"
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
                        <div className="dbx-add-row-inputs">
                          <input type="text" className="dbx-mono" placeholder="member" value={setMember} onChange={(e) => setSetMember(e.currentTarget.value)} />
                          <button type="submit" className="dbx-btn dbx-btn-primary dbx-btn-sm" disabled={busy || !setMember}>
                            SADD
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {detail.type === 'zset' && (
                    <div className="dbx-structure-scroll">
                      <table className="dbx-table">
                        <thead>
                          <tr>
                            <th>Score</th>
                            <th>Member</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((detail.value as Array<{ member: string; score: number }>) ?? []).map((entry) => (
                            <tr key={entry.member}>
                              <td className="dbx-mono">{entry.score}</td>
                              <td className="dbx-mono">{entry.member}</td>
                              <td>
                                <button
                                  type="button"
                                  className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
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
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <form
                        className="dbx-add-row-form"
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
                        <div className="dbx-add-row-inputs">
                          <input type="number" className="dbx-mono dbx-input-xs" placeholder="score" value={zsetScore} onChange={(e) => setZsetScore(e.currentTarget.value)} />
                          <input type="text" className="dbx-mono" placeholder="member" value={zsetMember} onChange={(e) => setZsetMember(e.currentTarget.value)} />
                          <button type="submit" className="dbx-btn dbx-btn-primary dbx-btn-sm" disabled={busy || !zsetMember}>
                            ZADD
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {detail.type === 'stream' && (
                    <div className="dbx-structure-scroll">
                      <table className="dbx-table">
                        <thead>
                          <tr>
                            <th>Stream ID</th>
                            <th>Fields</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((detail.value as RedisStreamEntry[]) ?? []).map((entry) => (
                            <tr key={entry.id}>
                              <td className="dbx-mono"><strong>{entry.id}</strong></td>
                              <td className="dbx-mono">{JSON.stringify(entry.fields)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
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
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <form
                        className="dbx-add-row-form"
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
                        <div className="dbx-add-row-inputs">
                          <input type="text" className="dbx-mono" placeholder="field" value={streamField} onChange={(e) => setStreamField(e.currentTarget.value)} />
                          <input type="text" className="dbx-mono" placeholder="value" value={streamVal} onChange={(e) => setStreamVal(e.currentTarget.value)} />
                          <button type="submit" className="dbx-btn dbx-btn-primary dbx-btn-sm" disabled={busy || !streamField.trim()}>
                            XADD *
                          </button>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </PluginSplitPane>
      </div>

      {/* Collapsible Interactive Redis CLI Console */}
      {tab.showCli && (
        <div className="dbx-redis-cli">
          <div className="dbx-redis-cli-head">
            <strong className="dbx-mono">{`redis:${tab.db}> CLI`}</strong>
            <button
              type="button"
              className="dbx-btn dbx-btn-ghost dbx-btn-xs"
              onClick={() => onUpdateTab({ cliHistory: [] })}
            >
              {t('Clear')}
            </button>
            <button
              type="button"
              className="dbx-icon-btn"
              onClick={() => onUpdateTab({ showCli: false })}
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="dbx-redis-cli-log dbx-mono">
            {tab.cliHistory.map((item, i) => (
              <div key={i} className="dbx-cli-entry">
                <div className="dbx-cli-cmd">{`> ${item.command}${item.args.length ? ' ' + item.args.join(' ') : ''}`}</div>
                <pre className={item.isError ? 'dbx-cli-err' : 'dbx-cli-out'}>{item.formatted}</pre>
              </div>
            ))}
          </div>
          <form className="dbx-redis-cli-input" onSubmit={(e) => void handleCliSubmit(e)}>
            <span className="dbx-mono dbx-primary-text">{`db${tab.db}>`}</span>
            <input
              type="text"
              className="dbx-mono"
              placeholder="PING, GET mykey, INFO server, KEYS * ..."
              value={tab.cliInput}
              onChange={(e) => onUpdateTab({ cliInput: e.currentTarget.value })}
            />
            <button type="submit" className="dbx-btn dbx-btn-primary dbx-btn-xs">
              Run
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
