/**
 * Sleek Database Connection Drawer (`AsidePanel` style, 420px wide) AND standalone modal support.
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

type PickerCategory =
  | 'all'
  | 'relational'
  | 'graph'
  | 'nosql'
  | 'timeseries'
  | 'analytics'
  | 'domestic'
  | 'registry'
  | 'messaging'
  | 'local';

const ENV_COLORS: EnvColor[] = ['none', 'blue', 'emerald', 'amber', 'rose', 'purple'];
const PICKER_PAGE_SIZE = 24;

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
  const [pickerPage, setPickerPage] = useState(0);

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

  const totalPickerPages = Math.max(1, Math.ceil(filteredEngines.length / PICKER_PAGE_SIZE));
  const safePickerPage = Math.min(pickerPage, totalPickerPages - 1);
  const pageStart = safePickerPage * PICKER_PAGE_SIZE;
  const visibleEngines = filteredEngines.slice(pageStart, pageStart + PICKER_PAGE_SIZE);

  const profile = driverById(draft.engine);
  const selectedVariant = profile.variants?.find((v) => v.id === draft.variant) ?? profile.variants?.[0];
  const liveSupported = isLiveSupportedEngine(draft.engine);
  const variantLiveSupported = liveSupported && (!selectedVariant || selectedVariant.wireFamily !== 'unpackaged');
  const isSqlite = draft.engine === 'sqlite';
  const isRedis = draft.engine === 'redis';
  const isMongo = draft.engine === 'mongodb' || draft.engine === 'mongodb-legacy';
  const isNeo4j = draft.engine === 'neo4j';
  const isClickhouse = draft.engine === 'clickhouse';
  const hasApiKeyField = profile.fields.includes('apiKey');
  const hasOrgField = profile.fields.includes('org');
  const hasNamespaceField = profile.fields.includes('namespace');
  const hasAccountIdField = profile.fields.includes('accountId');
  const hasWarehouseIdField = profile.fields.includes('warehouseId');
  const hasRegionField = profile.fields.includes('region');
  const hasVhostField = profile.fields.includes('vhost');
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
      setFormError(t('Connection name is required.'));
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
    { id: 'graph', label: t('Graph & AI') },
    { id: 'nosql', label: t('NoSQL & Search') },
    { id: 'timeseries', label: t('Time-Series') },
    { id: 'analytics', label: t('Analytics') },
    { id: 'domestic', label: t('Domestic') },
    { id: 'registry', label: t('Registry / KV') },
    { id: 'messaging', label: t('Messaging / MQ') },
    { id: 'local', label: t('Local / Edge') },
  ];

  return (
    <aside
      className={
        standalone
          ? 'ndb-drawer ndb-drawer-standalone'
          : step === 'picker'
            ? 'ndb-drawer ndb-drawer-picker'
            : 'ndb-drawer ndb-drawer-connection'
      }
      role="dialog"
      aria-label={editingConnection ? t('Edit Connection') : t('New Connection')}
    >
      <header className="ndb-drawer-header">
        <div className="ndb-drawer-title-group">
          {step === 'form' && !editingConnection && (
            <button
              type="button"
              className="ndb-icon-btn ndb-icon-flip"
              title={t('Back')}
              aria-label={t('Back')}
              onClick={() => setStep('picker')}
            >
              <Icon name="chevron-right" />
            </button>
          )}
          <div>
            <h2>{step === 'picker' ? t('Select Database Engine') : (editingConnection ? t('Edit Connection') : t('New Connection'))}</h2>
            <p className="ndb-drawer-subtitle">
              {step === 'picker'
                ? `${drivers.length} engines · Pure-TS wire protocols + Netcatty TLS & Vault SSH`
                : `${profile.label}${liveSupported ? '' : ' · Catalog'}`}
            </p>
          </div>
        </div>
        {!standalone && (
          <button type="button" className="ndb-icon-btn" aria-label={t('Close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        )}
      </header>

      {step === 'picker' ? (
        <div className="ndb-drawer-body">
          <div className="ndb-picker-search">
            <Icon name="search" />
            <input
              type="text"
              placeholder={t('Search engines...')}
              value={search}
              onChange={(e) => {
                setSearch(e.currentTarget.value);
                setPickerPage(0);
              }}
            />
          </div>

          <div className="ndb-pill-tabs" role="tablist">
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={category === cat.id}
                className={`ndb-pill-tab ${category === cat.id ? 'is-active' : ''}`}
                onClick={() => {
                  setCategory(cat.id);
                  setPickerPage(0);
                }}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="ndb-engine-picker-grid">
            {visibleEngines.map((eng) => {
              const supported = isLiveSupportedEngine(eng.id);
              const selected = draft.engine === eng.id;
              return (
                <button
                  key={eng.id}
                  type="button"
                  className={`ndb-engine-tile ${selected ? 'is-selected' : ''} ${supported ? '' : 'is-catalog'}`}
                  onClick={() => selectEngine(eng.id)}
                >
                  <span className="engine-mark ndb-engine-tile-mark">
                    <EngineIcon engine={eng.id} theme={theme} size={26} />
                  </span>
                  <strong className="ndb-engine-tile-name">{eng.label}</strong>
                  <span className={`ndb-engine-tile-badge ${supported ? 'is-ready' : ''}`}>
                    {supported ? t('Ready') : t('Catalog')}
                  </span>
                </button>
              );
            })}
          </div>

          {totalPickerPages > 1 && (
            <div className="ndb-picker-pager">
              <span className="ndb-muted ndb-mono">
                {`${pageStart + 1}–${Math.min(pageStart + visibleEngines.length, filteredEngines.length)} / ${filteredEngines.length}`}
              </span>
              <div className="ndb-inline-row">
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                  disabled={safePickerPage === 0}
                  onClick={() => setPickerPage((p) => Math.max(0, p - 1))}
                >
                  {t('Previous')}
                </button>
                <span className="ndb-muted ndb-mono">{`${safePickerPage + 1} / ${totalPickerPages}`}</span>
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                  disabled={safePickerPage >= totalPickerPages - 1}
                  onClick={() => setPickerPage((p) => Math.min(totalPickerPages - 1, p + 1))}
                >
                  {t('Next')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="ndb-drawer-body ndb-form-body">
          {/* Selected Engine Banner */}
          <div className="ndb-selected-engine-bar">
            <EngineIcon engine={draft.engine} theme={theme} size={26} />
            <div className="ndb-selected-engine-info">
              <strong>{profile.label}</strong>
              <small>
                {variantLiveSupported
                  ? isSqlite
                    ? 'Local SQLite 3 (sql.js)'
                    : `${(selectedVariant?.wireFamily && selectedVariant.wireFamily !== 'unpackaged' ? selectedVariant.wireFamily : profile.wireFamily !== 'unpackaged' ? profile.wireFamily : profile.id).toUpperCase()} wire protocol`
                  : selectedVariant && selectedVariant.wireFamily === 'unpackaged'
                    ? `${selectedVariant.label} — native wire protocol not packaged yet`
                    : 'Catalog entry — wire protocol not packaged yet'}
              </small>
            </div>
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={() => setStep('picker')}>
              {t('Edit')}
            </button>
          </div>

          {profile.variants && profile.variants.length > 1 && (
            <label className="ndb-field">
              <span>{t('Protocol Variant')}</span>
              <select
                className="ndb-mono"
                value={selectedVariant?.id ?? ''}
                onChange={(e) => {
                  const nextId = e.currentTarget.value;
                  const nextVar = profile.variants?.find((v) => v.id === nextId);
                  setDraft({
                    ...draft,
                    variant: nextId,
                    port: nextVar?.defaultPort || draft.port,
                  });
                  setTestResult(null);
                }}
              >
                {profile.variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {`${v.label}${v.wireFamily === 'unpackaged' ? ` (${t('Catalog')})` : ''}`}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* URI / DSN Quick Import */}
          {isNetworkEngine && (
            <div className="ndb-uri-box">
              <label className="ndb-field-label">{t('Import from URI / DSN')}</label>
              <div className="ndb-inline-row">
                <input
                  type="text"
                  className="ndb-mono"
                  placeholder="postgres://user:pass@127.0.0.1:5432/mydb"
                  value={uriInput}
                  onChange={(e) => setUriInput(e.currentTarget.value)}
                />
                <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={handleParseUri}>
                  {t('Parse')}
                </button>
              </div>
              {uriError && <p className="ndb-field-error">{uriError}</p>}
            </div>
          )}

          {/* Basic Metadata */}
          <div className="ndb-form-grid">
            <label className="ndb-field">
              <span>{t('Name')}</span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              />
            </label>
            <label className="ndb-field">
              <span>{t('Folder / Group')}</span>
              <input
                type="text"
                placeholder="Production / Local"
                value={draft.group}
                onChange={(e) => setDraft({ ...draft, group: e.currentTarget.value })}
              />
            </label>
          </div>

          <div className="ndb-field">
            <span>{t('Color Tag')}</span>
            <div className="ndb-color-swatches">
              {ENV_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={draft.color === c}
                  className={`ndb-color-swatch ndb-swatch-${c} ${draft.color === c ? 'is-chosen' : ''}`}
                  onClick={() => setDraft({ ...draft, color: c })}
                />
              ))}
            </div>
          </div>

          {/* Read-Only / Safe Mode (P0-2) */}
          <div className="ndb-section-box">
            <label className="ndb-checkbox-row ndb-section-toggle">
              <input
                type="checkbox"
                checked={Boolean(draft.readOnly)}
                onChange={(e) => setDraft({ ...draft, readOnly: e.currentTarget.checked })}
              />
              <Icon name="shield" />
              <strong>{t('Read-Only Mode')}</strong>
            </label>
            <p className="ndb-hint-line">{t('Block all INSERT, UPDATE, DELETE, DDL, and NoSQL write operations')}</p>
          </div>

          {/* SQLite Source Picker */}
          {isSqlite && (
            <div className="ndb-section-box">
              <label className="ndb-field">
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
                <div className="ndb-file-row">
                  <span className="ndb-mono ndb-truncate">
                    {draft.sqliteFileName || t('No file chosen')}
                  </span>
                  <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={() => void handlePickSqliteFile()}>
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
              <div className="ndb-form-grid ndb-grid-host-port">
                <label className="ndb-field">
                  <span>{t('Host')}</span>
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder="127.0.0.1"
                    value={draft.host}
                    onChange={(e) => setDraft({ ...draft, host: e.currentTarget.value })}
                  />
                </label>
                <label className="ndb-field">
                  <span>{t('Port')}</span>
                  <input
                    type="number"
                    className="ndb-mono"
                    min={1}
                    max={65535}
                    value={draft.port}
                    onChange={(e) => setDraft({ ...draft, port: Number(e.currentTarget.value) || profile.defaultPort })}
                  />
                </label>
              </div>

              {!isRedis && (
                <div className="ndb-form-grid">
                  <label className="ndb-field">
                    <span>{t('Database / Schema')}</span>
                    <input
                      type="text"
                      className="ndb-mono"
                      placeholder={isMongo ? 'shop_demo' : 'postgres'}
                      value={draft.database}
                      onChange={(e) => setDraft({ ...draft, database: e.currentTarget.value })}
                    />
                  </label>
                  {isMongo && (
                    <label className="ndb-field">
                      <span>{t('Auth Source')}</span>
                      <input
                        type="text"
                        className="ndb-mono"
                        placeholder="admin"
                        value={draft.authSource}
                        onChange={(e) => setDraft({ ...draft, authSource: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  {isClickhouse && (
                    <label className="ndb-field">
                      <span>HTTP Path</span>
                      <input
                        type="text"
                        className="ndb-mono"
                        placeholder="/"
                        value={draft.httpPath}
                        onChange={(e) => setDraft({ ...draft, httpPath: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  {isNeo4j && (
                    <label className="ndb-field">
                      <span>{t('Protocol')}</span>
                      <select
                        className="ndb-mono"
                        value={draft.protocol ?? 'bolt'}
                        onChange={(e) => {
                          const proto = e.currentTarget.value as 'bolt' | 'http';
                          setDraft({
                            ...draft,
                            protocol: proto,
                            port: proto === 'http' && draft.port === 7687 ? 7474 : proto === 'bolt' && draft.port === 7474 ? 7687 : draft.port,
                          });
                        }}
                      >
                        <option value="bolt">Bolt Binary (7687)</option>
                        <option value="http">HTTP Cypher API (7474)</option>
                      </select>
                    </label>
                  )}
                  {hasOrgField && (
                    <label className="ndb-field">
                      <span>{t('Organization')}</span>
                      <input
                        type="text"
                        className="ndb-mono"
                        placeholder="my-org"
                        value={draft.org ?? ''}
                        onChange={(e) => setDraft({ ...draft, org: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  {hasNamespaceField && (
                    <label className="ndb-field">
                      <span>{t('Namespace')}</span>
                      <input
                        type="text"
                        className="ndb-mono"
                        placeholder="public"
                        value={draft.namespace ?? ''}
                        onChange={(e) => setDraft({ ...draft, namespace: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  {hasAccountIdField && (
                    <label className="ndb-field">
                      <span>{t('Account / Project ID')}</span>
                      <input
                        type="text"
                        className="ndb-mono"
                        placeholder="account-or-project-id"
                        value={draft.accountId ?? ''}
                        onChange={(e) => setDraft({ ...draft, accountId: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  {hasWarehouseIdField && (
                    <label className="ndb-field">
                      <span>{t('Warehouse ID')}</span>
                      <input
                        type="text"
                        className="ndb-mono"
                        placeholder="warehouse-id"
                        value={draft.warehouseId ?? ''}
                        onChange={(e) => setDraft({ ...draft, warehouseId: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  {hasRegionField && (
                    <label className="ndb-field">
                      <span>{t('Region')}</span>
                      <input
                        type="text"
                        className="ndb-mono"
                        placeholder="us-east-1"
                        value={draft.region ?? ''}
                        onChange={(e) => setDraft({ ...draft, region: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  {hasVhostField && (
                    <label className="ndb-field">
                      <span>{t('Virtual Host')}</span>
                      <input
                        type="text"
                        className="ndb-mono"
                        placeholder="/"
                        value={draft.vhost ?? '/'}
                        onChange={(e) => setDraft({ ...draft, vhost: e.currentTarget.value })}
                      />
                    </label>
                  )}
                </div>
              )}

              {hasApiKeyField && (
                <label className="ndb-field">
                  <span>{t('API Key / Token')}</span>
                  <input
                    type="password"
                    className="ndb-mono"
                    placeholder="Optional bearer token or API key"
                    value={draft.apiKey ?? ''}
                    onChange={(e) => setDraft({ ...draft, apiKey: e.currentTarget.value })}
                  />
                </label>
              )}

              {isRedis && (
                <label className="ndb-field">
                  <span>{t('Redis DB Index')}</span>
                  <select
                    className="ndb-mono"
                    value={draft.redisDb}
                    onChange={(e) => setDraft({ ...draft, redisDb: Number(e.currentTarget.value) })}
                  >
                    {Array.from({ length: 16 }, (_, i) => (
                      <option key={i} value={i}>{`DB ${i}`}</option>
                    ))}
                  </select>
                </label>
              )}

              <div className="ndb-form-grid">
                <label className="ndb-field">
                  <span>{t('Username')}</span>
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder={isRedis ? '(optional ACL user)' : 'netcatty'}
                    value={draft.username}
                    onChange={(e) => setDraft({ ...draft, username: e.currentTarget.value })}
                  />
                </label>
                <label className="ndb-field">
                  <span>{t('Password')}</span>
                  <input
                    type="password"
                    className="ndb-mono"
                    placeholder={draft.hasPassword && !passwordTouched ? '•••••••• (saved)' : ''}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.currentTarget.value);
                      setPasswordTouched(true);
                    }}
                  />
                </label>
              </div>
              <p className="ndb-hint-line">
                <Icon name="shield" />
                {t('Stored encrypted in Netcatty Secrets')}
              </p>

              {/* TLS / STARTTLS Section */}
              <div className="ndb-section-box">
                <label className="ndb-field">
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
                  <label className="ndb-checkbox-row">
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
              <div className="ndb-section-box">
                <label className="ndb-checkbox-row ndb-section-toggle">
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
                  <div className="ndb-ssh-panel">
                    {draft.sshTunnel.hostLabel ? (
                      <div className="ndb-ssh-bound-row">
                        <span className="ndb-tag ndb-tag-ssh">
                          <Icon name="server" />
                          {draft.sshTunnel.hostLabel}
                        </span>
                        {draft.sshTunnel.hostBindingToken && (
                          <span className="ndb-tag ndb-tag-ok">{t('Durable tunnel bound')}</span>
                        )}
                      </div>
                    ) : null}
                    <div className="ndb-inline-row">
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                        onClick={() => void handlePickVaultHost()}
                      >
                        <Icon name="server" />
                        {draft.sshTunnel.hostLabel ? t('Change Host') : t('Pick Vault SSH Host')}
                      </button>
                      {draft.sshTunnel.hostBindingToken && (
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-sm"
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
            <div className={`ndb-banner ${testResult.ok ? 'ndb-banner-success' : 'ndb-banner-error'}`} role="status">
              <Icon name={testResult.ok ? 'check' : 'alert-circle'} />
              <div>
                <strong>
                  {testResult.ok
                    ? `${testResult.serverVersion || profile.label} · ${testResult.latencyMs} ms${testResult.tlsActive ? ' · TLS' : ''}`
                    : t('Connection failed')}
                </strong>
                {!testResult.ok && testResult.error && <p>{testResult.error}</p>}
              </div>
            </div>
          )}
          {formError && (
            <div className="ndb-banner ndb-banner-error" role="alert">
              <Icon name="alert-circle" />
              <span>{formError}</span>
            </div>
          )}
        </div>
      )}

      {step === 'form' && (
        <footer className="ndb-drawer-footer">
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary"
            disabled={!variantLiveSupported || testing || saving}
            onClick={() => void handleTest()}
          >
            <Icon name={testing ? 'loader' : 'play'} />
            {testing ? t('Testing...') : t('Test Connection')}
          </button>
          <div className="ndb-spacer" />
          <button
            type="button"
            className="ndb-btn ndb-btn-secondary"
            disabled={saving}
            onClick={() => void handleSubmit(false)}
          >
            {t('Save')}
          </button>
          <button
            type="button"
            className="ndb-btn ndb-btn-primary"
            disabled={!variantLiveSupported || saving}
            onClick={() => void handleSubmit(true)}
          >
            {t('Save & Connect')}
          </button>
        </footer>
      )}
    </aside>
  );
}
