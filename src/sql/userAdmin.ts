/**
 * Database User & Role Administration SQL Builders and Parsers.
 * Pure, browser-sandbox compatible (zero Node imports).
 *
 * Covers:
 * - PostgreSQL family (`pg_roles`, `pg_auth_members`, `information_schema.table_privileges`)
 * - MySQL / MariaDB / TiDB / OceanBase (`mysql.user`, `SHOW GRANTS`, Create/Alter/Rename/Lock/Drop)
 * - Microsoft SQL Server (`sys.database_principals`, `sys.server_principals`, `sys.database_permissions`)
 */

import type { CellValue, DatabaseUserSummary, QueryResultSet } from '../drivers/types';

export type UserAdminDialect = 'postgres' | 'mysql' | 'mssql';
export type UserPrivilegeScope = 'database' | 'schema' | 'table' | 'role' | 'global';

export interface CreateUserInput {
  name: string;
  host?: string;
  password: string;
  canLogin?: boolean;
  isSuperuser?: boolean;
  canCreateDb?: boolean;
  canCreateRole?: boolean;
  authPlugin?: string;
  defaultDatabase?: string;
}

export interface AlterUserOptionsInput {
  name: string;
  host?: string;
  password?: string;
  newHost?: string;
  newName?: string;
  locked?: boolean;
  canLogin?: boolean;
  isSuperuser?: boolean;
  canCreateDb?: boolean;
  canCreateRole?: boolean;
}

export interface PrivilegeMutationInput {
  userName: string;
  userHost?: string;
  scope: UserPrivilegeScope;
  privileges: string[];
  database?: string;
  schema?: string;
  table?: string;
  roleName?: string;
  withGrantOption?: boolean;
}

export interface ParsedMySqlGrant {
  privileges: string[];
  database: string;
  table: string;
  allPrivileges: boolean;
  grantOption: boolean;
}

export interface UserAdminSqlProfile {
  dialect: UserAdminDialect;
  supportsHost: boolean;
  supportsLock: boolean;
  supportsRoleAttributes: boolean;
  listUsersSql: string;
  fallbackListUsersSql?: string;
  scopes: UserPrivilegeScope[];
}

/* ============================================================================
 * Privilege Catalogs
 * ============================================================================ */

export const MYSQL_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'REFERENCES',
  'EXECUTE',
  'SHOW VIEW',
  'CREATE VIEW',
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'TRIGGER',
  'EVENT',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
] as const;

export const POSTGRES_DATABASE_PRIVILEGES = ['CONNECT', 'CREATE', 'TEMPORARY'] as const;
export const POSTGRES_SCHEMA_PRIVILEGES = ['USAGE', 'CREATE'] as const;
export const POSTGRES_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

export const MSSQL_DATABASE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'EXECUTE',
  'CREATE TABLE',
  'CREATE VIEW',
  'CREATE PROCEDURE',
  'ALTER',
  'CONTROL',
] as const;

export const MSSQL_OBJECT_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REFERENCES',
  'ALTER',
  'CONTROL',
] as const;

/* ============================================================================
 * Quoting Helpers
 * ============================================================================ */

export function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteMySqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function quotePgIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function quoteMySqlIdent(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``;
}

export function quoteMssqlIdent(value: string): string {
  return `[${value.replace(/\]/g, ']]')}]`;
}

export function formatMySqlAccount(name: string, host = '%'): string {
  return `${quoteMySqlString(name)}@${quoteMySqlString(host || '%')}`;
}

function normalizePrivileges(privileges: readonly string[], fallback = 'SELECT'): string[] {
  const cleaned = privileges
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(cleaned.length > 0 ? cleaned : [fallback]));
}

/* ============================================================================
 * Dialect Resolution
 * ============================================================================ */

const MYSQL_USER_ENGINES = new Set<string>([
  'mysql',
  'mariadb',
  'tidb',
  'oceanbase',
  'goldendb',
  'polardb',
  'tdsql',
  'greatsql',
  'dolt',
  'custom_mysql',
]);

const POSTGRES_USER_ENGINES = new Set<string>([
  'postgres',
  'postgresql',
  'opengauss',
  'gaussdb',
  'kingbase',
  'highgo',
  'vastbase',
  'uxdb',
  'cockroachdb',
  'redshift',
  'cloudberry',
  'opentenbase',
  'custom_postgres',
]);

