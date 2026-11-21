import React, { useEffect, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import type { SelectedSshHost } from './hostStreamEndpoint';
import type { SshHostSqlEngine } from './sshHostSqlSession';
import { useSshHostDatabase } from './useSshHostDatabase';
import type { Translate } from './i18n';

const DEFAULT_ENDPOINTS: Record<SshHostSqlEngine, string> = {
  postgres: 'tcp://127.0.0.1:5432',
  mysql: 'tcp://127.0.0.1:3306',
};

export function SshHostDatabasePanel({
  context,
  selectedHost,
  t,
}: {
  context: PluginContext;
  selectedHost: SelectedSshHost;
  t: Translate;
}) {
  const vm = useSshHostDatabase(context, selectedHost);
  const [engine, setEngine] = useState<SshHostSqlEngine>('postgres');
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINTS.postgres);
  const [database, setDatabase] = useState('postgres');
  const [schema, setSchema] = useState('public');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    setUsername('');
    setPassword('');
  }, [selectedHost]);

  const handleEngineChange = (next: SshHostSqlEngine) => {
    setEngine(next);
    setEndpoint(DEFAULT_ENDPOINTS[next]);
    if (next === 'postgres') {
      if (!database || database === 'mysql') setDatabase('postgres');
      setSchema('public');
    } else {
      if (database === 'postgres') setDatabase('');
      setSchema('');
    }
  };

  const connected = vm.status === 'connected';
  const connect = () => {
    const currentPassword = password;
    const currentUsername = username.trim();
    setPassword('');
    void vm.controller.connect({
      engine,
      endpoint,
      database: database.trim(),
      schema: engine === 'postgres' ? (schema.trim() || 'public') : database.trim(),
      username: currentUsername,
      password: currentPassword,
    });
  };

  if (!vm.hostStreamsEnabled) {
    return (
      <section className="redis-workbench" aria-label={t('SSH host database')}>
        <header className="results-heading">
          <strong>{t('SSH host database')}</strong>
          <span role="status">{t('Unavailable')}</span>
        </header>
        <p>{t('This Netcatty host has not enabled network.host-byte-streams. Upgrade Netcatty or enable host byte streams to connect databases over SSH.')}</p>
      </section>
    );
  }

  return (
    <section className="redis-workbench" aria-label={t('SSH host database')}>
      <header className="results-heading">
        <strong>{`${t('SSH host database')} · ${selectedHost.metadata.label.slice(0, 128)}`}</strong>
        <span className={`redis-connection-status ${connected ? 'is-connected' : ''}`} role="status">
          {vm.status === 'connected'
            ? t('Connected · SSH stream / read only')
            : vm.status === 'connecting'
              ? t('Connecting…')
              : vm.status === 'closed'
                ? t('Connection closed')
                : t('Not connected')}
        </span>
        <button
          className="secondary toolbar-button"
          disabled={vm.status === 'disconnected'}
          onClick={() => vm.controller.disconnect()}
        >
          {vm.status === 'connecting' ? t('Cancel connection') : t('Disconnect')}
        </button>
      </header>

      <p className="hint">
        {t('Connects through the selected Netcatty SSH host using bounded host byte streams. Netcatty confirms every destination; SSH credentials stay in Netcatty.')}
      </p>

      <div className="redis-connection-fields">
        <label>
          {t('Engine')}
          <select
            aria-label={t('SSH database engine')}
            value={engine}
            disabled={connected || vm.busy}
            onChange={(event) => handleEngineChange(event.currentTarget.value as SshHostSqlEngine)}
          >
            <option value="postgres">PostgreSQL (SCRAM-SHA-256)</option>
            <option value="mysql">MySQL / MariaDB</option>
          </select>
        </label>
        <label>
          {t('Destination on SSH host')}
          <input
            aria-label={t('Database destination endpoint')}
            autoComplete="off"
            maxLength={512}
            placeholder={DEFAULT_ENDPOINTS[engine]}
            value={endpoint}
            disabled={connected || vm.busy}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
          />
        </label>
        <label>
          {t('Database')}
          <input
            aria-label={t('Database name')}
            autoComplete="off"
            maxLength={128}
            value={database}
            disabled={connected || vm.busy}
            onChange={(event) => setDatabase(event.currentTarget.value)}
          />
        </label>
        {engine === 'postgres' && (
          <label>
            {t('Schema')}
            <input
              aria-label={t('PostgreSQL schema')}
              autoComplete="off"
              maxLength={128}
              value={schema}
              disabled={connected || vm.busy}
              onChange={(event) => setSchema(event.currentTarget.value)}
            />
          </label>
        )}
        <label>
          {t('Username')}
          <input
            aria-label={t('Database username')}
            autoComplete="off"
            maxLength={128}
            value={username}
            disabled={connected || vm.busy}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
        </label>
        <label>
          {t('Password')}
          <input
            aria-label={t('Database password')}
            type="password"
            autoComplete="off"
            maxLength={1024}
            value={password}
            disabled={connected || vm.busy}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        <button
          className="secondary toolbar-button"
          disabled={connected || vm.busy || !endpoint.trim() || !database.trim() || !username.trim()}
          onClick={connect}
        >
          {t('Connect DB via SSH')}
        </button>
      </div>

      <p className="hint">
        {t('Database credentials are used for this session only and are never saved. All queries run inside bounded read-only transactions.')}
      </p>
      {vm.error && (
        <p role="status">{t('Database operation: {code}. No automatic retry.', { code: vm.error })}</p>
      )}

      {connected && (
        <>
          <div className="results-heading">
            <button
              className="secondary toolbar-button"
              disabled={vm.busy}
              onClick={() => void vm.controller.listTables(engine === 'postgres' ? schema : database)}
            >
              {t('List tables')}
            </button>
            {vm.selectedTable && (
              <button
                className="secondary toolbar-button"
                disabled={vm.busy || !vm.columns.length}
                onClick={() => void vm.controller.readSelectedTable(50)}
              >
                {t('Read rows (read-only)')}
              </button>
            )}
          </div>

          <div className="redis-browser-grid">
            <div aria-label={t('Tables')}>
              {vm.tables.map((item) => (
                <button
                  key={item.name}
                  className="secondary toolbar-button"
                  aria-pressed={vm.selectedTable === item.name}
                  disabled={vm.busy}
                  onClick={() => void vm.controller.selectTable(item.name)}
                >
                  {`${item.name} (${item.kind})`}
                </button>
              ))}
              {!vm.tables.length && <p className="hint">{t('Click List tables to inspect visible tables.')}</p>}
            </div>

            <section aria-label={t('Table preview')}>
              {vm.selectedTable && (
                <>
                  <strong>{`${vm.schema}.${vm.selectedTable}`}</strong>
                  {vm.columns.length > 0 && (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>{t('Column')}</th>
                            <th>{t('Type')}</th>
                            <th>{t('Nullable')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vm.columns.map((col) => (
                            <tr key={col.name}>
                              <td>{col.name}</td>
                              <td>{col.dataType}</td>
                              <td>{col.nullable ? t('Yes') : t('No')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {vm.result && (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {vm.result.columns.map((col) => <th key={col}>{col}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {vm.result.rows.map((row, idx) => (
                            <tr key={idx}>
                              {row.map((cell, cIdx) => (
                                <td key={cIdx}>{cell === null ? 'NULL' : String(cell)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
