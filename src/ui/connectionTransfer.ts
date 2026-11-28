/**
 * Connections JSON Export & Import (Netcatty native format + DBeaver `data-sources.json`) (P1-5).
 * Passwords are NEVER exported into plaintext JSON.
 */

import type { DriverId } from '../driverRegistry';
import { driverById } from '../driverRegistry';
import { makeDefaultConnection } from './sessionManager';
import type { SavedConnection } from './types';

export interface ExportedConnectionsBundle {
  format: 'netcatty-database-connections';
  version: 1;
  exportedAt: string;
  connections: Array<Omit<SavedConnection, 'sqliteFileHandleId'>>;
}

export function exportConnectionsJson(connections: readonly SavedConnection[]): string {
  const bundle: ExportedConnectionsBundle = {
    format: 'netcatty-database-connections',
    version: 1,
    exportedAt: new Date().toISOString(),
    connections: connections.map((c) => {
      const { sqliteFileHandleId: _ignored, ...rest } = c;
      return {
        ...rest,
        hasPassword: false,
        sshTunnel: {
          enabled: Boolean(c.sshTunnel.enabled),
          hostLabel: c.sshTunnel.hostLabel,
        },
      };
    }),
  };
  return JSON.stringify(bundle, null, 2);
}

function mapDbeaverProvider(provider?: string, driver?: string): DriverId {
  const key = `${provider ?? ''} ${driver ?? ''}`.toLowerCase();
  if (key.includes('postgres') || key.includes('pgsql')) return 'postgres';
  if (key.includes('mariadb')) return 'mariadb';
  if (key.includes('mysql')) return 'mysql';
  if (key.includes('sqlite')) return 'sqlite';
  if (key.includes('clickhouse')) return 'clickhouse';
  if (key.includes('redis')) return 'redis';
  if (key.includes('mongo')) return 'mongodb';
  if (key.includes('tidb')) return 'tidb';
  if (key.includes('oceanbase')) return 'oceanbase';
  if (key.includes('kingbase')) return 'kingbase';
  if (key.includes('opengauss')) return 'opengauss';
  if (key.includes('gaussdb')) return 'gaussdb';
  if (key.includes('oracle')) return 'oracle';
  if (key.includes('sqlserver') || key.includes('mssql')) return 'sqlserver';
  if (key.includes('duckdb')) return 'duckdb';
  return 'postgres';
}

export function importConnectionsJson(rawJson: string): SavedConnection[] {
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  const now = Date.now();
  const imported: SavedConnection[] = [];

  // Format 1: Netcatty Database Connections JSON bundle or raw array
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.connections)
      ? parsed.connections
      : null;

  if (rawList) {
    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const engine = (typeof obj.engine === 'string' ? obj.engine : 'postgres') as DriverId;
      let validEngine: DriverId = 'postgres';
      try {
        driverById(engine);
        validEngine = engine;
      } catch {
        validEngine = 'postgres';
      }
      const base = makeDefaultConnection(validEngine);
      imported.push({
        ...base,
        id: `conn-${now}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(obj.name || base.name),
        group: typeof obj.group === 'string' ? obj.group : '',
        color: (typeof obj.color === 'string' ? obj.color : 'none') as SavedConnection['color'],
        host: typeof obj.host === 'string' ? obj.host : base.host,
        port: typeof obj.port === 'number' && obj.port > 0 ? obj.port : base.port,
        database: typeof obj.database === 'string' ? obj.database : base.database,
        schema: typeof obj.schema === 'string' ? obj.schema : base.schema,
        username: typeof obj.username === 'string' ? obj.username : base.username,
        hasPassword: false,
        readOnly: Boolean(obj.readOnly),
        tlsMode: (typeof obj.tlsMode === 'string' ? obj.tlsMode : base.tlsMode) as SavedConnection['tlsMode'],
        allowSelfSigned: Boolean(obj.allowSelfSigned),
        redisDb: typeof obj.redisDb === 'number' ? obj.redisDb : base.redisDb,
        authSource: typeof obj.authSource === 'string' ? obj.authSource : base.authSource,
        httpPath: typeof obj.httpPath === 'string' ? obj.httpPath : base.httpPath,
        sqliteMode: (typeof obj.sqliteMode === 'string' ? obj.sqliteMode : base.sqliteMode) as SavedConnection['sqliteMode'],
        sqliteFileName: typeof obj.sqliteFileName === 'string' ? obj.sqliteFileName : undefined,
        sshTunnel: {
          enabled: Boolean((obj.sshTunnel as Record<string, unknown> | undefined)?.enabled),
          hostLabel:
            typeof (obj.sshTunnel as Record<string, unknown> | undefined)?.hostLabel === 'string'
              ? String((obj.sshTunnel as Record<string, unknown>).hostLabel)
              : undefined,
        },
      });
    }
    return imported;
  }

  // Format 2: DBeaver `data-sources.json` (`{ connections: { "<id>": { provider, driver, name, folder, configuration: { host, port, database, user } } } }`)
  if (parsed.connections && typeof parsed.connections === 'object' && !Array.isArray(parsed.connections)) {
    const entries = Object.entries(parsed.connections as Record<string, unknown>);
    entries.forEach(([_key, val], idx) => {
      if (!val || typeof val !== 'object') return;
      const entry = val as Record<string, unknown>;
      const cfg = (entry.configuration && typeof entry.configuration === 'object'
        ? entry.configuration
        : {}) as Record<string, unknown>;
      const engine = mapDbeaverProvider(
        typeof entry.provider === 'string' ? entry.provider : undefined,
        typeof entry.driver === 'string' ? entry.driver : undefined,
      );
      const base = makeDefaultConnection(engine);
      const parsedPort = Number(cfg.port);
      imported.push({
        ...base,
        id: `conn-${now}-dbv-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : base.name,
        group: typeof entry.folder === 'string' ? entry.folder : '',
        host: typeof cfg.host === 'string' && cfg.host ? cfg.host : base.host,
        port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : base.port,
        database: typeof cfg.database === 'string' ? cfg.database : base.database,
        username: typeof cfg.user === 'string' ? cfg.user : base.username,
        readOnly: Boolean(entry['read-only'] ?? cfg['read-only']),
        hasPassword: false,
      });
    });
    return imported;
  }

  throw new Error('Unrecognized connections JSON format. Expected Netcatty JSON or DBeaver data-sources.json.');
}