export function resolveUserAdminDialect(engine: string): UserAdminDialect | null {
  const norm = engine.trim().toLowerCase();
  if (POSTGRES_USER_ENGINES.has(norm)) return 'postgres';
  if (MYSQL_USER_ENGINES.has(norm)) return 'mysql';
  if (norm === 'sqlserver' || norm === 'mssql') return 'mssql';
  return null;
}

export function resolveUserAdminProfile(engine: string): UserAdminSqlProfile | null {
  const dialect = resolveUserAdminDialect(engine);
  if (!dialect) return null;

  if (dialect === 'postgres') {
    return {
      dialect: 'postgres',
      supportsHost: false,
      supportsLock: false,
      supportsRoleAttributes: true,
      listUsersSql: buildListUsersSql('postgres'),
      scopes: ['database', 'schema', 'table', 'role'],
    };
  }
  if (dialect === 'mysql') {
    return {
      dialect: 'mysql',
      supportsHost: true,
      supportsLock: true,
      supportsRoleAttributes: false,
      listUsersSql: buildListUsersSql('mysql'),
      fallbackListUsersSql: buildListUsersFallbackSql('mysql'),
      scopes: ['global', 'database', 'table'],
    };
  }
  return {
    dialect: 'mssql',
    supportsHost: false,
    supportsLock: true,
    supportsRoleAttributes: false,
    listUsersSql: buildListUsersSql('mssql'),
    fallbackListUsersSql: buildListUsersFallbackSql('mssql'),
    scopes: ['database', 'schema', 'table', 'role'],
  };
}

export function privilegesForDialectScope(
  dialect: UserAdminDialect,
  scope: UserPrivilegeScope,
): readonly string[] {
  if (dialect === 'mysql') return MYSQL_PRIVILEGES;
  if (dialect === 'postgres') {
    if (scope === 'database') return POSTGRES_DATABASE_PRIVILEGES;
    if (scope === 'schema') return POSTGRES_SCHEMA_PRIVILEGES;
    if (scope === 'table') return POSTGRES_TABLE_PRIVILEGES;
    return [];
  }
  if (scope === 'table') return MSSQL_OBJECT_PRIVILEGES;
  return MSSQL_DATABASE_PRIVILEGES;
}

/* ============================================================================
 * List Users & Show Grants SQL
 * ============================================================================ */

export function buildListUsersSql(dialect: UserAdminDialect): string {
  if (dialect === 'postgres') {
    return `SELECT
  r.rolname AS name,
  r.rolsuper AS is_superuser,
  r.rolcanlogin AS can_login,
  r.rolcreatedb AS can_create_db,
  r.rolcreaterole AS can_create_role,
  COALESCE(
    (SELECT string_agg(parent.rolname, ',')
     FROM pg_catalog.pg_auth_members m
     JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid
     WHERE m.member = r.oid),
    ''
  ) AS member_of
FROM pg_catalog.pg_roles r
WHERE r.rolname NOT LIKE 'pg_%'
ORDER BY r.rolname`;
  }

  if (dialect === 'mysql') {
    return `SELECT
  User AS name,
  Host AS host,
  plugin AS auth_plugin,
  account_locked AS account_locked
FROM mysql.user
ORDER BY User, Host`;
  }

  // MSSQL: database principals joined with server principals when accessible
  return `SELECT
  dp.name AS name,
  dp.type_desc AS auth_plugin,
  CASE WHEN dp.type IN ('S', 'U', 'G', 'E', 'X') THEN 1 ELSE 0 END AS can_login,
  ISNULL(CAST(sp.is_disabled AS INT), 0) AS account_locked,
  ISNULL(IS_SRVROLEMEMBER('sysadmin', sp.name), 0) AS is_superuser
FROM sys.database_principals dp
LEFT JOIN sys.server_principals sp ON dp.sid = sp.sid
WHERE dp.type IN ('S', 'U', 'G', 'R', 'E', 'X')
  AND dp.principal_id > 4
  AND dp.name NOT LIKE '##%'
ORDER BY dp.name`;
}

