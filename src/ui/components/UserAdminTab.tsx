/**
 * Database User & Role Administration Tab (PostgreSQL, MySQL/MariaDB, SQL Server).
 * Lazy-loaded via React.lazy. No inline SVG/Canvas.
 * Features: Users/Roles list, Grants viewer, Create/Alter/Lock/Drop/Grant-Revoke with Monaco SQL Preview.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { DatabaseUserSummary, RelationalDriver } from '../../drivers/types';
import {
  buildAlterUserSql,
  buildCreateUserSql,
  buildDropUserSql,
  buildGrantSql,
  buildRevokeSql,
  buildShowGrantsSql,
  parseDatabaseUsers,
  parseUserGrants,
  privilegesForDialectScope,
  resolveUserAdminProfile,
  type UserPrivilegeScope,
} from '../../sql/userAdmin';
import { engineToMonacoLanguage, isRelationalDriver } from '../sessionManager';
import type { ActiveSession } from '../types';

export interface UserAdminTabProps {
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenSqlInQuery?: (sql: string, title?: string) => void;
  onNotify?: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

function userKey(u: DatabaseUserSummary): string {
  return u.host ? `${u.name}@${u.host}` : u.name;
}

export function UserAdminTab({
  session,
  t,
  onOpenSqlInQuery,
  onNotify,
  onShortcut,
}: UserAdminTabProps) {
  const profile = useMemo(
    () => resolveUserAdminProfile(session.connection.engine),
    [session.connection.engine],
  );
  const monacoLang = engineToMonacoLanguage(session.connection.engine);
  const readOnly = Boolean(session.connection.readOnly);

  const [users, setUsers] = useState<DatabaseUserSummary[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingGrants, setLoadingGrants] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<'grants' | 'create' | 'alter' | 'privileges'>('grants');

  // Create form state
  const [newName, setNewName] = useState('');
  const [newHost, setNewHost] = useState('%');
  const [newPassword, setNewPassword] = useState('');
  const [newCanLogin, setNewCanLogin] = useState(true);
  const [newSuperuser, setNewSuperuser] = useState(false);
  const [newCreateDb, setNewCreateDb] = useState(false);
  const [newCreateRole, setNewCreateRole] = useState(false);

  // Alter form state
  const [alterPassword, setAlterPassword] = useState('');
  const [alterNewHost, setAlterNewHost] = useState('');
  const [alterLocked, setAlterLocked] = useState<boolean>(false);
  const [alterCanLogin, setAlterCanLogin] = useState<boolean>(true);
  const [alterCreateDb, setAlterCreateDb] = useState<boolean>(false);

  // Grant/Revoke form state
  const [privAction, setPrivAction] = useState<'grant' | 'revoke'>('grant');
  const [privScope, setPrivScope] = useState<UserPrivilegeScope>('database');
  const [privDatabase, setPrivDatabase] = useState(session.activeDatabase || '');
  const [privSchema, setPrivSchema] = useState(session.activeSchema || 'public');
  const [privTable, setPrivTable] = useState('*');
  const [privRole, setPrivRole] = useState('');
  const [privSelected, setPrivSelected] = useState<string[]>(['SELECT']);
  const [privGrantOption, setPrivGrantOption] = useState(false);

  // Drop confirmation
  const [confirmDropSql, setConfirmDropSql] = useState<string | null>(null);

  const selectedUser = useMemo(
    () => users.find((u) => userKey(u) === selectedKey) ?? null,
    [users, selectedKey],
  );

  const loadUsers = useCallback(async () => {
    if (!profile || !isRelationalDriver(session.driver)) return;
    setLoadingUsers(true);
    setError(null);
    const drv = session.driver as RelationalDriver;
    try {
      let res;
      try {
        res = await drv.query(profile.listUsersSql, { maxRows: 1000 });
      } catch (primaryErr) {
        if (profile.fallbackListUsersSql) {
          res = await drv.query(profile.fallbackListUsersSql, { maxRows: 1000 });
        } else {
          throw primaryErr;
        }
      }
      const list = parseDatabaseUsers(profile.dialect, res.results[0]);
      setUsers(list);
      setSelectedKey((cur) => (cur && list.some((u) => userKey(u) === cur) ? cur : list[0] ? userKey(list[0]) : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingUsers(false);
    }
  }, [profile, session.driver]);

  const loadGrants = useCallback(
    async (target: DatabaseUserSummary) => {
      if (!profile || !isRelationalDriver(session.driver)) return;
      setLoadingGrants(true);
      const drv = session.driver as RelationalDriver;
      try {
        const sql = buildShowGrantsSql(profile.dialect, target.name, target.host);
        const res = await drv.query(sql, { maxRows: 500 });
        setGrants(parseUserGrants(res.results[0]));
      } catch (err) {
        setGrants([`-- Unable to read grants: ${err instanceof Error ? err.message : String(err)}`]);
      } finally {
        setLoadingGrants(false);
      }
    },
    [profile, session.driver],
  );

  useEffect(() => {
    setUsers([]);
    setSelectedKey(null);
    setGrants([]);
    setConfirmDropSql(null);
    if (profile) {
      setPrivScope(profile.scopes[0]);
      void loadUsers();
    }
  }, [profile, session.connectionId, loadUsers]);

  useEffect(() => {
    if (!selectedUser) {
      setGrants([]);
      return;
    }
    setAlterNewHost(selectedUser.host || '%');
    setAlterLocked(Boolean(selectedUser.locked));
    setAlterCanLogin(selectedUser.canLogin !== false);
    setAlterCreateDb(Boolean(selectedUser.canCreateDb));
    setAlterPassword('');
    setConfirmDropSql(null);
    void loadGrants(selectedUser);
  }, [selectedUser, loadGrants]);

  const availablePrivileges = useMemo(
    () => (profile ? privilegesForDialectScope(profile.dialect, privScope) : []),
    [profile, privScope],
  );

  useEffect(() => {
    if (availablePrivileges.length > 0) {
      setPrivSelected((cur) => {
        const kept = cur.filter((p) => availablePrivileges.includes(p));
        return kept.length > 0 ? kept : [availablePrivileges[0]];
      });
    }
  }, [availablePrivileges]);

  const previewSql = useMemo(() => {
    if (!profile) return '';
    try {
      if (confirmDropSql) return confirmDropSql;
      if (mode === 'create') {
        if (!newName.trim()) return '-- Enter a user/role name to preview CREATE SQL.';
        return buildCreateUserSql(profile.dialect, {
          name: newName,
          host: newHost,
          password: newPassword,
          canLogin: newCanLogin,
          isSuperuser: newSuperuser,
          canCreateDb: newCreateDb,
          canCreateRole: newCreateRole,
          defaultDatabase: session.activeDatabase,
        });
      }
      if (mode === 'alter' && selectedUser) {
        const stmts = buildAlterUserSql(profile.dialect, {
          name: selectedUser.name,
          host: selectedUser.host,
          password: alterPassword || undefined,
          newHost: profile.supportsHost && alterNewHost !== (selectedUser.host || '%') ? alterNewHost : undefined,
          locked: profile.supportsLock && alterLocked !== Boolean(selectedUser.locked) ? alterLocked : undefined,
          canLogin: profile.supportsRoleAttributes && alterCanLogin !== (selectedUser.canLogin !== false) ? alterCanLogin : undefined,
          canCreateDb: profile.supportsRoleAttributes && alterCreateDb !== Boolean(selectedUser.canCreateDb) ? alterCreateDb : undefined,
        });
        return stmts.length > 0 ? stmts.join('\n') : '-- Adjust password, lock, or role attributes to generate ALTER SQL.';
      }
      if (mode === 'privileges' && selectedUser) {
        const input = {
          userName: selectedUser.name,
          userHost: selectedUser.host,
          scope: privScope,
          privileges: privSelected,
          database: privDatabase || session.activeDatabase,
          schema: privSchema || session.activeSchema || 'public',
          table: privTable,
          roleName: privRole,
          withGrantOption: privGrantOption,
        };
        return privAction === 'grant'
          ? buildGrantSql(profile.dialect, input)
          : buildRevokeSql(profile.dialect, input);
      }
      return '';
    } catch (err) {
      return `-- ${err instanceof Error ? err.message : String(err)}`;
    }
  }, [
    alterCanLogin,
    alterCreateDb,
    alterLocked,
    alterNewHost,
    alterPassword,
    confirmDropSql,
    mode,
    newCanLogin,
    newCreateDb,
    newCreateRole,
    newHost,
    newName,
    newPassword,
    newSuperuser,
    privAction,
    privDatabase,
    privGrantOption,
    privRole,
    privSchema,
    privScope,
    privSelected,
    privTable,
    profile,
    selectedUser,
    session.activeDatabase,
    session.activeSchema,
  ]);

  const executePreviewSql = useCallback(async () => {
    const sql = previewSql.trim();
    if (!sql || sql.startsWith('--') || !isRelationalDriver(session.driver)) return;
    if (readOnly) {
      onNotify?.('warning', t('Connection is in Read-Only mode.'));
      return;
    }
    setExecuting(true);
    setError(null);
    try {
      await (session.driver as RelationalDriver).query(sql, { maxRows: 50 });
      onNotify?.('success', t('User administration SQL executed.'));
      setConfirmDropSql(null);
      if (mode === 'create') {
        setNewName('');
        setNewPassword('');
        setMode('grants');
      } else if (mode === 'alter') {
        setAlterPassword('');
      }
      await loadUsers();
      if (selectedUser && !confirmDropSql) {
        await loadGrants(selectedUser);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onNotify?.('error', msg);
    } finally {
      setExecuting(false);
    }
  }, [confirmDropSql, loadGrants, loadUsers, mode, onNotify, previewSql, readOnly, selectedUser, session.driver, t]);

  const filteredUsers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.name.toLowerCase().includes(q) || (u.host ?? '').toLowerCase().includes(q),
    );
  }, [users, filter]);

  if (!profile) {
    return (
      <div className="ndb-tab-pane" style={{ padding: 24 }}>
        <div className="ndb-section-box" style={{ maxWidth: 540 }}>
          <div className="ndb-inline-row" style={{ gap: 8, marginBottom: 8 }}>
            <Icon name="shield" />
            <strong>{t('User & Role Administration')}</strong>
          </div>
          <p className="ndb-muted">
            {t('User and role administration is supported for PostgreSQL, MySQL, MariaDB, TiDB, OceanBase, and SQL Server.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ndb-tab-pane">
      {/* Toolbar */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <strong style={{ fontSize: 13 }}>{t('Users & Roles')}</strong>
        <span className="ndb-tag ndb-mono">{profile.dialect}</span>
        {readOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
        <div className="ndb-spacer" />
        <button
          type="button"
          className="ndb-btn ndb-btn-primary ndb-btn-xs"
          disabled={readOnly}
          onClick={() => {
            setConfirmDropSql(null);
            setMode('create');
          }}
        >
          <Icon name="plus" />
          {t('New User / Role')}
        </button>
        <button
          type="button"
          className="ndb-btn ndb-btn-secondary ndb-btn-xs"
          disabled={loadingUsers}
          onClick={() => void loadUsers()}
        >
          <Icon name={loadingUsers ? 'loader' : 'refresh'} />
          {t('Refresh')}
        </button>
      </div>

      {error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left Sidebar: Principal List */}
        <aside
          style={{
            width: 260,
            flexShrink: 0,
            borderRight: '1px solid var(--plugin-hairline)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ padding: 10, borderBottom: '1px solid var(--plugin-hairline)' }}>
            <input
              type="text"
              className="ndb-input-sm"
              style={{ width: '100%' }}
              placeholder={t('Filter users / roles...')}
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
            {filteredUsers.map((u) => {
              const k = userKey(u);
              const active = k === selectedKey;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setSelectedKey(k);
                    setConfirmDropSql(null);
                    if (mode === 'create') setMode('grants');
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    border: 'none',
                    borderRadius: 'var(--plugin-radius-sm)',
                    background: active ? 'var(--plugin-surface-hover)' : 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                  }}
                >
                  <div className="ndb-inline-row" style={{ gap: 6 }}>
                    <span className="ndb-mono ndb-truncate" style={{ fontWeight: active ? 600 : 500 }}>
                      {k}
                    </span>
                    <div className="ndb-spacer" />
                    {u.isSuperuser && <span className="ndb-tag ndb-tag-warn">SU</span>}
                    {u.locked && <span className="ndb-tag ndb-tag-danger">LOCKED</span>}
                  </div>
                  <div className="ndb-muted ndb-mono" style={{ fontSize: 11 }}>
                    {[
                      u.canLogin === false ? 'NOLOGIN' : 'LOGIN',
                      u.authPlugin || '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </button>
              );
            })}
            {filteredUsers.length === 0 && (
              <div className="ndb-muted" style={{ padding: 16, textAlign: 'center', fontSize: 12 }}>
                {loadingUsers ? t('Loading...') : t('No users found.')}
              </div>
            )}
          </div>
        </aside>

        {/* Right Detail Panel */}
        <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="ndb-toolbar ndb-sub-toolbar ndb-toolbar-wrap">
            <div className="ndb-segmented">
              <button type="button" className={mode === 'grants' ? 'is-active' : ''} onClick={() => { setConfirmDropSql(null); setMode('grants'); }}>
                {t('Grants')}
              </button>
              <button type="button" className={mode === 'privileges' ? 'is-active' : ''} disabled={!selectedUser} onClick={() => { setConfirmDropSql(null); setMode('privileges'); }}>
                {t('Grant / Revoke')}
              </button>
              <button type="button" className={mode === 'alter' ? 'is-active' : ''} disabled={!selectedUser} onClick={() => { setConfirmDropSql(null); setMode('alter'); }}>
                {t('Edit / Lock')}
              </button>
              <button type="button" className={mode === 'create' ? 'is-active' : ''} onClick={() => { setConfirmDropSql(null); setMode('create'); }}>
                {t('Create')}
              </button>
            </div>
            <div className="ndb-spacer" />
            {selectedUser && mode !== 'create' && (
              <button
                type="button"
                className="ndb-btn ndb-btn-danger ndb-btn-xs"
                disabled={readOnly}
                onClick={() =>
                  setConfirmDropSql(buildDropUserSql(profile.dialect, selectedUser.name, selectedUser.host))
                }
              >
                {t('Drop User')}
              </button>
            )}
          </div>

          <div className="ndb-structure-scroll" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* GRANTS VIEW */}
            {mode === 'grants' && selectedUser && (
              <div className="ndb-section-box" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="ndb-inline-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <strong className="ndb-mono" style={{ fontSize: 14 }}>{userKey(selectedUser)}</strong>
                  {selectedUser.isSuperuser && <span className="ndb-tag ndb-tag-warn">SUPERUSER</span>}
                  {selectedUser.canCreateDb && <span className="ndb-tag">CREATEDB</span>}
                  {selectedUser.canCreateRole && <span className="ndb-tag">CREATEROLE</span>}
                  {selectedUser.locked && <span className="ndb-tag ndb-tag-danger">LOCKED</span>}
                  {selectedUser.roles && selectedUser.roles.length > 0 && (
                    <span className="ndb-muted ndb-mono" style={{ fontSize: 12 }}>
                      {`Roles: ${selectedUser.roles.join(', ')}`}
                    </span>
                  )}
                </div>

                {loadingGrants ? (
                  <div className="ndb-muted">{t('Loading grants...')}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {grants.map((line, i) => (
                      <div
                        key={i}
                        className="ndb-mono"
                        style={{
                          padding: '6px 10px',
                          borderRadius: 'var(--plugin-radius-sm)',
                          background: 'var(--plugin-surface-subtle)',
                          fontSize: 12,
                          wordBreak: 'break-all',
                        }}
                      >
                        {line}
                      </div>
                    ))}
                    {grants.length === 0 && (
                      <div className="ndb-muted">{t('No explicit grants returned.')}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* CREATE FORM */}
            {mode === 'create' && (
              <div className="ndb-section-box" style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="ndb-field-label">{t('Username / Role')}</span>
                  <input className="ndb-input-sm" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} placeholder="app_reader" />
                </label>
                {profile.supportsHost && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="ndb-field-label">{t('Host')}</span>
                    <input className="ndb-input-sm" value={newHost} onChange={(e) => setNewHost(e.currentTarget.value)} placeholder="%" />
                  </label>
                )}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="ndb-field-label">{t('Password')}</span>
                  <input type="password" className="ndb-input-sm" value={newPassword} onChange={(e) => setNewPassword(e.currentTarget.value)} placeholder="••••••••" />
                </label>
                {profile.supportsRoleAttributes && (
                  <div className="ndb-inline-row ndb-toolbar-wrap" style={{ gridColumn: '1 / -1', gap: 14 }}>
                    <label className="ndb-checkbox-row"><input type="checkbox" checked={newCanLogin} onChange={(e) => setNewCanLogin(e.currentTarget.checked)} /><span>LOGIN</span></label>
                    <label className="ndb-checkbox-row"><input type="checkbox" checked={newCreateDb} onChange={(e) => setNewCreateDb(e.currentTarget.checked)} /><span>CREATEDB</span></label>
                    <label className="ndb-checkbox-row"><input type="checkbox" checked={newCreateRole} onChange={(e) => setNewCreateRole(e.currentTarget.checked)} /><span>CREATEROLE</span></label>
                    <label className="ndb-checkbox-row"><input type="checkbox" checked={newSuperuser} onChange={(e) => setNewSuperuser(e.currentTarget.checked)} /><span>SUPERUSER</span></label>
                  </div>
                )}
              </div>
            )}

            {/* ALTER FORM */}
            {mode === 'alter' && selectedUser && (
              <div className="ndb-section-box" style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="ndb-field-label">{t('New Password (optional)')}</span>
                  <input type="password" className="ndb-input-sm" value={alterPassword} onChange={(e) => setAlterPassword(e.currentTarget.value)} placeholder="Leave blank to keep" />
                </label>
                {profile.supportsHost && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="ndb-field-label">{t('Rename Host')}</span>
                    <input className="ndb-input-sm" value={alterNewHost} onChange={(e) => setAlterNewHost(e.currentTarget.value)} />
                  </label>
                )}
                {profile.supportsLock && (
                  <label className="ndb-checkbox-row" style={{ alignSelf: 'end', paddingBottom: 4 }}>
                    <input type="checkbox" checked={alterLocked} onChange={(e) => setAlterLocked(e.currentTarget.checked)} />
                    <span>{t('Account Locked / Disabled')}</span>
                  </label>
                )}
                {profile.supportsRoleAttributes && (
                  <div className="ndb-inline-row" style={{ gridColumn: '1 / -1', gap: 14 }}>
                    <label className="ndb-checkbox-row"><input type="checkbox" checked={alterCanLogin} onChange={(e) => setAlterCanLogin(e.currentTarget.checked)} /><span>LOGIN</span></label>
                    <label className="ndb-checkbox-row"><input type="checkbox" checked={alterCreateDb} onChange={(e) => setAlterCreateDb(e.currentTarget.checked)} /><span>CREATEDB</span></label>
                  </div>
                )}
              </div>
            )}

            {/* GRANT / REVOKE FORM */}
            {mode === 'privileges' && selectedUser && (
              <div className="ndb-section-box" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="ndb-inline-row ndb-toolbar-wrap" style={{ gap: 8 }}>
                  <div className="ndb-segmented">
                    <button type="button" className={privAction === 'grant' ? 'is-active' : ''} onClick={() => setPrivAction('grant')}>GRANT</button>
                    <button type="button" className={privAction === 'revoke' ? 'is-active' : ''} onClick={() => setPrivAction('revoke')}>REVOKE</button>
                  </div>
                  <select className="ndb-select-sm" value={privScope} onChange={(e) => setPrivScope(e.currentTarget.value as UserPrivilegeScope)}>
                    {profile.scopes.map((sc) => (
                      <option key={sc} value={sc}>{sc.toUpperCase()}</option>
                    ))}
                  </select>
                  {privScope === 'database' && (
                    <input className="ndb-input-sm" value={privDatabase} onChange={(e) => setPrivDatabase(e.currentTarget.value)} placeholder="Database (* for all)" />
                  )}
                  {(privScope === 'schema' || privScope === 'table') && profile.dialect !== 'mysql' && (
                    <input className="ndb-input-sm" value={privSchema} onChange={(e) => setPrivSchema(e.currentTarget.value)} placeholder="Schema (e.g. public)" />
                  )}
                  {privScope === 'table' && profile.dialect === 'mysql' && (
                    <input className="ndb-input-sm" value={privDatabase} onChange={(e) => setPrivDatabase(e.currentTarget.value)} placeholder="Database" />
                  )}
                  {privScope === 'table' && (
                    <input className="ndb-input-sm" value={privTable} onChange={(e) => setPrivTable(e.currentTarget.value)} placeholder="Table (* for all)" />
                  )}
                  {privScope === 'role' && (
                    <input className="ndb-input-sm" value={privRole} onChange={(e) => setPrivRole(e.currentTarget.value)} placeholder="Role name" />
                  )}
                  {privAction === 'grant' && (
                    <label className="ndb-checkbox-row">
                      <input type="checkbox" checked={privGrantOption} onChange={(e) => setPrivGrantOption(e.currentTarget.checked)} />
                      <span>WITH GRANT / ADMIN OPTION</span>
                    </label>
                  )}
                </div>

                {availablePrivileges.length > 0 && (
                  <div className="ndb-table-chips">
                    {availablePrivileges.map((priv) => {
                      const checked = privSelected.includes(priv);
                      return (
                        <label key={priv} className="ndb-table-chip">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setPrivSelected((cur) =>
                                cur.includes(priv) ? cur.filter((p) => p !== priv) : [...cur, priv],
                              )
                            }
                          />
                          <span className="ndb-mono">{priv}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* SQL Preview & Execute */}
            {(mode !== 'grants' || confirmDropSql) && (
              <div className="ndb-section-box" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="ndb-inline-row" style={{ gap: 8 }}>
                  <strong style={{ fontSize: 12 }}>
                    {confirmDropSql ? t('Confirm Drop User SQL') : t('SQL Preview')}
                  </strong>
                  <div className="ndb-spacer" />
                  {confirmDropSql && (
                    <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setConfirmDropSql(null)}>
                      {t('Cancel')}
                    </button>
                  )}
                  {onOpenSqlInQuery && previewSql && !previewSql.startsWith('--') && (
                    <button
                      type="button"
                      className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                      onClick={() => onOpenSqlInQuery(previewSql, 'User Admin SQL')}
                    >
                      {t('Open in Query')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`ndb-btn ndb-btn-xs ${confirmDropSql ? 'ndb-btn-danger' : 'ndb-btn-primary'}`}
                    disabled={executing || readOnly || !previewSql || previewSql.startsWith('--')}
                    onClick={() => void executePreviewSql()}
                  >
                    <Icon name={executing ? 'loader' : 'play'} />
                    {confirmDropSql ? t('Execute Drop') : t('Execute SQL')}
                  </button>
                </div>
                <div style={{ height: 130, border: '1px solid var(--plugin-hairline)', borderRadius: 'var(--plugin-radius-sm)', overflow: 'hidden' }}>
                  <PluginCodeEditor
                    value={previewSql}
                    language={monacoLang}
                    readOnly
                    lineNumbers="off"
                    wordWrap="on"
                    height={130}
                    onShortcut={onShortcut}
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default UserAdminTab;
