/**
 * Driver session lifecycle, schema metadata loading, completion schema building,
 * cell value coercion, and dialect helpers.
 */

import type { PluginContext } from '@netcatty/plugin-sdk';
import type { PluginCodeEditorCompletionSchema } from '@netcatty/plugin-sdk/host-react';
import {
  createDriver,
  resolveEngineFamily,
  type AnyDatabaseDriver,
  type CellValue,
  type ColumnStructure,
  type ConnectionConfig,
  type ConnectionInfo,
  type DatabaseInfo,
  type MongoDriver,
  type RedisDriver,
  type RelationalDriver,
  type SchemaInfo,
  type SqlDialect,
  type TestConnectionResult,
} from '../drivers/index';
import { buildMonacoCompletionSchema } from '../sql/index';
import { driverById, type DriverId } from '../driverRegistry';
import { createWorkbenchTransport } from './transport';
import {
  isLiveSupportedEngine,
  type ActiveSession,
  type SavedConnection,
  type SchemaObjectsCache,
} from './types';

export function makeDefaultConnection(engine: DriverId = 'postgres'): SavedConnection {
  const profile = driverById(engine);
  const now = Date.now();
  const isSqlite = engine === 'sqlite';
  const defaultUser =
    engine === 'postgres' || profile.wireFamily === 'postgres'
      ? 'postgres'
      : engine === 'mysql' || engine === 'mariadb' || profile.wireFamily === 'mysql'
        ? 'root'
        : engine === 'clickhouse'
          ? 'default'
          : '';
  const defaultDb =
    engine === 'postgres' || profile.wireFamily === 'postgres'
      ? 'postgres'
      : engine === 'clickhouse'
        ? 'default'
        : engine === 'mongodb'
          ? 'admin'
          : isSqlite
            ? 'main'
            : '';
  return {
    id: `conn-${now}-${Math.random().toString(36).slice(2, 7)}`,
    name: isSqlite ? 'Sample SQLite' : `${profile.label} Local`,
    group: '',
    color: 'none',
    engine,
    host: isSqlite ? '' : '127.0.0.1',
    port: profile.defaultPort || 0,
    database: defaultDb,
    schema: engine === 'postgres' || profile.wireFamily === 'postgres' ? 'public' : '',
    username: defaultUser,
    hasPassword: false,
    tlsMode: engine === 'postgres' || engine === 'mysql' || engine === 'mariadb' ? 'prefer' : 'disable',
    allowSelfSigned: false,
    redisDb: 0,
    authSource: 'admin',
    httpPath: '/',
    sqliteMode: 'demo',
    sshTunnel: { enabled: false },
    createdAt: now,
    updatedAt: now,
  };
}

export function engineToMonacoLanguage(engine: DriverId): 'pgsql' | 'mysql' | 'sql' {
  if (!isLiveSupportedEngine(engine)) return 'sql';
  const fam = resolveEngineFamily(engine);
  if (fam === 'postgres') return 'pgsql';
  if (fam === 'mysql') return 'mysql';
  return 'sql';
}

export function engineToSqlDialect(engine: DriverId): SqlDialect {
  if (!isLiveSupportedEngine(engine)) return 'postgres';
  const fam = resolveEngineFamily(engine);
  if (fam === 'postgres' || fam === 'mysql' || fam === 'sqlite' || fam === 'clickhouse') return fam;
  return 'postgres';
}

export function isRelationalDriver(driver: AnyDatabaseDriver): driver is RelationalDriver {
  return (
    driver.family === 'postgres' ||
    driver.family === 'mysql' ||
    driver.family === 'sqlite' ||
    driver.family === 'clickhouse'
  );
}

export function isRedisDriver(driver: AnyDatabaseDriver): driver is RedisDriver {
  return driver.family === 'redis';
}

export function isMongoDriver(driver: AnyDatabaseDriver): driver is MongoDriver {
  return driver.family === 'mongodb';
}

export function buildDriverConfig(
  conn: SavedConnection,
  password: string | undefined,
  sqliteBytes?: Uint8Array,
): ConnectionConfig {
  if (!isLiveSupportedEngine(conn.engine)) {
    throw new Error(`${driverById(conn.engine).label} is listed in the catalog; its wire protocol driver is not packaged yet.`);
  }
  return {
    id: conn.id,
    name: conn.name,
    engine: conn.engine,
    host: conn.host || '127.0.0.1',
    port: conn.port || driverById(conn.engine).defaultPort,
    database: conn.database || undefined,
    schema: conn.schema || undefined,
    username: conn.username || undefined,
    password: password || undefined,
    tlsMode: conn.tlsMode,
    allowSelfSigned: conn.allowSelfSigned,
    redisDb: conn.redisDb,
    authSource: conn.authSource || 'admin',
    httpPath: conn.httpPath || '/',
    sqliteBytes,
    sqliteFileName: conn.sqliteFileName,
    sqliteSeedDemo: conn.engine === 'sqlite' && !sqliteBytes && conn.sqliteMode === 'demo',
    sshTunnel: conn.sshTunnel.enabled
      ? {
          hostBindingToken: conn.sshTunnel.hostBindingToken,
          target: conn.sshTunnel.target,
          expectedRevision: conn.sshTunnel.expectedRevision,
        }
      : undefined,
  };
}