export function buildListUsersFallbackSql(dialect: UserAdminDialect): string {
  if (dialect === 'mysql') {
    return `SELECT DISTINCT GRANTEE AS grantee
FROM information_schema.USER_PRIVILEGES
ORDER BY GRANTEE`;
  }
  if (dialect === 'mssql') {
    return `SELECT
  name,
  type_desc AS auth_plugin,
  CASE WHEN type IN ('S', 'U', 'G') THEN 1 ELSE 0 END AS can_login,
  0 AS account_locked,
  0 AS is_superuser
FROM sys.database_principals
WHERE type IN ('S', 'U', 'G', 'R') AND principal_id > 4
ORDER BY name`;
  }
  return `SELECT rolname AS name, rolsuper AS is_superuser, rolcanlogin AS can_login, rolcreatedb AS can_create_db, rolcreaterole AS can_create_role
FROM pg_catalog.pg_roles
ORDER BY rolname`;
}

export function buildShowGrantsSql(
  dialect: UserAdminDialect,
  userName: string,
  userHost = '%',
): string {
  if (dialect === 'mysql') {
    return `SHOW GRANTS FOR ${formatMySqlAccount(userName, userHost)}`;
  }

  if (dialect === 'postgres') {
    const role = quoteSqlString(userName);
    return `WITH target AS (
  SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication
  FROM pg_catalog.pg_roles
  WHERE rolname = ${role}
)
SELECT line FROM (
  SELECT 1 AS sort_ord, 'Role: ' || quote_ident(rolname) AS line FROM target
  UNION ALL
  SELECT 2, 'Attributes: ' || COALESCE(NULLIF(concat_ws(', ',
    CASE WHEN rolsuper THEN 'SUPERUSER' END,
    CASE WHEN rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,
    CASE WHEN rolreplication THEN 'REPLICATION' END
  ), ''), 'none') FROM target
  UNION ALL
  SELECT 10, 'Member of: ' || quote_ident(parent.rolname) || CASE WHEN m.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END
  FROM pg_catalog.pg_auth_members m
  JOIN target t ON t.oid = m.member
  JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid
  UNION ALL
  SELECT 20, 'Database: ' || quote_ident(d.datname) || ' = ' || concat_ws(', ',
    CASE WHEN has_database_privilege(t.rolname, d.oid, 'CONNECT') THEN 'CONNECT' END,
    CASE WHEN has_database_privilege(t.rolname, d.oid, 'CREATE') THEN 'CREATE' END,
    CASE WHEN has_database_privilege(t.rolname, d.oid, 'TEMPORARY') THEN 'TEMPORARY' END
  )
  FROM target t CROSS JOIN pg_catalog.pg_database d
  WHERE NOT d.datistemplate
    AND (has_database_privilege(t.rolname, d.oid, 'CONNECT')
      OR has_database_privilege(t.rolname, d.oid, 'CREATE')
      OR has_database_privilege(t.rolname, d.oid, 'TEMPORARY'))
  UNION ALL
  SELECT 30, 'Schema: ' || quote_ident(n.nspname) || ' = ' || concat_ws(', ',
    CASE WHEN has_schema_privilege(t.rolname, n.oid, 'USAGE') THEN 'USAGE' END,
    CASE WHEN has_schema_privilege(t.rolname, n.oid, 'CREATE') THEN 'CREATE' END
  )
  FROM target t CROSS JOIN pg_catalog.pg_namespace n
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    AND (has_schema_privilege(t.rolname, n.oid, 'USAGE') OR has_schema_privilege(t.rolname, n.oid, 'CREATE'))
  UNION ALL
  SELECT 40, 'Table: ' || quote_ident(table_schema) || '.' || quote_ident(table_name) || ' = ' ||
    string_agg(privilege_type || CASE WHEN is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END, ', ' ORDER BY privilege_type)
  FROM information_schema.table_privileges
  WHERE grantee = ${role}
    AND table_schema NOT IN ('information_schema', 'pg_catalog')
  GROUP BY table_schema, table_name
) grants
ORDER BY sort_ord, line`;
  }

  // MSSQL
  const principal = quoteSqlString(userName);
  return `SELECT
  p.state_desc + ' ' + p.permission_name +
  CASE
    WHEN p.class_desc = 'OBJECT_OR_COLUMN' THEN ' ON ' + QUOTENAME(OBJECT_SCHEMA_NAME(p.major_id)) + '.' + QUOTENAME(OBJECT_NAME(p.major_id))
    WHEN p.class_desc = 'SCHEMA' THEN ' ON SCHEMA::' + QUOTENAME(SCHEMA_NAME(p.major_id))
    ELSE ' ON DATABASE'
  END + ' TO ' + QUOTENAME(dp.name) AS grant_line
FROM sys.database_permissions p
JOIN sys.database_principals dp ON p.grantee_principal_id = dp.principal_id
WHERE dp.name = ${principal}
ORDER BY grant_line`;
}

