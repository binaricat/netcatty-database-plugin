/**
 * Pure Database Connection URI / DSN parser & exporter.
 * Supports postgres://, mysql://, mariadb://, redis://, rediss://,
 * mongodb://, clickhouse://, clickhouses://, sqlite://.
 */

import type { DriverId } from '../driverRegistry';
import type { TlsMode } from '../drivers/types';
import type { SavedConnection } from './types';

export interface ParsedConnectionUri {
  engine: DriverId;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsMode: TlsMode;
  redisDb?: number;
  authSource?: string;
  sqliteFileName?: string;
}

const DEFAULT_PORTS: Partial<Record<DriverId, number>> = {
  postgres: 5432,
  cockroachdb: 26257,
  redshift: 5439,
  questdb: 8812,
  mysql: 3306,
  mariadb: 3306,
  doris: 9030,
  starrocks: 9030,
  sqlserver: 1433,
  redis: 6379,
  mongodb: 27017,
  clickhouse: 8123,
  neo4j: 7687,
  elasticsearch: 9200,
  easysearch: 9200,
  meilisearch: 7700,
  couchdb: 5984,
  qdrant: 6333,
  chromadb: 8000,
  weaviate: 8080,
  influxdb: 8086,
  influxdb3: 8181,
  tdengine: 6041,
  victoriametrics: 8428,
  trino: 8080,
  prestosql: 8080,
  databend: 8000,
  rqlite: 4001,
  turso: 443,
  etcd: 2379,
  consul: 8500,
  nacos: 8848,
  sqlite: 0,
};