export async function testSavedConnection(
  context: PluginContext,
  conn: SavedConnection,
  password: string | undefined,
  sqliteBytes?: Uint8Array,
  onBindingToken?: (token: string) => void,
): Promise<TestConnectionResult> {
  if (!isLiveSupportedEngine(conn.engine)) {
    return {
      ok: false,
      serverVersion: '',
      latencyMs: 0,
      error: `${driverById(conn.engine).label} is a catalog-only engine without a bundled wire driver.`,
    };
  }
  const driver = createDriver(conn.engine);
  const config = buildDriverConfig(conn, password, sqliteBytes);
  const transport = createWorkbenchTransport(context.network, {
    sshTunnel: config.sshTunnel,
    onBindingToken,
  });
  const started = performance.now();
  try {
    const info = await driver.connect(config, transport);
    const res = await driver.testConnection();
    return {
      ...res,
      serverVersion: res.serverVersion || info.serverVersion,
      tlsActive: res.tlsActive ?? info.tlsActive,
      latencyMs: res.latencyMs || info.latencyMs || Math.round(performance.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      serverVersion: '',
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await driver.close().catch(() => {});
  }
}

export async function openSavedConnectionSession(
  context: PluginContext,
  conn: SavedConnection,
  password: string | undefined,
  sqliteBytes?: Uint8Array,
  onBindingToken?: (token: string) => void,
): Promise<ActiveSession> {
  if (!isLiveSupportedEngine(conn.engine)) {
    throw new Error(`${driverById(conn.engine).label} does not have a packaged runtime driver yet.`);
  }
  const driver = createDriver(conn.engine);
  const config = buildDriverConfig(conn, password, sqliteBytes);
  const transport = createWorkbenchTransport(context.network, {
    sshTunnel: config.sshTunnel,
    onBindingToken,
  });

  const info: ConnectionInfo = await driver.connect(config, transport);
  let databases: DatabaseInfo[] = [];
  let activeDatabase = info.database || conn.database || '';
  let schemas: SchemaInfo[] = [];
  let activeSchema = conn.schema || '';
  const objectsBySchema: Record<string, SchemaObjectsCache> = {};
  const mongoCollectionsByDb: Record<string, { name: string; type: string }[]> = {};
  let redisInfo = undefined;

  if (isRelationalDriver(driver)) {
    try {
      databases = await driver.listDatabases();
    } catch {
      databases = activeDatabase ? [{ name: activeDatabase }] : [];
    }
    if (!activeDatabase && databases.length > 0) {
      activeDatabase = databases[0].name;
    }
    try {
      schemas = await driver.listSchemas(activeDatabase);
    } catch {
      schemas = [{ name: driver.family === 'postgres' ? 'public' : activeDatabase || 'main' }];
    }
    if (!activeSchema) {
      const preferred =
        schemas.find((s) => s.name === 'public') ??
        schemas.find((s) => s.name === 'main') ??
        schemas.find((s) => s.name === activeDatabase) ??
        schemas.find((s) => !s.isSystem) ??
        schemas[0];
      activeSchema = preferred?.name ?? (driver.family === 'sqlite' ? 'main' : activeDatabase || 'public');
    }
  } else if (isMongoDriver(driver)) {
    try {
      const mdbs = await driver.listDatabases();
      databases = mdbs.map((d) => ({ name: d.name, sizeBytes: d.sizeOnDisk }));
    } catch {
      databases = activeDatabase ? [{ name: activeDatabase }] : [{ name: 'admin' }];
    }
    if (!activeDatabase) {
      activeDatabase =
        databases.find((d) => d.name !== 'admin' && d.name !== 'local' && d.name !== 'config')?.name ??
        databases[0]?.name ??
        'admin';
    }
    try {
      mongoCollectionsByDb[activeDatabase] = await driver.listCollections(activeDatabase);
    } catch {
      mongoCollectionsByDb[activeDatabase] = [];
    }
  } else if (isRedisDriver(driver)) {
    try {
      redisInfo = await driver.getInfo();
    } catch {
      // ignore if INFO is restricted
    }
    databases = Array.from({ length: 16 }, (_, i) => ({ name: `DB ${i}` }));
    activeDatabase = `DB ${driver.currentDb}`;
  }

  return {
    connectionId: conn.id,
    connection: conn,
    driver,
    family: info.family,
    info,
    databases,
    activeDatabase,
    schemas,
    activeSchema,
    objectsBySchema,
    mongoCollectionsByDb,
    redisInfo,
    sqliteFileHandleId: conn.sqliteFileHandleId,
  };
}

export function schemaCacheKey(db: string, schema: string): string {
  return `${db}::${schema}`;
}

export async function loadSchemaObjects(
  driver: RelationalDriver,
  database: string,
  schema: string,
): Promise<SchemaObjectsCache> {
  const [tables, views, routines, triggers] = await Promise.all([
    driver.listTables(database, schema).catch(() => []),
    driver.listViews(database, schema).catch(() => []),
    driver.listRoutines(database, schema).catch(() => []),
    driver.listTriggers(database, schema).catch(() => []),
  ]);
  return {
    tables,
    views,
    routines,
    triggers,
    structures: {},
    loaded: true,
    loading: false,
  };
}

export function buildCompletionSchemaForSession(
  session: ActiveSession | undefined,
  database: string,
  schema: string,
): PluginCodeEditorCompletionSchema | undefined {
  if (!session || !isRelationalDriver(session.driver)) return undefined;
  const cache = session.objectsBySchema[schemaCacheKey(database, schema)];
  if (!cache) return undefined;
  const dialect = engineToSqlDialect(session.connection.engine);
  const raw = buildMonacoCompletionSchema({
    dialect,
    tables: [
      ...cache.tables.map((t) => ({
        name: t.name,
        schema: t.schema,
        kind: 'table' as const,
        columns: (cache.structures[t.name]?.columns ?? []).map((c) => ({
          name: c.name,
          dataType: c.dataType,
          isPrimaryKey: c.isPrimaryKey,
          nullable: c.nullable,
        })),
      })),
      ...cache.views.map((v) => ({
        name: v.name,
        schema: v.schema,
        kind: 'view' as const,
        columns: (cache.structures[v.name]?.columns ?? []).map((c) => ({
          name: c.name,
          dataType: c.dataType,
        })),
      })),
    ],
  });
  return {
    tables: raw.tables,
    keywords: raw.keywords,
    functions: raw.functions.map((name) => ({ name })),
  };
}

/**
 * Coerces a string typed in the editable DataGrid into a sensible typed CellValue
 * based on the target column metadata.
 */
export function coerceCellInput(
  raw: unknown,
  isNull: boolean,
  col?: ColumnStructure,
): CellValue {
  if (isNull || raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw as CellValue;
  const type = (col?.dataType ?? '').toLowerCase();
  const trimmed = raw.trim();

  if (/\b(bool|boolean)\b/.test(type)) {
    if (trimmed === 'true' || trimmed === '1' || trimmed === 't') return true;
    if (trimmed === 'false' || trimmed === '0' || trimmed === 'f') return false;
  }
  if (/\b(int|integer|bigint|smallint|tinyint|serial|int2|int4|int8|uint)\b/.test(type)) {
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  if (/\b(float|double|real|numeric|decimal|float4|float8)\b/.test(type)) {
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
  }
  if (/\b(json|jsonb)\b/.test(type)) {
    try {
      return JSON.parse(raw) as CellValue;
    } catch {
      return raw;
    }
  }
  return raw;
}

export function formatCellForClipboard(value: CellValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Uint8Array) {
    return '0x' + Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * Lightweight event bus linking the main workbench view with Netcatty's standalone
 * `com.binaricat.netcatty-database.connection` modal view.
 */
export interface ModalBridge {
  subscribe(listener: () => void): () => void;
  getVersion(): number;
  requestSaveAndConnect(conn: SavedConnection, password: string | undefined, connectNow: boolean, sqliteBytes?: Uint8Array): Promise<void>;
  setSaveHandler(handler: ((conn: SavedConnection, password: string | undefined, connectNow: boolean, sqliteBytes?: Uint8Array) => Promise<void>) | null): void;
}

export function createModalBridge(): ModalBridge {
  let version = 0;
  let saveHandler: ((conn: SavedConnection, password: string | undefined, connectNow: boolean, sqliteBytes?: Uint8Array) => Promise<void>) | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    version += 1;
    for (const l of listeners) l();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion() {
      return version;
    },
    setSaveHandler(handler) {
      saveHandler = handler;
      notify();
    },
    async requestSaveAndConnect(conn, password, connectNow, sqliteBytes) {
      if (saveHandler) {
        await saveHandler(conn, password, connectNow, sqliteBytes);
      }
    },
  };
}