/* ============================================================================
 * Create / Alter / Lock / Rename / Drop User & Role SQL
 * ============================================================================ */

export function buildCreateUserSql(dialect: UserAdminDialect, input: CreateUserInput): string {
  const name = input.name.trim();
  if (!name) throw new Error('User/role name is required');

  if (dialect === 'postgres') {
    const attrs: string[] = [];
    attrs.push(input.canLogin === false ? 'NOLOGIN' : 'LOGIN');
    if (input.isSuperuser) attrs.push('SUPERUSER');
    if (input.canCreateDb) attrs.push('CREATEDB');
    if (input.canCreateRole) attrs.push('CREATEROLE');
    if (input.password) {
      attrs.push(`PASSWORD ${quoteSqlString(input.password)}`);
    }
    return `CREATE ROLE ${quotePgIdent(name)} WITH ${attrs.join(' ')};`;
  }

  if (dialect === 'mysql') {
    const account = formatMySqlAccount(name, input.host || '%');
    const pluginClause = input.authPlugin?.trim()
      ? ` IDENTIFIED WITH ${quoteMySqlIdent(input.authPlugin.trim())} BY ${quoteMySqlString(input.password)}`
      : ` IDENTIFIED BY ${quoteMySqlString(input.password)}`;
    return `CREATE USER ${account}${pluginClause};`;
  }

  // MSSQL: create login + database user
  const ident = quoteMssqlIdent(name);
  const stmts: string[] = [];
  if (input.password) {
    const defaultDb = input.defaultDatabase?.trim()
      ? `, DEFAULT_DATABASE = ${quoteMssqlIdent(input.defaultDatabase.trim())}`
      : '';
    stmts.push(`CREATE LOGIN ${ident} WITH PASSWORD = ${quoteSqlString(input.password)}${defaultDb};`);
    stmts.push(`CREATE USER ${ident} FOR LOGIN ${ident};`);
  } else {
    stmts.push(`CREATE USER ${ident} WITHOUT LOGIN;`);
  }
  return stmts.join('\n');
}

export function buildAlterUserSql(dialect: UserAdminDialect, input: AlterUserOptionsInput): string[] {
  const name = input.name.trim();
  if (!name) throw new Error('User/role name is required');
  const statements: string[] = [];

  if (dialect === 'postgres') {
    const attrs: string[] = [];
    if (input.canLogin !== undefined) attrs.push(input.canLogin ? 'LOGIN' : 'NOLOGIN');
    if (input.isSuperuser !== undefined) attrs.push(input.isSuperuser ? 'SUPERUSER' : 'NOSUPERUSER');
    if (input.canCreateDb !== undefined) attrs.push(input.canCreateDb ? 'CREATEDB' : 'NOCREATEDB');
    if (input.canCreateRole !== undefined) attrs.push(input.canCreateRole ? 'CREATEROLE' : 'NOCREATEROLE');
    if (input.password !== undefined && input.password !== '') {
      attrs.push(`PASSWORD ${quoteSqlString(input.password)}`);
    }
    if (attrs.length > 0) {
      statements.push(`ALTER ROLE ${quotePgIdent(name)} WITH ${attrs.join(' ')};`);
    }
    if (input.newName && input.newName.trim() && input.newName.trim() !== name) {
      statements.push(`ALTER ROLE ${quotePgIdent(name)} RENAME TO ${quotePgIdent(input.newName.trim())};`);
    }
    return statements;
  }

  if (dialect === 'mysql') {
    const host = input.host || '%';
    let currentName = name;
    let currentHost = host;
    if (
      (input.newName && input.newName.trim() !== name) ||
      (input.newHost && input.newHost.trim() !== host)
    ) {
      const targetName = input.newName?.trim() || name;
      const targetHost = input.newHost?.trim() || host;
      statements.push(
        `RENAME USER ${formatMySqlAccount(currentName, currentHost)} TO ${formatMySqlAccount(targetName, targetHost)};`,
      );
      currentName = targetName;
      currentHost = targetHost;
    }
    if (input.password !== undefined && input.password !== '') {
      statements.push(
        `ALTER USER ${formatMySqlAccount(currentName, currentHost)} IDENTIFIED BY ${quoteMySqlString(input.password)};`,
      );
    }
    if (input.locked !== undefined) {
      statements.push(
        `ALTER USER ${formatMySqlAccount(currentName, currentHost)} ACCOUNT ${input.locked ? 'LOCK' : 'UNLOCK'};`,
      );
    }
    return statements;
  }

  // MSSQL
  const ident = quoteMssqlIdent(name);
  if (input.password !== undefined && input.password !== '') {
    statements.push(`ALTER LOGIN ${ident} WITH PASSWORD = ${quoteSqlString(input.password)};`);
  }
  if (input.locked !== undefined) {
    statements.push(`ALTER LOGIN ${ident} ${input.locked ? 'DISABLE' : 'ENABLE'};`);
  }
  if (input.newName && input.newName.trim() && input.newName.trim() !== name) {
    statements.push(`ALTER USER ${ident} WITH NAME = ${quoteMssqlIdent(input.newName.trim())};`);
  }
  return statements;
}

