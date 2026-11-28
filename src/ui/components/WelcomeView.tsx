/**
 * Clean, generous Netcatty-native Welcome / Empty State screen when no tab is active.
 */

import React from 'react';
import { Icon } from '../../Icon';
import { driverById } from '../../driverRegistry';
import type { SavedConnection } from '../types';
import { EngineIcon, EnvColorDot } from './EngineBadge';

export interface WelcomeViewProps {
  connections: SavedConnection[];
  connectedIds: Set<string>;
  connectingId: string | null;
  theme: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onNewConnection: () => void;
  onOpenSqliteFile: () => void;
  onLaunchSampleSqlite: () => void;
  onImportConnections?: () => void;
  onExportConnections?: () => void;
  onConnect: (conn: SavedConnection) => void;
  onEdit: (conn: SavedConnection) => void;
}

export function WelcomeView({
  connections,
  connectedIds,
  connectingId,
  theme,
  t,
  onNewConnection,
  onOpenSqliteFile,
  onLaunchSampleSqlite,
  onImportConnections,
  onExportConnections,
  onConnect,
  onEdit,
}: WelcomeViewProps) {
  return (
    <div className="ndb-welcome">
      <div className="ndb-welcome-inner">
        <header className="ndb-welcome-hero">
          <div className="ndb-welcome-mark">
            <Icon name="database" />
          </div>
          <div className="ndb-welcome-copy">
            <h1>{t('Database Workbench')}</h1>
            <p>{t('Connect to PostgreSQL, MySQL, SQL Server, SQLite, Neo4j, ClickHouse, Redis, MongoDB, Elasticsearch, Qdrant, InfluxDB, Trino, and etcd directly inside Netcatty.')}</p>
          </div>
        </header>

        <section className="ndb-quick-actions" aria-label={t('Quick start')}>
          <button type="button" className="ndb-quick-card ndb-quick-card-primary" onClick={onNewConnection}>
            <span className="ndb-quick-card-icon">
              <Icon name="plus" />
            </span>
            <span className="ndb-quick-card-body">
              <strong>{t('New Connection')}</strong>
              <small>{t('Configure any of 113 engines with TLS & SSH tunnels')}</small>
            </span>
            <Icon name="arrow-right" />
          </button>

          <button type="button" className="ndb-quick-card" onClick={onOpenSqliteFile}>
            <span className="ndb-quick-card-icon">
              <Icon name="folder" />
            </span>
            <span className="ndb-quick-card-body">
              <strong>{t('Open Local SQLite File')}</strong>
              <small>{t('Inspect and edit any .db / .sqlite file locally')}</small>
            </span>
            <Icon name="arrow-right" />
          </button>

          <button type="button" className="ndb-quick-card" onClick={onLaunchSampleSqlite}>
            <span className="ndb-quick-card-icon">
              <Icon name="sparkles" />
            </span>
            <span className="ndb-quick-card-body">
              <strong>{t('Launch Sample SQLite')}</strong>
              <small>{t('Explore pre-seeded customers, products, and orders')}</small>
            </span>
            <Icon name="arrow-right" />
          </button>
        </section>

        <section className="ndb-saved-grid-section">
          <div className="ndb-section-head">
            <h2>{t('Saved Connections')}</h2>
            <span className="ndb-count-pill">{connections.length}</span>
            <div className="ndb-spacer" />
            {onImportConnections && (
              <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={onImportConnections}>
                {t('Import JSON / DBeaver')}
              </button>
            )}
            {onExportConnections && connections.length > 0 && (
              <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={onExportConnections}>
                {t('Export Connections')}
              </button>
            )}
          </div>

          {connections.length === 0 ? (
            <div className="ndb-empty-card">
              <Icon name="unplug" />
              <div>
                <strong>{t('No connections yet')}</strong>
                <p>{t('Create a connection or open a local SQLite database to start querying.')}</p>
              </div>
            </div>
          ) : (
            <div className="ndb-conn-cards">
              {connections.map((conn) => {
                const profile = driverById(conn.engine);
                const isOnline = connectedIds.has(conn.id);
                const isConnecting = connectingId === conn.id;
                const endpoint =
                  conn.engine === 'sqlite'
                    ? conn.sqliteFileName || (conn.sqliteMode === 'demo' ? 'Sample DB' : 'In-Memory')
                    : `${conn.host || '127.0.0.1'}:${conn.port}${conn.database ? ` / ${conn.database}` : ''}`;
                return (
                  <div key={conn.id} className={`ndb-conn-card ${isOnline ? 'is-online' : ''}`}>
                    <button
                      type="button"
                      className="ndb-conn-card-main"
                      disabled={isConnecting}
                      onClick={() => onConnect(conn)}
                    >
                      <span className="ndb-conn-card-icon">
                        <EngineIcon engine={conn.engine} theme={theme} size={28} />
                      </span>
                      <span className="ndb-conn-card-meta">
                        <span className="ndb-conn-card-title">
                          <EnvColorDot color={conn.color} />
                          <strong>{conn.name}</strong>
                          {isOnline && <span className="ndb-online-pill">{t('Connected')}</span>}
                        </span>
                        <small className="ndb-mono">{endpoint}</small>
                        <span className="ndb-conn-card-tags">
                          <span className="ndb-tag">{profile.label}</span>
                          {conn.group && <span className="ndb-tag">{conn.group}</span>}
                          {conn.readOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
                          {conn.sshTunnel.enabled && (
                            <span className="ndb-tag ndb-tag-ssh">SSH{conn.sshTunnel.hostLabel ? `: ${conn.sshTunnel.hostLabel}` : ''}</span>
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ndb-icon-btn ndb-conn-card-edit"
                      title={t('Edit')}
                      aria-label={t('Edit')}
                      onClick={() => onEdit(conn)}
                    >
                      <Icon name="settings" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
