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
  onConnect,
  onEdit,
}: WelcomeViewProps) {
  return (
    <div className="dbx-welcome">
      <div className="dbx-welcome-inner">
        <header className="dbx-welcome-hero">
          <div className="dbx-welcome-mark">
            <Icon name="database" />
          </div>
          <div className="dbx-welcome-copy">
            <h1>{t('Database Workbench')}</h1>
            <p>{t('Connect to PostgreSQL, MySQL, MariaDB, SQLite, ClickHouse, Redis, and MongoDB directly inside Netcatty.')}</p>
          </div>
        </header>

        <section className="dbx-quick-actions" aria-label={t('Quick start')}>
          <button type="button" className="dbx-quick-card dbx-quick-card-primary" onClick={onNewConnection}>
            <span className="dbx-quick-card-icon">
              <Icon name="plus" />
            </span>
            <span className="dbx-quick-card-body">
              <strong>{t('New Connection')}</strong>
              <small>{t('Configure any of 22 engines with TLS & SSH tunnels')}</small>
            </span>
            <Icon name="arrow-right" />
          </button>

          <button type="button" className="dbx-quick-card" onClick={onOpenSqliteFile}>
            <span className="dbx-quick-card-icon">
              <Icon name="folder" />
            </span>
            <span className="dbx-quick-card-body">
              <strong>{t('Open Local SQLite File')}</strong>
              <small>{t('Inspect and edit any .db / .sqlite file locally')}</small>
            </span>
            <Icon name="arrow-right" />
          </button>

          <button type="button" className="dbx-quick-card" onClick={onLaunchSampleSqlite}>
            <span className="dbx-quick-card-icon">
              <Icon name="sparkles" />
            </span>
            <span className="dbx-quick-card-body">
              <strong>{t('Launch Sample SQLite')}</strong>
              <small>{t('Explore pre-seeded customers, products, and orders')}</small>
            </span>
            <Icon name="arrow-right" />
          </button>
        </section>

        <section className="dbx-saved-grid-section">
          <div className="dbx-section-head">
            <h2>{t('Saved Connections')}</h2>
            <span className="dbx-count-pill">{connections.length}</span>
          </div>

          {connections.length === 0 ? (
            <div className="dbx-empty-card">
              <Icon name="unplug" />
              <div>
                <strong>{t('No connections yet')}</strong>
                <p>{t('Create a connection or open a local SQLite database to start querying.')}</p>
              </div>
            </div>
          ) : (
            <div className="dbx-conn-cards">
              {connections.map((conn) => {
                const profile = driverById(conn.engine);
                const isOnline = connectedIds.has(conn.id);
                const isConnecting = connectingId === conn.id;
                const endpoint =
                  conn.engine === 'sqlite'
                    ? conn.sqliteFileName || (conn.sqliteMode === 'demo' ? 'Sample DB' : 'In-Memory')
                    : `${conn.host || '127.0.0.1'}:${conn.port}${conn.database ? ` / ${conn.database}` : ''}`;
                return (
                  <div key={conn.id} className={`dbx-conn-card ${isOnline ? 'is-online' : ''}`}>
                    <button
                      type="button"
                      className="dbx-conn-card-main"
                      disabled={isConnecting}
                      onClick={() => onConnect(conn)}
                    >
                      <span className="dbx-conn-card-icon">
                        <EngineIcon engine={conn.engine} theme={theme} size={28} />
                      </span>
                      <span className="dbx-conn-card-meta">
                        <span className="dbx-conn-card-title">
                          <EnvColorDot color={conn.color} />
                          <strong>{conn.name}</strong>
                          {isOnline && <span className="dbx-online-pill">{t('Connected')}</span>}
                        </span>
                        <small className="dbx-mono">{endpoint}</small>
                        <span className="dbx-conn-card-tags">
                          <span className="dbx-tag">{profile.label}</span>
                          {conn.group && <span className="dbx-tag">{conn.group}</span>}
                          {conn.sshTunnel.enabled && (
                            <span className="dbx-tag dbx-tag-ssh">SSH{conn.sshTunnel.hostLabel ? `: ${conn.sshTunnel.hostLabel}` : ''}</span>
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="dbx-icon-btn dbx-conn-card-edit"
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