export function buildDropUserSql(
  dialect: UserAdminDialect,
  userName: string,
  userHost = '%',
  ifExists = true,
): string {
  const name = userName.trim();
  if (!name) throw new Error('User/role name is required');
  const guard = ifExists ? 'IF EXISTS ' : '';

  if (dialect === 'postgres') {
    return `DROP ROLE ${guard}${quotePgIdent(name)};`;
  }
  if (dialect === 'mysql') {
    return `DROP USER ${guard}${formatMySqlAccount(name, userHost)};`;
  }
  return `DROP USER ${guard}${quoteMssqlIdent(name)};`;
}

/* ============================================================================
 * GRANT & REVOKE SQL Builders
 * ============================================================================ */

function buildMySqlGrantTarget(database?: string, table?: string): string {
  const db = database?.trim() || '*';
  const tbl = table?.trim() || '*';
  const dbSql = db === '*' ? '*' : quoteMySqlIdent(db);
  const tblSql = tbl === '*' ? '*' : quoteMySqlIdent(tbl);
  return `${dbSql}.${tblSql}`;
}

export function buildGrantSql(dialect: UserAdminDialect, input: PrivilegeMutationInput): string {
  const userName = input.userName.trim();
  if (!userName) throw new Error('Target user/role name is required');

  if (dialect === 'mysql') {
    const privs = normalizePrivileges(input.privileges, 'SELECT').join(', ');
    const target = input.scope === 'global' ? '*.*' : buildMySqlGrantTarget(input.database, input.table);
    const opt = input.withGrantOption ? ' WITH GRANT OPTION' : '';
    return `GRANT ${privs} ON ${target} TO ${formatMySqlAccount(userName, input.userHost)}${opt};`;
  }

  if (dialect === 'postgres') {
    if (input.scope === 'role') {
      const role = input.roleName?.trim();
      if (!role) throw new Error('Role name is required for role membership grant');
      const opt = input.withGrantOption ? ' WITH ADMIN OPTION' : '';
      return `GRANT ${quotePgIdent(role)} TO ${quotePgIdent(userName)}${opt};`;
    }
    const defaultPriv = input.scope === 'database' ? 'CONNECT' : input.scope === 'schema' ? 'USAGE' : 'SELECT';
    const privs = normalizePrivileges(input.privileges, defaultPriv).join(', ');
    let target: string;
    if (input.scope === 'database') {
      target = `DATABASE ${quotePgIdent(input.database?.trim() || 'postgres')}`;
    } else if (input.scope === 'schema') {
      target = `SCHEMA ${quotePgIdent(input.schema?.trim() || 'public')}`;
    } else {
      const schema = input.schema?.trim() || 'public';
      const table = input.table?.trim() || '*';
      target =
        table === '*'
          ? `ALL TABLES IN SCHEMA ${quotePgIdent(schema)}`
          : `TABLE ${quotePgIdent(schema)}.${quotePgIdent(table)}`;
    }
    const opt = input.withGrantOption ? ' WITH GRANT OPTION' : '';
    return `GRANT ${privs} ON ${target} TO ${quotePgIdent(userName)}${opt};`;
  }

  // MSSQL
  if (input.scope === 'role') {
    const role = input.roleName?.trim();
    if (!role) throw new Error('Role name is required for SQL Server role membership');
    return `ALTER ROLE ${quoteMssqlIdent(role)} ADD MEMBER ${quoteMssqlIdent(userName)};`;
  }
  const privs = normalizePrivileges(input.privileges, 'SELECT').join(', ');
  const opt = input.withGrantOption ? ' WITH GRANT OPTION' : '';
  if (input.scope === 'schema') {
    const schema = input.schema?.trim() || 'dbo';
    return `GRANT ${privs} ON SCHEMA::${quoteMssqlIdent(schema)} TO ${quoteMssqlIdent(userName)}${opt};`;
  }
  if (input.scope === 'table' && input.table?.trim()) {
    const schema = input.schema?.trim() || 'dbo';
    return `GRANT ${privs} ON OBJECT::${quoteMssqlIdent(schema)}.${quoteMssqlIdent(input.table.trim())} TO ${quoteMssqlIdent(userName)}${opt};`;
  }
  return `GRANT ${privs} TO ${quoteMssqlIdent(userName)}${opt};`;
}

