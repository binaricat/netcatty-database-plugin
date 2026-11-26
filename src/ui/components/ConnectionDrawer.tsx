/**
 * Sleek DBX Connection Drawer (`AsidePanel` style, 420px wide) AND standalone modal support.
 * Features:
 * - Visual 22-Engine Picker Grid with category tabs + instant search + crisp DB brand icons
 * - URI / DSN Quick Import bar
 * - Full connection config + encrypted password (`context.secrets`)
 * - TLS / STARTTLS selector + Allow Self-Signed toggle
 * - Netcatty Vault SSH Tunnel selector (`context.vault.selectHosts`) + durable binding badge + Revoke
 * - SQLite local file picker (`context.ui.openFile`) + Sample SQLite option
 * - Live Test Connection (version + latency ms) + Save + Save & Connect
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import { Icon } from '../../Icon';
import { driverById, drivers, type DriverId } from '../../driverRegistry';
import type { TestConnectionResult, TlsMode } from '../../drivers/types';
import { makeDefaultConnection, testSavedConnection } from '../sessionManager';
import {
  isLiveSupportedEngine,
  type EnvColor,
  type SavedConnection,
} from '../types';
import { parseConnectionUri } from '../uriParser';
import { EngineIcon } from './EngineBadge';

type PickerCategory = 'all' | 'relational' | 'nosql' | 'analytics' | 'domestic' | 'local';

const ENV_COLORS: EnvColor[] = ['none', 'blue', 'emerald', 'amber', 'rose', 'purple'];

function matchesPickerCategory(engineId: DriverId, cat: PickerCategory): boolean {
  if (cat === 'all') return true;
  const d = driverById(engineId);
  if (cat === 'local') return d.category === 'lightweight' || d.id === 'duckdb';
  if (cat === 'nosql') return d.category === 'document';
  return d.category === cat;
}

export interface ConnectionDrawerProps {
  context: PluginContext;
  theme: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  editingConnection: SavedConnection | null;
  initialEngine?: DriverId;
  initialPassword?: string;
  standalone?: boolean;
  onClose: () => void;
  onSave: (
    conn: SavedConnection,
    password: string | undefined,
    connectNow: boolean,
    sqliteBytes?: Uint8Array,
  ) => Promise<void>;
}

export function ConnectionDrawer({
  context,
  theme,
  t,
  editingConnection,
  initialEngine,
  initialPassword,
  standalone = false,
  onClose,
  onSave,
}: ConnectionDrawerProps) {
  const [step, setStep] = useState<'picker' | 'form'>(editingConnection ? 'form' : 'picker');
  const [category, setCategory] = useState<PickerCategory>('all');
  const [search, setSearch] = useState('');

  const [draft, setDraft] = useState<SavedConnection>(() =>
    editingConnection ? { ...editingConnection, sshTunnel: { ...editingConnection.sshTunnel } } : makeDefaultConnection(initialEngine ?? 'postgres'),
  );
  const [password, setPassword] = useState<string>(initialPassword ?? '');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [uriInput, setUriInput] = useState('');
  const [uriError, setUriError] = useState<string | null>(null);
  const [sqliteBytes, setSqliteBytes] = useState<Uint8Array | undefined>(undefined);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (initialPassword !== undefined && !passwordTouched) {
      setPassword(initialPassword);
    }
  }, [initialPassword, passwordTouched]);

  const filteredEngines = useMemo(() => {
    const q = search.trim().toLowerCase();
    return drivers.filter((d) => {
      if (!matchesPickerCategory(d.id, category)) return false;
      if (!q) return true;
      return `${d.label} ${d.id} ${d.wireFamily}`.toLowerCase().includes(q);
    });
  }, [category, search]);

  const profile = driverById(draft.engine);
  const liveSupported = isLiveSupportedEngine(draft.engine);
  const isSqlite = draft.engine === 'sqlite';
  const isRedis = draft.engine === 'redis';
  const isMongo = draft.engine === 'mongodb';
  const isClickhouse = draft.engine === 'clickhouse';
  const isNetworkEngine = !isSqlite && draft.engine !== 'duckdb';

  const selectEngine = (engineId: DriverId) => {
    const defaults = makeDefaultConnection(engineId);
    setDraft((prev) => ({
      ...defaults,
      id: editingConnection ? prev.id : defaults.id,
      group: prev.group,
      color: prev.color,
      createdAt: editingConnection ? prev.createdAt : defaults.createdAt,
    }));
    setTestResult(null);
    setFormError(null);
    setStep('form');
  };

  const handleParseUri = () => {
    setUriError(null);
    try {
      const parsed = parseConnectionUri(uriInput);
      const prof = driverById(parsed.engine);
      setDraft((prev) => ({
        ...prev,
        engine: parsed.engine,
        name: prev.name || `${prof.label} (${parsed.host || parsed.database})`,
        host: parsed.host,
        port: parsed.port,
        database: parsed.database || prev.database,
        username: parsed.username,
        tlsMode: parsed.tlsMode,
        redisDb: parsed.redisDb ?? prev.redisDb,
        authSource: parsed.authSource ?? prev.authSource,
        sqliteFileName: parsed.sqliteFileName ?? prev.sqliteFileName,
      }));
      if (parsed.password) {
        setPassword(parsed.password);
        setPasswordTouched(true);
      }
      setTestResult(null);
    } catch (err) {
      setUriError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickVaultHost = async () => {
    setFormError(null);
    try {
      const res = await context.vault.selectHosts({
        title: t('Pick Vault SSH Host'),
      });
      if (res.cancelled) return;
      const picked = res.hosts?.[0];
      if (!picked) return;
      setDraft((prev) => ({
        ...prev,
        sshTunnel: {
          enabled: true,
          hostLabel: picked.metadata.label || picked.metadata.hostname || 'SSH Host',
          target: picked.target,
          expectedRevision: picked.target.revision,
          hostBindingToken: undefined,
        },
      }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeBinding = async () => {
    const token = draft.sshTunnel.hostBindingToken;
    if (token && typeof context.vault?.revokeHostBinding === 'function') {
      await context.vault.revokeHostBinding(token).catch(() => {});
    }
    setDraft((prev) => ({
      ...prev,
      sshTunnel: {
        ...prev.sshTunnel,
        hostBindingToken: undefined,
      },
    }));
  };

  const handlePickSqliteFile = async () => {
    setFormError(null);
    try {
      const res = await context.ui.openFile({
        title: t('Open Local SQLite File'),
        filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'sqlite3', 'db', 's3db'] }],
        readAs: 'bytes',
      });
      if (res.cancelled) return;
      const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(0);
      setSqliteBytes(bytes);
      setDraft((prev) => ({
        ...prev,
        sqliteMode: 'file',
        sqliteFileName: res.name,
        sqliteFileHandleId: res.handleId,
        database: res.name,
        name: prev.name === 'Sample SQLite' || !prev.name ? res.name.replace(/\.(sqlite3?|db|s3db)$/i, '') : prev.name,
      }));
      setTestResult(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setFormError(null);
    try {
      const effectivePw = passwordTouched ? password : (password || undefined);
      const res = await testSavedConnection(context, draft, effectivePw, sqliteBytes, (token) => {
        setDraft((prev) => ({
          ...prev,
          sshTunnel: { ...prev.sshTunnel, hostBindingToken: token },
        }));
      });
      setTestResult(res);
    } catch (err) {
      setTestResult({
        ok: false,
        serverVersion: '',
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (connectNow: boolean) => {
    if (!draft.name.trim()) {
      setFormError('Connection name is required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const nextConn: SavedConnection = {
        ...draft,
        name: draft.name.trim(),
        group: draft.group.trim(),
        host: draft.host.trim(),
        database: draft.database.trim(),
        schema: draft.schema.trim(),
        username: draft.username.trim(),
        hasPassword: passwordTouched ? password.length > 0 : draft.hasPassword,
        updatedAt: Date.now(),
      };
      await onSave(
        nextConn,
        passwordTouched ? password : undefined,
        connectNow,
        sqliteBytes,
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const categories: Array<{ id: PickerCategory; label: string }> = [
    { id: 'all', label: t('All') },
    { id: 'relational', label: t('Relational') },
    { id: 'nosql', label: t('NoSQL') },
    { id: 'analytics', label: t('Analytics') },
    { id: 'domestic', label: t('Domestic') },
    { id: 'local', label: t('Local') },
  ];

  return (
    <aside
      className={
        standalone
          ? 'dbx-drawer dbx-drawer-standalone'
          : step === 'picker'
            ? 'dbx-drawer dbx-drawer-picker'
            : 'dbx-drawer dbx-drawer-connection'
      }
      role="dialog"
      aria-label={editingConnection ? t('Edit Connection') : t('New Connection')}
    >
      <header className="dbx-drawer-header">
        <div className="dbx-drawer-title-group">
          {step === 'form' && !editingConnection && (
            <button
              type="button"
              className="dbx-icon-btn dbx-icon-flip"
              title={t('Back')}
              aria-label={t('Back')}
              onClick={() => setStep('picker')}
            >
              <Icon name="chevron-right" />
            </button>
          )}
          <div>
            <h2>{step === 'picker' ? t('Select Database Engine') : (editingConnection ? t('Edit Connection') : t('New Connection'))}</h2>
            <p className="dbx-drawer-subtitle">
              {step === 'picker'
                ? '22 engines · Pure-TS wire protocols + Netcatty TLS & Vault SSH'
                : `${profile.label}${liveSupported ? '' : ' · Catalog'}`}
            </p>
          </div>
        </div>
        {!standalone && (
          <button type="button" className="dbx-icon-btn" aria-label={t('Close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        )}
      </header>

      {step === 'picker' ? (
        <div className="dbx-drawer-body">
          <div className="dbx-picker-search">
            <Icon name="search" />
            <input
              type="text"
              placeholder={t('Search engines...')}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
          </div>

          <div className="dbx-pill-tabs" role="tablist">
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={category === cat.id}
                className={`dbx-pill-tab ${category === cat.id ? 'is-active' : ''}`}
                onClick={() => setCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="dbx-engine-picker-grid">
            {filteredEngines.map((eng) => {
              const supported = isLiveSupportedEngine(eng.id);
              const selected = draft.engine === eng.id;
              return (
                <button
                  key={eng.id}
                  type="button"
                  className={`dbx-engine-tile ${selected ? 'is-selected' : ''} ${supported ? '' : 'is-catalog'}`}
                  onClick={() => selectEngine(eng.id)}
                >
                  <span className="engine-mark dbx-engine-tile-mark">
                    <EngineIcon engine={eng.id} theme={theme} size={26} />
                  </span>
                  <strong className="dbx-engine-tile-name">{eng.label}</strong>
                  <span className={`dbx-engine-tile-badge ${supported ? 'is-ready' : ''}`}>
                    {supported ? t('Ready') : t('Catalog')}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="dbx-drawer-body dbx-form-body">
          {/* Selected Engine Banner */}
          <div className="dbx-selected-engine-bar">
            <EngineIcon engine={draft.engine} theme={theme} size={26} />
            <div className="dbx-selected-engine-info">
              <strong>{profile.label}</strong>
              <small>
                {liveSupported
                  ? isSqlite
                    ? 'Local SQLite 3 (sql.js)'
                    : `${profile.wireFamily !== 'unpackaged' ? profile.wireFamily.toUpperCase() : profile.id.toUpperCase()} wire protocol`
                  : 'Catalog entry — wire protocol not packaged yet'}
              </small>
            </div>
            <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={() => setStep('picker')}>
              {t('Edit')}
            </button>
          </div>

          {/* URI / DSN Quick Import */}
          {isNetworkEngine && (
            <div className="dbx-uri-box">
              <label className="dbx-field-label">{t('Import from URI / DSN')}</label>
              <div className="dbx-inline-row">
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder="postgres://user:pass@127.0.0.1:5432/mydb"
                  value={uriInput}
                  onChange={(e) => setUriInput(e.currentTarget.value)}
                />
                <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={handleParseUri}>
                  {t('Parse')}
                </button>
              </div>
              {uriError && <p className="dbx-field-error">{uriError}</p>}
            </div>
          )}

          {/* Basic Metadata */}
          <div className="dbx-form-grid">
            <label className="dbx-field">
              <span>{t('Name')}</span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              />
            </label>
            <label className="dbx-field">
              <span>{t('Folder / Group')}</span>
              <input
                type="text"
                placeholder="Production / Local"
                value={draft.group}
                onChange={(e) => setDraft({ ...draft, group: e.currentTarget.value })}
              />
            </label>
          </div>

          <div className="dbx-field">
            <span>{t('Color Tag')}</span>
            <div className="dbx-color-swatches">
              {ENV_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={draft.color === c}
                  className={`dbx-color-swatch dbx-swatch-${c} ${draft.color === c ? 'is-chosen' : ''}`}
                  onClick={() => setDraft({ ...draft, color: c })}
                />
              ))}
            </div>
          </div>

          {/* SQLite Source Picker */}
          {isSqlite && (
            <div className="dbx-section-box">
              <label className="dbx-field">
                <span>{t('SQLite Source')}</span>
                <select
                  value={draft.sqliteMode}
                  onChange={(e) =>
                    setDraft({ ...draft, sqliteMode: e.currentTarget.value as SavedConnection['sqliteMode'] })
                  }
                >
                  <option value="demo">{t('Sample Shop Database (In-Memory)')}</option>
                  <option value="memory">{t('Empty In-Memory Database')}</option>
                  <option value="file">{t('Local .db / .sqlite File')}</option>
                </select>
              </label>
              {draft.sqliteMode === 'file' && (
                <div className="dbx-file-row">
                  <span className="dbx-mono dbx-truncate">
                    {draft.sqliteFileName || 'No file chosen'}
                  </span>
                  <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={() => void handlePickSqliteFile()}>
                    <Icon name="folder" />
                    {t('Choose SQLite File...')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Network Endpoint Fields */}
          {isNetworkEngine && (
            <>
              <div className="dbx-form-grid dbx-grid-host-port">
                <label className="dbx-field">
                  <span>{t('Host')}</span>
                  <input
                    type="text"
                    className="dbx-mono"
                    placeholder="127.0.0.1"
                    value={draft.host}
                    onChange={(e) => setDraft({ ...draft, host: e.currentTarget.value })}
                  />
                </label>
                <label className="dbx-field">
                  <span>{t('Port')}</span>
                  <input
                    type="number"
                    className="dbx-mono"
                    min={1}
                    max={65535}
                    value={draft.port}
                    onChange={(e) => setDraft({ ...draft, port: Number(e.currentTarget.value) || profile.defaultPort })}
                  />
                </label>
              </div>

              {!isRedis && (
                <div className="dbx-form-grid">
                  <label className="dbx-field">
                    <span>{t('Database / Schema')}</span>
                    <input
                      type="text"
                      className="dbx-mono"
                      placeholder={isMongo ? 'shop_demo' : 'postgres'}
                      value={draft.database}
                      onChange={(e) => setDraft({ ...draft, database: e.currentTarget.value })}
                    />
                  </label>
                  {isMongo && (
                    <label className="dbx-field">
                      <span>{t('Auth Source')}</span>
                      <input
                        type="text"
                        className="dbx-mono"
                        placeholder="admin"
                        value={draft.authSource}
                        onChange={(e) => setDraft({ ...draft, authSource: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  {isClickhouse && (
                    <label className="dbx-field">
                      <span>HTTP Path</span>
                      <input
                        type="text"
                        className="dbx-mono"
                        placeholder="/"
                        value={draft.httpPath}
                        onChange={(e) => setDraft({ ...draft, httpPath: e.currentTarget.value })}
                      />
                    </label>
                  )}
                </div>
              )}

              {isRedis && (
                <label className="dbx-field">
                  <span>{t('Redis DB Index')}</span>
                  <select
                    className="dbx-mono"
                    value={draft.redisDb}
                    onChange={(e) => setDraft({ ...draft, redisDb: Number(e.currentTarget.value) })}
                  >
                    {Array.from({ length: 16 }, (_, i) => (
                      <option key={i} value={i}>{`DB ${i}`}</option>
                    ))}
                  </select>
                </label>
              )}

              <div className="dbx-form-grid">
                <label className="dbx-field">
                  <span>{t('Username')}</span>
                  <input
                    type="text"
                    className="dbx-mono"
                    placeholder={isRedis ? '(optional ACL user)' : 'netcatty'}
                    value={draft.username}
                    onChange={(e) => setDraft({ ...draft, username: e.currentTarget.value })}
                  />
                </label>
                <label className="dbx-field">
                  <span>{t('Password')}</span>
                  <input
                    type="password"
                    className="dbx-mono"
                    placeholder={draft.hasPassword && !passwordTouched ? '•••••••• (saved)' : ''}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.currentTarget.value);
                      setPasswordTouched(true);
                    }}
                  />
                </label>
              </div>
              <p className="dbx-hint-line">
                <Icon name="shield" />
                {t('Stored encrypted in Netcatty Secrets')}
              </p>

              {/* TLS / STARTTLS Section */}
              <div className="dbx-section-box">
                <label className="dbx-field">
                  <span>{t('TLS / Encryption')}</span>
                  <select
                    value={draft.tlsMode}
                    onChange={(e) => setDraft({ ...draft, tlsMode: e.currentTarget.value as TlsMode })}
                  >
                    <option value="disable">{t('Off')}</option>
                    <option value="prefer">{t('Prefer STARTTLS')}</option>
                    <option value="require">{t('Require STARTTLS')}</option>
                    <option value="verify-full">{t('Direct TLS')}</option>
                  </select>
                </label>
                {draft.tlsMode !== 'disable' && (
                  <label className="dbx-checkbox-row">
                    <input
                      type="checkbox"
                      checked={draft.allowSelfSigned}
                      onChange={(e) => setDraft({ ...draft, allowSelfSigned: e.currentTarget.checked })}
                    />
                    <span>{t('Allow self-signed certificate (prompts for fingerprint approval)')}</span>
                  </label>
                )}
              </div>

              {/* Netcatty Vault SSH Tunnel Section */}
              <div className="dbx-section-box">
                <label className="dbx-checkbox-row dbx-section-toggle">
                  <input
                    type="checkbox"
                    checked={draft.sshTunnel.enabled}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        sshTunnel: { ...draft.sshTunnel, enabled: e.currentTarget.checked },
                      })
                    }
                  />
                  <strong>{t('Netcatty Vault SSH Tunnel')}</strong>
                </label>
                {draft.sshTunnel.enabled && (
                  <div className="dbx-ssh-panel">
                    {draft.sshTunnel.hostLabel ? (
                      <div className="dbx-ssh-bound-row">
                        <span className="dbx-tag dbx-tag-ssh">
                          <Icon name="server" />
                          {draft.sshTunnel.hostLabel}
                        </span>
                        {draft.sshTunnel.hostBindingToken && (
                          <span className="dbx-tag dbx-tag-ok">{t('Durable tunnel bound')}</span>
                        )}
                      </div>
                    ) : null}
                    <div className="dbx-inline-row">
                      <button
                        type="button"
                        className="dbx-btn dbx-btn-secondary dbx-btn-sm"
                        onClick={() => void handlePickVaultHost()}
                      >
                        <Icon name="server" />
                        {draft.sshTunnel.hostLabel ? t('Change Host') : t('Pick Vault SSH Host')}
                      </button>
                      {draft.sshTunnel.hostBindingToken && (
                        <button
                          type="button"
                          className="dbx-btn dbx-btn-ghost dbx-btn-sm"
                          onClick={() => void handleRevokeBinding()}
                        >
                          {t('Revoke Binding')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Test Result & Errors */}
          {testResult && (
            <div className={`dbx-banner ${testResult.ok ? 'dbx-banner-success' : 'dbx-banner-error'}`} role="status">
              <Icon name={testResult.ok ? 'check' : 'alert-circle'} />
              <div>
                <strong>
                  {testResult.ok
                    ? `${testResult.serverVersion || profile.label} · ${testResult.latencyMs} ms${testResult.tlsActive ? ' · TLS' : ''}`
                    : 'Connection failed'}
                </strong>
                {!testResult.ok && testResult.error && <p>{testResult.error}</p>}
              </div>
            </div>
          )}
          {formError && (
            <div className="dbx-banner dbx-banner-error" role="alert">
              <Icon name="alert-circle" />
              <span>{formError}</span>
            </div>
          )}
        </div>
      )}

      {step === 'form' && (
        <footer className="dbx-drawer-footer">
          <button
            type="button"
            className="dbx-btn dbx-btn-secondary"
            disabled={!liveSupported || testing || saving}
            onClick={() => void handleTest()}
          >
            <Icon name={testing ? 'loader' : 'play'} />
            {testing ? t('Testing...') : t('Test Connection')}
          </button>
          <div className="dbx-spacer" />
          <button
            type="button"
            className="dbx-btn dbx-btn-secondary"
            disabled={saving}
            onClick={() => void handleSubmit(false)}
          >
            {t('Save')}
          </button>
          <button
            type="button"
            className="dbx-btn dbx-btn-primary"
            disabled={!liveSupported || saving}
            onClick={() => void handleSubmit(true)}
          >
            {t('Save & Connect')}
          </button>
        </footer>
      )}
    </aside>
  );
}