export function parseConnectionUri(rawUri: string): ParsedConnectionUri {
  const input = rawUri.trim();
  if (!input) throw new Error('Connection URI is empty');

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input);
  if (!schemeMatch) {
    throw new Error('URI must start with a scheme such as postgres://, mysql://, redis://, mongodb://, or clickhouse://');
  }
  const scheme = schemeMatch[1].toLowerCase();

  let engine: DriverId;
  let forceDirectTls = false;
  switch (scheme) {
    case 'postgres':
    case 'postgresql':
      engine = 'postgres';
      break;
    case 'mysql':
      engine = 'mysql';
      break;
    case 'mariadb':
      engine = 'mariadb';
      break;
    case 'redis':
      engine = 'redis';
      break;
    case 'rediss':
      engine = 'redis';
      forceDirectTls = true;
      break;
    case 'mongodb':
    case 'mongodb+srv':
      engine = 'mongodb';
      if (scheme === 'mongodb+srv') forceDirectTls = true;
      break;
    case 'clickhouse':
    case 'http':
      engine = 'clickhouse';
      break;
    case 'clickhouses':
    case 'https':
      engine = 'clickhouse';
      forceDirectTls = true;
      break;
    case 'bolt':
    case 'neo4j':
      engine = 'neo4j';
      break;
    case 'bolt+s':
    case 'bolt+ssc':
    case 'neo4j+s':
    case 'neo4j+ssc':
      engine = 'neo4j';
      forceDirectTls = true;
      break;
    case 'mssql':
    case 'sqlserver':
      engine = 'sqlserver';
      break;
    case 'cockroach':
    case 'cockroachdb':
      engine = 'cockroachdb';
      break;
    case 'elasticsearch':
    case 'es':
      engine = 'elasticsearch';
      break;
    case 'qdrant':
      engine = 'qdrant';
      break;
    case 'meilisearch':
      engine = 'meilisearch';
      break;
    case 'couchdb':
      engine = 'couchdb';
      break;
    case 'influxdb':
    case 'influx':
      engine = 'influxdb';
      break;
    case 'tdengine':
    case 'taos':
      engine = 'tdengine';
      break;
    case 'trino':
      engine = 'trino';
      break;
    case 'presto':
    case 'prestosql':
      engine = 'prestosql';
      break;
    case 'libsql':
    case 'turso':
      engine = 'turso';
      forceDirectTls = true;
      break;
    case 'rqlite':
      engine = 'rqlite';
      break;
    case 'etcd':
      engine = 'etcd';
      break;
    case 'consul':
      engine = 'consul';
      break;
    case 'nacos':
      engine = 'nacos';
      break;
    case 'sqlite':
    case 'sqlite3':
      return {
        engine: 'sqlite',
        host: '',
        port: 0,
        database: input.slice(schemeMatch[0].length) || 'main',
        username: '',
        password: '',
        tlsMode: 'disable',
        sqliteFileName: input.slice(schemeMatch[0].length) || 'main',
      };
    default:
      throw new Error(`Unsupported URI scheme: ${scheme}://`);
  }

  // Normalize custom schemes to http:// for standard URL parsing.
  const normalized = 'http://' + input.slice(schemeMatch[0].length);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Invalid connection URI format');
  }

  const host = parsed.hostname || '127.0.0.1';
  const port = parsed.port ? Number(parsed.port) : (DEFAULT_PORTS[engine] ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in URI: ${parsed.port}`);
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : '';
  const password = parsed.password ? decodeURIComponent(parsed.password) : '';
  const pathSegment = parsed.pathname.replace(/^\/+/, '');
  const database = pathSegment ? decodeURIComponent(pathSegment) : '';

  const sslParam = (
    parsed.searchParams.get('sslmode') ??
    parsed.searchParams.get('ssl') ??
    parsed.searchParams.get('tls') ??
    ''
  ).toLowerCase();

  let tlsMode: TlsMode = forceDirectTls ? 'verify-full' : 'prefer';
  if (sslParam === 'disable' || sslParam === 'false' || sslParam === '0' || sslParam === 'off') {
    tlsMode = 'disable';
  } else if (sslParam === 'require' || sslParam === 'true' || sslParam === '1') {
    tlsMode = 'require';
  } else if (sslParam === 'verify-full' || sslParam === 'verify-ca' || sslParam === 'direct') {
    tlsMode = 'verify-full';
  } else if (sslParam === 'prefer') {
    tlsMode = 'prefer';
  } else if (engine === 'redis' || engine === 'mongodb' || engine === 'clickhouse') {
    tlsMode = forceDirectTls ? 'require' : 'disable';
  }

  const authSource = parsed.searchParams.get('authSource') ?? undefined;
  let redisDb: number | undefined;
  if (engine === 'redis') {
    const dbStr = parsed.searchParams.get('db') ?? pathSegment;
    if (dbStr && /^\d+$/.test(dbStr)) {
      redisDb = Math.max(0, Math.min(15, Number(dbStr)));
    }
  }

  return {
    engine,
    host,
    port,
    database,
    username,
    password,
    tlsMode,
    redisDb,
    authSource,
  };
}

export function exportConnectionUri(conn: SavedConnection, includePassword?: string): string {
  if (conn.engine === 'sqlite') {
    return `sqlite://${conn.sqliteFileName || conn.database || 'main'}`;
  }
  const schemeMap: Partial<Record<DriverId, string>> = {
    postgres: 'postgres',
    opengauss: 'postgres',
    gaussdb: 'postgres',
    kingbase: 'postgres',
    highgo: 'postgres',
    vastbase: 'postgres',
    uxdb: 'postgres',
    cockroachdb: 'postgres',
    redshift: 'postgres',
    cloudberry: 'postgres',
    opentenbase: 'postgres',
    questdb: 'postgres',
    kwdb: 'postgres',
    mysql: 'mysql',
    mariadb: 'mariadb',
    tidb: 'mysql',
    oceanbase: 'mysql',
    goldendb: 'mysql',
    doris: 'mysql',
    starrocks: 'mysql',
    selectdb: 'mysql',
    polardb: 'mysql',
    tdsql: 'mysql',
    greatsql: 'mysql',
    dolt: 'mysql',
    manticoresearch: 'mysql',
    sqlserver: 'mssql',
    neo4j: conn.tlsMode !== 'disable' ? 'bolt+s' : 'bolt',
    redis: conn.tlsMode !== 'disable' ? 'rediss' : 'redis',
    mongodb: 'mongodb',
    clickhouse: conn.tlsMode !== 'disable' ? 'clickhouses' : 'clickhouse',
    turso: 'libsql',
  };
  const scheme = schemeMap[conn.engine] ?? conn.engine;
  const auth =
    conn.username || includePassword
      ? `${encodeURIComponent(conn.username)}${includePassword ? `:${encodeURIComponent(includePassword)}` : ''}@`
      : '';
  const host = conn.host.includes(':') && !conn.host.startsWith('[') ? `[${conn.host}]` : (conn.host || '127.0.0.1');
  const dbPath =
    conn.engine === 'redis'
      ? `/${conn.redisDb ?? 0}`
      : conn.database
        ? `/${encodeURIComponent(conn.database)}`
        : '';
  const params = new URLSearchParams();
  if (conn.tlsMode && conn.tlsMode !== 'disable' && conn.engine !== 'redis' && conn.engine !== 'clickhouse') {
    params.set('sslmode', conn.tlsMode);
  }
  if (conn.engine === 'mongodb' && conn.authSource && conn.authSource !== 'admin') {
    params.set('authSource', conn.authSource);
  }
  const qs = params.toString();
  return `${scheme}://${auth}${host}:${conn.port}${dbPath}${qs ? `?${qs}` : ''}`;
}