export function buildRevokeSql(dialect: UserAdminDialect, input: PrivilegeMutationInput): string {
  const userName = input.userName.trim();
  if (!userName) throw new Error('Target user/role name is required');

  if (dialect === 'mysql') {
    const privs = normalizePrivileges(input.privileges, 'SELECT').join(', ');
    const target = input.scope === 'global' ? '*.*' : buildMySqlGrantTarget(input.database, input.table);
    return `REVOKE ${privs} ON ${target} FROM ${formatMySqlAccount(userName, input.userHost)};`;
  }

  if (dialect === 'postgres') {
    if (input.scope === 'role') {
      const role = input.roleName?.trim();
      if (!role) throw new Error('Role name is required for role membership revoke');
      return `REVOKE ${quotePgIdent(role)} FROM ${quotePgIdent(userName)};`;
    }
    const defaultPriv = input.scope === 'database' ? 'CONNECT' : input.scope === 'schema' ? 'USAGE' : 'SELECT';
    const privs = normalizePrivileges(input.privileges, defaultPriv).join(', ');
    let target: string;
    if (input.scope === 'database') {
      target = `DATABASE ${quotePgIdent(input.database?.trim() || 'postgres')}`;
    } else if (input.scope === 'schema') {
      target = `SCHEMA ${quotePgIdent(input.schema?.trim() || 'public')}`;
    } else {
      const schema = input.schema?.trim() || 'public';
      const table = input.table?.trim() || '*';
      target =
        table === '*'
          ? `ALL TABLES IN SCHEMA ${quotePgIdent(schema)}`
          : `TABLE ${quotePgIdent(schema)}.${quotePgIdent(table)}`;
    }
    return `REVOKE ${privs} ON ${target} FROM ${quotePgIdent(userName)};`;
  }

  // MSSQL
  if (input.scope === 'role') {
    const role = input.roleName?.trim();
    if (!role) throw new Error('Role name is required for SQL Server role membership');
    return `ALTER ROLE ${quoteMssqlIdent(role)} DROP MEMBER ${quoteMssqlIdent(userName)};`;
  }
  const privs = normalizePrivileges(input.privileges, 'SELECT').join(', ');
  if (input.scope === 'schema') {
    const schema = input.schema?.trim() || 'dbo';
    return `REVOKE ${privs} ON SCHEMA::${quoteMssqlIdent(schema)} FROM ${quoteMssqlIdent(userName)};`;
  }
  if (input.scope === 'table' && input.table?.trim()) {
    const schema = input.schema?.trim() || 'dbo';
    return `REVOKE ${privs} ON OBJECT::${quoteMssqlIdent(schema)}.${quoteMssqlIdent(input.table.trim())} FROM ${quoteMssqlIdent(userName)};`;
  }
  return `REVOKE ${privs} FROM ${quoteMssqlIdent(userName)};`;
}

/* ============================================================================
 * Result Parsers
 * ============================================================================ */

function colIdx(result: QueryResultSet, ...names: string[]): number {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return result.columns.findIndex((c) => wanted.has(c.name.toLowerCase()));
}

function asBool(val: CellValue | undefined): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  const s = String(val ?? '').trim().toLowerCase();
  return s === 'true' || s === 't' || s === '1' || s === 'y' || s === 'yes';
}

function asStr(val: CellValue | undefined): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

