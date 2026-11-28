/**
 * Message Queue & Event Broker Specialist Workbench Tab:
 * Borderless Monitor-style workbench supporting RabbitMQ, Apache Pulsar, MQTT, and Apache Kafka.
 *
 * Views:
 * - Overview: Borderless KPI strip (Version, Cluster, Nodes, Queues/Topics, Exchanges, Connections, Ready/Unacked)
 * - Topics / Queues: VHost/Namespace switcher, search filter, Create/Subscribe, Purge/Delete (Read-Only guarded)
 * - Exchanges & Bindings / Partitions: Exchanges, Bindings/Subscriptions, or Kafka Partition offsets/ISR
 * - Publish: Message composer with target topic/queue, exchange/routingKey, MQTT QoS/Retain, `PluginCodeEditor`
 * - Messages (Peek / Consume): Split message list + payload/headers inspector (`PluginCodeEditor`)
 * - Nodes & Connections: Broker nodes, connections, channels, consumer groups, and users/policies
 *
 * ZERO inline SVG or canvas elements (uses `<Icon>` static assets only).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  PluginSplitPane,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type {
  MqBrokerDriver,
  MqChannelInfo,
  MqConnectionInfo,
  MqConsumerGroupInfo,
  MqNodeInfo,
  MqPartitionInfo,
  MqPolicyInfo,
  MqUserInfo,
} from '../../drivers/mqHttpDriver';
import type {
  MqBindingInfo,
  MqExchangeInfo,
  MqMessage,
  MqOverview,
  MqQueueInfo,
} from '../../drivers/types';
import { formatBytes } from '../i18n';

export type MqSubTab =
  | 'overview'
  | 'queues'
  | 'bindings'
  | 'publish'
  | 'messages'
  | 'nodes';

export interface MqWorkbenchTabState {
  id: string;
  connectionId: string;
  kind: 'mq';
  title: string;
  vhost: string;
  vhosts: string[];
  activeSubTab: MqSubTab;
  selectedQueue: string | null;
  overview: MqOverview | null;
  queues: MqQueueInfo[];
  exchanges: MqExchangeInfo[];
  bindings: MqBindingInfo[];
  messages: MqMessage[];
  loading: boolean;
  error?: string;
}

export interface MqWorkbenchTabProps {
  tab: MqWorkbenchTabState;
  driver: MqBrokerDriver;
  readOnly?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<MqWorkbenchTabState>) => void;
  onNotify: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

function isJsonText(text: string): boolean {
  const s = text.trim();
  return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'));
}

export function MqWorkbenchTab({
  tab,
  driver,
  readOnly = false,
  t,
  onUpdateTab,
  onNotify,
  onShortcut,
}: MqWorkbenchTabProps) {
  const engine = String(driver.engine);
  const isKafka = engine === 'kafka';
  const isMqtt = engine === 'mqtt';
  const isRabbit = engine === 'rabbitmq';
  const entityLabel = isRabbit ? t('Queues') : t('Topics');

  const [filterText, setFilterText] = useState('');
  const [busy, setBusy] = useState(false);

  // Create queue / subscribe topic form
  const [showCreate, setShowCreate] = useState(false);
  const [newQueueName, setNewQueueName] = useState('');
  const [newQueueDurable, setNewQueueDurable] = useState(true);

  // Publish composer state
  const [pubTarget, setPubTarget] = useState(tab.selectedQueue ?? '');
  const [pubExchange, setPubExchange] = useState(isRabbit ? 'amq.default' : '');
  const [pubRoutingKey, setPubRoutingKey] = useState('');
  const [pubQos, setPubQos] = useState<0 | 1>(0);
  const [pubRetain, setPubRetain] = useState(false);
  const [pubPayload, setPubPayload] = useState('{\n  "event": "ping"\n}');

  // Message peek/consume state
  const [peekTarget, setPeekTarget] = useState(tab.selectedQueue ?? '');
  const [peekCount, setPeekCount] = useState(20);
  const [peekRequeue, setPeekRequeue] = useState(true);
  const [selectedMsgIdx, setSelectedMsgIdx] = useState<number | null>(null);

  // Extended broker telemetry
  const [nodes, setNodes] = useState<MqNodeInfo[]>([]);
  const [connections, setConnections] = useState<MqConnectionInfo[]>([]);
  const [channels, setChannels] = useState<MqChannelInfo[]>([]);
  const [users, setUsers] = useState<MqUserInfo[]>([]);
  const [policies, setPolicies] = useState<MqPolicyInfo[]>([]);
  const [consumerGroups, setConsumerGroups] = useState<MqConsumerGroupInfo[]>([]);
  const [partitions, setPartitions] = useState<MqPartitionInfo[]>([]);

  useEffect(() => {
    if (tab.selectedQueue) {
      setPubTarget((prev) => prev || tab.selectedQueue || '');
      setPeekTarget((prev) => prev || tab.selectedQueue || '');
    }
  }, [tab.selectedQueue]);

  const refreshAll = useCallback(
    async (vhostOverride?: string) => {
      onUpdateTab({ loading: true, error: undefined });
      try {
        const vhosts = await driver.listVhosts().catch(() => [tab.vhost || '/']);
        const activeVhost = vhostOverride ?? (tab.vhost || vhosts[0] || '/');
        const [overview, queues, exchanges, bindings] = await Promise.all([
          driver.getOverview().catch(() => null),
          driver.listQueues(activeVhost).catch(() => []),
          driver.listExchanges(activeVhost).catch(() => []),
          driver.listBindings(activeVhost).catch(() => []),
        ]);

        const [nList, cList, chList, uList, pList, cgList] = await Promise.all([
          driver.listNodes ? driver.listNodes().catch(() => []) : Promise.resolve([]),
          driver.listConnections ? driver.listConnections().catch(() => []) : Promise.resolve([]),
          driver.listChannels ? driver.listChannels().catch(() => []) : Promise.resolve([]),
          driver.listUsers ? driver.listUsers().catch(() => []) : Promise.resolve([]),
          driver.listPolicies ? driver.listPolicies(activeVhost).catch(() => []) : Promise.resolve([]),
          driver.listConsumerGroups ? driver.listConsumerGroups().catch(() => []) : Promise.resolve([]),
        ]);

        setNodes(nList);
        setConnections(cList);
        setChannels(chList);
        setUsers(uList);
        setPolicies(pList);
        setConsumerGroups(cgList);

        const nextSelected =
          tab.selectedQueue && queues.some((q) => q.name === tab.selectedQueue)
            ? tab.selectedQueue
            : queues[0]?.name ?? null;

        onUpdateTab({
          vhosts,
          vhost: activeVhost,
          overview,
          queues,
          exchanges,
          bindings,
          selectedQueue: nextSelected,
          loading: false,
        });

        if (nextSelected && driver.listPartitions) {
          const parts = await driver.listPartitions(nextSelected).catch(() => []);
          setPartitions(parts);
        }
      } catch (err) {
        onUpdateTab({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [driver, onUpdateTab, tab.selectedQueue, tab.vhost],
  );

  useEffect(() => {
    if (!tab.overview && tab.queues.length === 0 && !tab.loading) {
      void refreshAll();
    }
  }, [refreshAll, tab.loading, tab.overview, tab.queues.length]);

  const handleSelectQueue = async (queueName: string) => {
    onUpdateTab({ selectedQueue: queueName });
    setPubTarget(queueName);
    setPeekTarget(queueName);
    if (driver.listPartitions) {
      const parts = await driver.listPartitions(queueName).catch(() => []);
      setPartitions(parts);
    }
  };

  const handleCreateQueue = async () => {
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    const name = newQueueName.trim();
    if (!name || !driver.createQueue) return;
    setBusy(true);
    try {
      await driver.createQueue(name, { vhost: tab.vhost, durable: newQueueDurable });
      onNotify('success', isMqtt ? `Subscribed to ${name}` : `Created ${name}`);
      setNewQueueName('');
      setShowCreate(false);
      await refreshAll();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteQueue = async (name: string) => {
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    if (!driver.deleteQueue) return;
    setBusy(true);
    try {
      await driver.deleteQueue(name, tab.vhost);
      onNotify('success', isMqtt ? `Unsubscribed ${name}` : `Deleted ${name}`);
      await refreshAll();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePurgeQueue = async (name: string) => {
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    if (!driver.purgeQueue) return;
    setBusy(true);
    try {
      await driver.purgeQueue(name, tab.vhost);
      onNotify('success', `Purged ${name}`);
      await refreshAll();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (readOnly) {
      onNotify('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    const target = pubTarget.trim() || pubRoutingKey.trim();
    if (!target) {
      onNotify('warning', t('Specify a target queue or topic first.'));
      return;
    }
    setBusy(true);
    try {
      const res = await driver.publishMessage(target, pubPayload, {
        vhost: tab.vhost,
        exchange: pubExchange.trim() || undefined,
        routingKey: pubRoutingKey.trim() || target,
        qos: pubQos,
        retain: pubRetain,
      });
      onNotify(
        res.routed ? 'success' : 'warning',
        res.routed ? `Published message to ${target}` : `Published to ${target} (not routed)`,
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePeekMessages = async (targetOverride?: string) => {
    const target = (targetOverride ?? peekTarget).trim();
    if (!target) {
      onNotify('warning', t('Select or enter a queue/topic to peek messages.'));
      return;
    }
    setBusy(true);
    try {
      const msgs = await driver.getMessages(target, {
        vhost: tab.vhost,
        count: peekCount,
        requeue: peekRequeue,
      });
      onUpdateTab({ messages: msgs, activeSubTab: 'messages' });
      setSelectedMsgIdx(msgs.length > 0 ? 0 : null);
      onNotify('info', `Fetched ${msgs.length} message(s) from ${target}`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const filteredQueues = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return tab.queues;
    return tab.queues.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.vhost.toLowerCase().includes(q) ||
        (item.type ?? '').toLowerCase().includes(q),
    );
  }, [filterText, tab.queues]);

  const selectedMessage =
    selectedMsgIdx !== null && selectedMsgIdx >= 0 && selectedMsgIdx < tab.messages.length
      ? tab.messages[selectedMsgIdx]
      : null;

  const kpiCards = useMemo(() => {
    const ov = tab.overview;
    return [
      { label: t('Engine'), value: engine.toUpperCase() },
      { label: t('Version'), value: ov?.serverVersion || driver.serverVersion || '-' },
      { label: t('Cluster'), value: ov?.clusterName || tab.vhost || '-' },
      { label: t('Nodes'), value: String(ov?.nodeCount ?? (nodes.length || 1)) },
      { label: entityLabel, value: String(ov?.queueCount ?? tab.queues.length) },
      {
        label: isRabbit ? t('Exchanges') : t('Bindings'),
        value: String(isRabbit ? ov?.exchangeCount ?? tab.exchanges.length : tab.bindings.length),
      },
      {
        label: t('Ready Messages'),
        value: ov?.messagesReady !== undefined ? String(ov.messagesReady) : String(tab.messages.length),
      },
      {
        label: isKafka ? t('Consumer Groups') : t('Connections'),
        value: String(
          isKafka ? consumerGroups.length : ov?.connectionCount ?? connections.length,
        ),
      },
    ];
  }, [
    connections.length,
    consumerGroups.length,
    driver.serverVersion,
    engine,
    entityLabel,
    isKafka,
    isRabbit,
    nodes.length,
    t,
    tab.bindings.length,
    tab.exchanges.length,
    tab.messages.length,
    tab.overview,
    tab.queues.length,
    tab.vhost,
  ]);

  return (
    <div className="ndb-tab-pane">
      {/* Top borderless toolbar */}
      <div className="ndb-toolbar">
        <div className="ndb-toolbar-group">
          <span className="ndb-tag ndb-mono">{engine.toUpperCase()}</span>
          {tab.vhosts.length > 0 && (
            <select
              className="ndb-input ndb-mono"
              value={tab.vhost}
              onChange={(e) => {
                const next = e.currentTarget.value;
                onUpdateTab({ vhost: next });
                void refreshAll(next);
              }}
              aria-label="VHost or Namespace"
            >
              {tab.vhosts.map((vh) => (
                <option key={vh} value={vh}>
                  {vh}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary ndb-btn-sm"
            disabled={tab.loading || busy}
            onClick={() => void refreshAll()}
          >
            <Icon name={tab.loading ? 'loader' : 'refresh'} />
            {t('Refresh')}
          </button>
        </div>

        <div className="ndb-spacer" />

        {!readOnly && driver.createQueue && (
          <button
            type="button"
            className="ndb-btn ndb-btn-primary ndb-btn-sm"
            onClick={() => {
              onUpdateTab({ activeSubTab: 'queues' });
              setShowCreate((v) => !v);
            }}
          >
            <Icon name="plus" />
            {isMqtt ? t('Subscribe Topic') : isRabbit ? t('New Queue') : t('New Topic')}
          </button>
        )}
      </div>

      {/* Sub-navigation bar */}
      <div className="ndb-subtab-bar">
        {(
          [
            ['overview', t('Overview')],
            ['queues', `${entityLabel} (${tab.queues.length})`],
            [
              'bindings',
              isKafka
                ? `${t('Partitions')} (${partitions.length})`
                : isRabbit
                  ? `${t('Exchanges & Bindings')} (${tab.exchanges.length})`
                  : `${t('Subscriptions')} (${tab.bindings.length})`,
            ],
            ['publish', t('Publish')],
            ['messages', `${t('Messages')} (${tab.messages.length})`],
            ['nodes', `${t('Nodes & Consumers')} (${nodes.length || connections.length || consumerGroups.length})`],
          ] as Array<[MqSubTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`ndb-subtab${tab.activeSubTab === key ? ' is-active' : ''}`}
            onClick={() => onUpdateTab({ activeSubTab: key })}
          >
            {label}
          </button>
        ))}
      </div>

      {tab.error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      {/* Overview KPIs */}
      {tab.activeSubTab === 'overview' && (
        <div className="ndb-split-host" style={{ padding: '16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
            {kpiCards.map((card) => (
              <div key={card.label} className="ndb-inline-card" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="ndb-muted" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {card.label}
                </span>
                <strong className="ndb-mono" style={{ fontSize: '15px', wordBreak: 'break-all' }}>
                  {card.value}
                </strong>
              </div>
            ))}
          </div>

          {tab.overview?.raw && Object.keys(tab.overview.raw).length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
                {t('Broker Telemetry')}
              </h4>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('Metric')}</th>
                    <th>{t('Value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(tab.overview.raw).map(([k, v]) => (
                    <tr key={k}>
                      <td className="ndb-mono">{k}</td>
                      <td className="ndb-mono">
                        {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Topics / Queues Browser */}
      {tab.activeSubTab === 'queues' && (
        <div className="ndb-split-host" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="ndb-toolbar">
            <div className="ndb-toolbar-group">
              <Icon name="search" />
              <input
                type="text"
                className="ndb-input"
                placeholder={t('Filter queues or topics...')}
                value={filterText}
                onChange={(e) => setFilterText(e.currentTarget.value)}
              />
            </div>
            <div className="ndb-spacer" />
            <span className="ndb-muted ndb-mono">{`${filteredQueues.length} / ${tab.queues.length}`}</span>
          </div>

          {showCreate && (
            <div className="ndb-inline-card" style={{ margin: '0 12px 8px', padding: '10px 12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text"
                className="ndb-input ndb-mono"
                placeholder={isMqtt ? 'sensors/+/temperature' : 'orders.events'}
                value={newQueueName}
                onChange={(e) => setNewQueueName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateQueue();
                }}
              />
              {isRabbit && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                  <input
                    type="checkbox"
                    checked={newQueueDurable}
                    onChange={(e) => setNewQueueDurable(e.currentTarget.checked)}
                  />
                  {t('Durable')}
                </label>
              )}
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-sm"
                disabled={busy}
                onClick={() => void handleCreateQueue()}
              >
                {isMqtt ? t('Subscribe') : t('Create')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                onClick={() => setShowCreate(false)}
              >
                {t('Cancel')}
              </button>
            </div>
          )}

          <div style={{ flex: 1, overflow: 'auto' }}>
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('VHost / Scope')}</th>
                  <th>{t('Type')}</th>
                  <th>{t('State')}</th>
                  <th>{t('Messages')}</th>
                  <th>{t('Consumers')}</th>
                  <th>{t('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredQueues.map((q) => (
                  <tr
                    key={`${q.vhost}:${q.name}`}
                    className={tab.selectedQueue === q.name ? 'is-dirty-row' : undefined}
                    onClick={() => void handleSelectQueue(q.name)}
                  >
                    <td className="ndb-mono">{q.name}</td>
                    <td className="ndb-mono ndb-muted">{q.vhost}</td>
                    <td>{q.type ?? (q.durable ? 'durable' : 'transient')}</td>
                    <td>
                      <span className="ndb-tag ndb-tag-ok">{q.state ?? 'active'}</span>
                    </td>
                    <td className="ndb-mono">
                      {q.messagesReady !== undefined
                        ? `${q.messagesReady}${q.messagesUnacked ? ` (+${q.messagesUnacked} unacked)` : ''}`
                        : q.messages ?? '-'}
                    </td>
                    <td className="ndb-mono">{q.consumers ?? '-'}</td>
                    <td>
                      <div className="ndb-toolbar-group">
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPeekTarget(q.name);
                            void handlePeekMessages(q.name);
                          }}
                        >
                          <Icon name="eye" />
                          {t('Peek')}
                        </button>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPubTarget(q.name);
                            setPubRoutingKey(q.name);
                            onUpdateTab({ activeSubTab: 'publish', selectedQueue: q.name });
                          }}
                        >
                          {t('Publish')}
                        </button>
                        {!readOnly && driver.purgeQueue && (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handlePurgeQueue(q.name);
                            }}
                          >
                            {t('Purge')}
                          </button>
                        )}
                        {!readOnly && driver.deleteQueue && (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-danger ndb-btn-xs"
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteQueue(q.name);
                            }}
                          >
                            {isMqtt ? t('Unsubscribe') : t('Delete')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredQueues.length === 0 && (
                  <tr>
                    <td colSpan={7} className="ndb-table-empty">
                      {t('No queues or topics found.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Exchanges & Bindings / Kafka Partitions */}
      {tab.activeSubTab === 'bindings' && (
        <div className="ndb-split-host" style={{ overflow: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {isKafka && (
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
                {`${t('Partitions')} ${tab.selectedQueue ? `— ${tab.selectedQueue}` : ''}`}
              </h4>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('Partition')}</th>
                    <th>{t('Leader')}</th>
                    <th>{t('Replicas')}</th>
                    <th>{t('ISR')}</th>
                    <th>{t('Earliest Offset')}</th>
                    <th>{t('Latest Offset')}</th>
                  </tr>
                </thead>
                <tbody>
                  {partitions.map((p) => (
                    <tr key={`${p.topic}:${p.partitionId}`}>
                      <td className="ndb-mono">{p.partitionId}</td>
                      <td className="ndb-mono">{p.leader}</td>
                      <td className="ndb-mono">{p.replicas.join(', ')}</td>
                      <td className="ndb-mono">{p.isr.join(', ')}</td>
                      <td className="ndb-mono">{p.earliestOffset ?? '-'}</td>
                      <td className="ndb-mono">{p.latestOffset ?? '-'}</td>
                    </tr>
                  ))}
                  {partitions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="ndb-table-empty">
                        {t('Select a topic to inspect its partitions.')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab.exchanges.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
                {t('Exchanges')}
              </h4>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('Name')}</th>
                    <th>{t('VHost')}</th>
                    <th>{t('Type')}</th>
                    <th>{t('Durable')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tab.exchanges.map((ex) => (
                    <tr key={`${ex.vhost}:${ex.name}`}>
                      <td className="ndb-mono">{ex.name}</td>
                      <td className="ndb-mono ndb-muted">{ex.vhost}</td>
                      <td><span className="ndb-tag">{ex.type}</span></td>
                      <td>{ex.durable ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
              {isRabbit ? t('Bindings') : t('Subscriptions & Consumer Groups')}
            </h4>
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>{t('Source')}</th>
                  <th>{t('Destination')}</th>
                  <th>{t('Type')}</th>
                  <th>{t('Routing Key')}</th>
                </tr>
              </thead>
              <tbody>
                {tab.bindings.map((b, i) => (
                  <tr key={`${b.source}:${b.destination}:${b.routingKey}:${i}`}>
                    <td className="ndb-mono">{b.source}</td>
                    <td className="ndb-mono">{b.destination}</td>
                    <td>{b.destinationType ?? '-'}</td>
                    <td className="ndb-mono">{b.routingKey || '(default)'}</td>
                  </tr>
                ))}
                {tab.bindings.length === 0 && (
                  <tr>
                    <td colSpan={4} className="ndb-table-empty">
                      {t('No bindings or subscriptions found.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Publish Composer */}
      {tab.activeSubTab === 'publish' && (
        <div className="ndb-split-host" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="ndb-toolbar ndb-toolbar-wrap">
            <div className="ndb-toolbar-group">
              <input
                type="text"
                className="ndb-input ndb-mono"
                placeholder={isRabbit ? 'Target Queue' : 'Target Topic'}
                value={pubTarget}
                onChange={(e) => setPubTarget(e.currentTarget.value)}
              />
              {isRabbit && (
                <input
                  type="text"
                  className="ndb-input ndb-mono"
                  placeholder="Exchange (amq.default)"
                  value={pubExchange}
                  onChange={(e) => setPubExchange(e.currentTarget.value)}
                />
              )}
              <input
                type="text"
                className="ndb-input ndb-mono"
                placeholder={isKafka ? 'Message Key (optional)' : 'Routing Key (optional)'}
                value={pubRoutingKey}
                onChange={(e) => setPubRoutingKey(e.currentTarget.value)}
              />
              {isMqtt && (
                <>
                  <select
                    className="ndb-input ndb-mono"
                    value={String(pubQos)}
                    onChange={(e) => setPubQos(e.currentTarget.value === '1' ? 1 : 0)}
                  >
                    <option value="0">QoS 0</option>
                    <option value="1">QoS 1</option>
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                    <input
                      type="checkbox"
                      checked={pubRetain}
                      onChange={(e) => setPubRetain(e.currentTarget.checked)}
                    />
                    Retain
                  </label>
                </>
              )}
            </div>
            <div className="ndb-spacer" />
            <button
              type="button"
              className="ndb-btn ndb-btn-primary ndb-btn-sm"
              disabled={busy || readOnly}
              onClick={() => void handlePublish()}
            >
              <Icon name="play" />
              {t('Publish Message')}
            </button>
          </div>

          <div className="ndb-editor-host" style={{ flex: 1, minHeight: 0 }}>
            <PluginCodeEditor
              value={pubPayload}
              language={isJsonText(pubPayload) ? 'json' : 'plaintext'}
              readOnly={readOnly}
              lineNumbers="on"
              minimap={false}
              wordWrap="on"
              onChange={(d) => setPubPayload(d.value)}
              onShortcut={onShortcut}
            />
          </div>
        </div>
      )}

      {/* Consume / Peek Messages Inspector */}
      {tab.activeSubTab === 'messages' && (
        <div className="ndb-split-host" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="ndb-toolbar">
            <div className="ndb-toolbar-group">
              <input
                type="text"
                className="ndb-input ndb-mono"
                placeholder={isRabbit ? 'Queue name' : 'Topic name'}
                value={peekTarget}
                onChange={(e) => setPeekTarget(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handlePeekMessages();
                }}
              />
              <input
                type="number"
                className="ndb-input ndb-mono"
                style={{ width: '76px' }}
                min={1}
                max={200}
                value={peekCount}
                onChange={(e) => setPeekCount(Math.max(1, Number(e.currentTarget.value) || 10))}
              />
              {isRabbit && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                  <input
                    type="checkbox"
                    checked={peekRequeue}
                    onChange={(e) => setPeekRequeue(e.currentTarget.checked)}
                  />
                  {t('Requeue')}
                </label>
              )}
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-sm"
                disabled={busy}
                onClick={() => void handlePeekMessages()}
              >
                <Icon name="eye" />
                {t('Peek / Fetch')}
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0 }}>
            <PluginSplitPane direction="horizontal" initialSize={300} minSize={180} maxSize={540}>
              <div style={{ height: '100%', overflow: 'auto' }}>
                {tab.messages.map((m, idx) => (
                  <button
                    key={`${m.id ?? idx}-${idx}`}
                    type="button"
                    className={`ndb-redis-key-row${selectedMsgIdx === idx ? ' is-active' : ''}`}
                    style={{ width: '100%', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px 10px' }}
                    onClick={() => setSelectedMsgIdx(idx)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                      <strong className="ndb-mono" style={{ fontSize: '12px' }}>
                        {m.routingKey || m.topicOrQueue}
                      </strong>
                      <span className="ndb-muted ndb-mono" style={{ fontSize: '11px' }}>
                        {m.id ? `#${m.id}` : `#${idx + 1}`}
                      </span>
                    </div>
                    <span className="ndb-muted ndb-mono" style={{ fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.payload.slice(0, 80)}
                    </span>
                  </button>
                ))}
                {tab.messages.length === 0 && (
                  <div className="ndb-empty-center">
                    <p className="ndb-muted">{t('No messages fetched yet. Click Peek / Fetch above.')}</p>
                  </div>
                )}
              </div>

              <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {selectedMessage ? (
                  <>
                    <div className="ndb-toolbar">
                      <span className="ndb-mono">{selectedMessage.topicOrQueue}</span>
                      {selectedMessage.routingKey && (
                        <span className="ndb-tag ndb-mono">{selectedMessage.routingKey}</span>
                      )}
                      {selectedMessage.redelivered && (
                        <span className="ndb-tag ndb-tag-warn">redelivered</span>
                      )}
                      <div className="ndb-spacer" />
                      {selectedMessage.timestamp && (
                        <span className="ndb-muted ndb-mono">
                          {new Date(selectedMessage.timestamp).toISOString()}
                        </span>
                      )}
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <PluginCodeEditor
                        value={selectedMessage.payload}
                        language={isJsonText(selectedMessage.payload) ? 'json' : 'plaintext'}
                        readOnly
                        lineNumbers="on"
                        minimap={false}
                        wordWrap="on"
                        onShortcut={onShortcut}
                      />
                    </div>
                  </>
                ) : (
                  <div className="ndb-empty-center">
                    <p className="ndb-muted">{t('Select a message to inspect its payload and headers.')}</p>
                  </div>
                )}
              </div>
            </PluginSplitPane>
          </div>
        </div>
      )}

      {/* Nodes, Connections, Channels, Consumer Groups, Users & Policies */}
      {tab.activeSubTab === 'nodes' && (
        <div className="ndb-split-host" style={{ overflow: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
              {t('Cluster Nodes')}
            </h4>
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>{t('Node')}</th>
                  <th>{t('Role / Type')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Memory')}</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.name}>
                    <td className="ndb-mono">{n.name}</td>
                    <td>{n.type ?? 'node'}</td>
                    <td>
                      <span className={`ndb-tag ${n.running ? 'ndb-tag-ok' : 'ndb-tag-danger'}`}>
                        {n.running ? 'running' : 'down'}
                      </span>
                    </td>
                    <td className="ndb-mono">
                      {n.memUsedBytes !== undefined ? formatBytes(n.memUsedBytes) : '-'}
                    </td>
                  </tr>
                ))}
                {nodes.length === 0 && (
                  <tr>
                    <td colSpan={4} className="ndb-table-empty">{t('No node telemetry reported.')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {connections.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
                {t('Connections')}
              </h4>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('Name')}</th>
                    <th>{t('User')}</th>
                    <th>{t('VHost')}</th>
                    <th>{t('Protocol')}</th>
                    <th>{t('State')}</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.map((c) => (
                    <tr key={c.name}>
                      <td className="ndb-mono">{c.name}</td>
                      <td className="ndb-mono">{c.user ?? '-'}</td>
                      <td className="ndb-mono">{c.vhost ?? '-'}</td>
                      <td>{c.protocol ?? '-'}</td>
                      <td><span className="ndb-tag ndb-tag-ok">{c.state ?? 'running'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {channels.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
                {t('Channels')}
              </h4>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('Channel')}</th>
                    <th>{t('User')}</th>
                    <th>{t('Consumers')}</th>
                    <th>{t('Unacked')}</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((ch) => (
                    <tr key={ch.name}>
                      <td className="ndb-mono">{ch.name}</td>
                      <td className="ndb-mono">{ch.user ?? '-'}</td>
                      <td className="ndb-mono">{ch.consumerCount ?? 0}</td>
                      <td className="ndb-mono">{ch.unackedCount ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {consumerGroups.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
                {t('Consumer Groups')}
              </h4>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('Group ID')}</th>
                    <th>{t('Protocol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {consumerGroups.map((cg) => (
                    <tr key={cg.groupId}>
                      <td className="ndb-mono">{cg.groupId}</td>
                      <td>{cg.protocolType ?? 'consumer'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {users.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
                {t('Users & Permissions')}
              </h4>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('User')}</th>
                    <th>{t('Tags')}</th>
                    <th>{t('VHosts')}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.name}>
                      <td className="ndb-mono">{u.name}</td>
                      <td>{u.tags.join(', ') || '-'}</td>
                      <td className="ndb-mono">
                        {(u.permissions ?? []).map((p) => p.vhost).join(', ') || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {policies.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }} className="ndb-muted">
                {t('Policies')}
              </h4>
              <table className="ndb-table">
                <thead>
                  <tr>
                    <th>{t('Policy')}</th>
                    <th>{t('VHost')}</th>
                    <th>{t('Pattern')}</th>
                    <th>{t('Apply To')}</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => (
                    <tr key={`${p.vhost}:${p.name}`}>
                      <td className="ndb-mono">{p.name}</td>
                      <td className="ndb-mono">{p.vhost}</td>
                      <td className="ndb-mono">{p.pattern}</td>
                      <td>{p.applyTo ?? 'all'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Footer status strip */}
      <div className="ndb-statusbar ndb-mono">
        <span className="ndb-status-item">{`${tab.queues.length} ${entityLabel.toLowerCase()}`}</span>
        <span className="ndb-status-item">{`${nodes.length || 1} node(s)`}</span>
        <span className="ndb-spacer" />
        <span className="ndb-status-item ndb-muted">{driver.serverVersion}</span>
      </div>
    </div>
  );
}

export default MqWorkbenchTab;