export function parseMySqlGrantee(grantee: string): { name: string; host: string } | null {
  const match = /^'((?:''|[^'])*)'@'((?:''|[^'])*)'$/.exec(grantee.trim());
  if (!match) return null;
  return {
    name: match[1].replace(/''/g, "'"),
    host: match[2].replace(/''/g, "'"),
  };
}

export function parseDatabaseUsers(
  dialect: UserAdminDialect,
  result: QueryResultSet | null | undefined,
): DatabaseUserSummary[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];

  // Fallback MySQL information_schema.USER_PRIVILEGES grantee column
  const granteeIdx = colIdx(result, 'grantee');
  const nameIdx = colIdx(result, 'name', 'user', 'rolname');
  if (dialect === 'mysql' && nameIdx < 0 && granteeIdx >= 0) {
    const seen = new Set<string>();
    const users: DatabaseUserSummary[] = [];
    for (const row of result.rows) {
      const parsed = parseMySqlGrantee(asStr(row[granteeIdx]));
      if (!parsed) continue;
      const key = `${parsed.name}@${parsed.host}`;
      if (seen.has(key)) continue;
      seen.add(key);
      users.push({ name: parsed.name, host: parsed.host, canLogin: true });
    }
    return users;
  }

  const hostIdx = colIdx(result, 'host');
  const superIdx = colIdx(result, 'is_superuser', 'rolsuper');
  const loginIdx = colIdx(result, 'can_login', 'rolcanlogin');
  const createDbIdx = colIdx(result, 'can_create_db', 'rolcreatedb');
  const createRoleIdx = colIdx(result, 'can_create_role', 'rolcreaterole');
  const lockedIdx = colIdx(result, 'account_locked', 'locked', 'is_disabled');
  const pluginIdx = colIdx(result, 'auth_plugin', 'plugin', 'type_desc');
  const rolesIdx = colIdx(result, 'member_of', 'roles');

  return result.rows
    .map((row): DatabaseUserSummary => {
      const name = asStr(nameIdx >= 0 ? row[nameIdx] : row[0]).trim();
      const rawRoles = rolesIdx >= 0 ? asStr(row[rolesIdx]).trim() : '';
      const roles = rawRoles
        ? rawRoles.split(',').map((r) => r.trim()).filter(Boolean)
        : undefined;
      return {
        name,
        host: hostIdx >= 0 ? asStr(row[hostIdx]).trim() || undefined : undefined,
        isSuperuser: superIdx >= 0 ? asBool(row[superIdx]) : undefined,
        canLogin: loginIdx >= 0 ? asBool(row[loginIdx]) : dialect === 'mysql' ? true : undefined,
        canCreateDb: createDbIdx >= 0 ? asBool(row[createDbIdx]) : undefined,
        canCreateRole: createRoleIdx >= 0 ? asBool(row[createRoleIdx]) : undefined,
        locked: lockedIdx >= 0 ? asBool(row[lockedIdx]) : undefined,
        authPlugin: pluginIdx >= 0 ? asStr(row[pluginIdx]).trim() || undefined : undefined,
        roles,
      };
    })
    .filter((u) => u.name !== '');
}

export function parseUserGrants(result: QueryResultSet | null | undefined): string[] {
  if (!result || !Array.isArray(result.rows)) return [];
  return result.rows
    .map((row) => asStr(row[0]).trim())
    .filter(Boolean);
}

function unquoteMySqlIdent(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('`') && s.endsWith('`') && s.length >= 2) {
    return s.slice(1, -1).replace(/``/g, '`');
  }
  return s;
}

export function parseMySqlGrantStatement(sql: string): ParsedMySqlGrant | null {
  const ident = '(?:`(?:``|[^`])*`|\\*|[^\\s.]+)';
  const re = new RegExp(`^\\s*GRANT\\s+(.+?)\\s+ON\\s+(?:(?:TABLE|FUNCTION|PROCEDURE)\\s+)?(${ident})\\s*\\.\\s*(${ident})\\s+TO\\s+`, 'i');
  const match = re.exec(sql);
  if (!match) return null;
  const privileges = match[1]
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  return {
    privileges,
    database: unquoteMySqlIdent(match[2]),
    table: unquoteMySqlIdent(match[3]),
    allPrivileges: privileges.some((p) => p === 'ALL' || p === 'ALL PRIVILEGES'),
    grantOption: /\s+WITH\s+GRANT\s+OPTION\s*;?\s*$/i.test(sql),
  };
}
