/**
 * Persistent storage & encrypted secret manager for the DBX Workbench.
 * Uses Netcatty's `context.storage` (JSON KV) and `context.secrets` (encrypted plugin-owned secrets).
 * Passwords NEVER touch `context.storage`.
 */

import type { JsonValue, PluginContext } from '@netcatty/plugin-sdk';
import type { PersistedTabDraft, QueryHistoryEntry, SavedConnection, SavedSnippet } from './types';

const CONNECTIONS_KEY = 'dbx.connections.v1';
const HISTORY_KEY = 'dbx.history.v1';
const SNIPPETS_KEY = 'dbx.snippets.v1';
const TABS_PREFIX = 'dbx.tabs.v1.';
const SECRET_PREFIX = 'dbx.password.v1.';
const MAX_HISTORY = 200;

/** Recursively strips `undefined` properties so values strictly satisfy Netcatty's JSON wire boundary. */
export function toWireJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class WorkbenchStorage {
  constructor(private readonly context: PluginContext) {}

  async loadConnections(): Promise<SavedConnection[]> {
    try {
      const raw = await this.context.storage.get<JsonValue>(CONNECTIONS_KEY);
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((item): item is Record<string, JsonValue> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
        .map((item) => sanitizeConnection(item));
    } catch {
      return [];
    }
  }

  async saveConnections(connections: SavedConnection[]): Promise<void> {
    // Strip any ephemeral handles and all `undefined` properties before storing over wire IPC.
    const clean = connections.map((c) => {
      const { sqliteFileHandleId: _ephemeral, ...rest } = c;
      return rest;
    });
    await this.context.storage.set(CONNECTIONS_KEY, toWireJson(clean));
  }

  async savePassword(connectionId: string, password: string): Promise<boolean> {
    if (!this.context.secrets) return false;
    try {
      if (!password) {
        await this.context.secrets.delete(`${SECRET_PREFIX}${connectionId}`);
        return false;
      }
      await this.context.secrets.set(`${SECRET_PREFIX}${connectionId}`, password);
      return true;
    } catch {
      return false;
    }
  }

  async readPassword(connectionId: string): Promise<string | undefined> {
    if (!this.context.secrets) return undefined;
    try {
      if (typeof this.context.secrets.getPlaintext === 'function') {
        return await this.context.secrets.getPlaintext(`${SECRET_PREFIX}${connectionId}`);
      }
      if (typeof this.context.secrets.readOwn === 'function') {
        return await this.context.secrets.readOwn(`${SECRET_PREFIX}${connectionId}`);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async deletePassword(connectionId: string): Promise<void> {
    if (!this.context.secrets) return;
    try {
      await this.context.secrets.delete(`${SECRET_PREFIX}${connectionId}`);
    } catch {
      // ignore
    }
  }

  async loadHistory(): Promise<QueryHistoryEntry[]> {
    try {
      const raw = await this.context.storage.get<JsonValue>(HISTORY_KEY);
      return Array.isArray(raw) ? (raw as unknown as QueryHistoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  async appendHistory(entry: QueryHistoryEntry, existing: QueryHistoryEntry[]): Promise<QueryHistoryEntry[]> {
    const next = [entry, ...existing].slice(0, MAX_HISTORY);
    try {
      await this.context.storage.set(HISTORY_KEY, toWireJson(next));
    } catch {
      // ignore storage quota / permission issues
    }
    return next;
  }

  async clearHistory(): Promise<void> {
    try {
      await this.context.storage.set(HISTORY_KEY, []);
    } catch {
      // ignore
    }
  }

  async loadSnippets(): Promise<SavedSnippet[]> {
    try {
      const raw = await this.context.storage.get<JsonValue>(SNIPPETS_KEY);
      return Array.isArray(raw) ? (raw as unknown as SavedSnippet[]) : [];
    } catch {
      return [];
    }
  }

  async saveSnippets(snippets: SavedSnippet[]): Promise<void> {
    try {
      await this.context.storage.set(SNIPPETS_KEY, toWireJson(snippets));
    } catch {
      // ignore
    }
  }

  async loadTabDrafts(connectionId: string): Promise<PersistedTabDraft[]> {
    try {
      const raw = await this.context.storage.get<JsonValue>(`${TABS_PREFIX}${connectionId}`);
      return Array.isArray(raw) ? (raw as unknown as PersistedTabDraft[]) : [];
    } catch {
      return [];
    }
  }

  async saveTabDrafts(connectionId: string, drafts: PersistedTabDraft[]): Promise<void> {
    try {
      await this.context.storage.set(`${TABS_PREFIX}${connectionId}`, toWireJson(drafts.slice(0, 16)));
    } catch {
      // ignore
    }
  }

  async deleteTabDrafts(connectionId: string): Promise<void> {
    try {
      await this.context.storage.delete(`${TABS_PREFIX}${connectionId}`);
    } catch {
      // ignore
    }
  }
}

function sanitizeConnection(raw: Record<string, JsonValue>): SavedConnection {
  const ssh = (raw.sshTunnel && typeof raw.sshTunnel === 'object' && !Array.isArray(raw.sshTunnel)
    ? raw.sshTunnel
    : {}) as Record<string, JsonValue>;
  return {
    id: String(raw.id ?? `conn-${Date.now()}`),
    name: String(raw.name ?? 'Untitled'),
    group: String(raw.group ?? ''),
    color: (typeof raw.color === 'string' ? raw.color : 'none') as SavedConnection['color'],
    engine: (typeof raw.engine === 'string' ? raw.engine : 'postgres') as SavedConnection['engine'],
    host: String(raw.host ?? '127.0.0.1'),
    port: typeof raw.port === 'number' ? raw.port : 5432,
    database: String(raw.database ?? ''),
    schema: String(raw.schema ?? ''),
    username: String(raw.username ?? ''),
    hasPassword: Boolean(raw.hasPassword),
    tlsMode: (typeof raw.tlsMode === 'string' ? raw.tlsMode : 'prefer') as SavedConnection['tlsMode'],
    allowSelfSigned: Boolean(raw.allowSelfSigned),
    redisDb: typeof raw.redisDb === 'number' ? raw.redisDb : 0,
    authSource: String(raw.authSource ?? 'admin'),
    httpPath: String(raw.httpPath ?? '/'),
    sqliteMode: (typeof raw.sqliteMode === 'string' ? raw.sqliteMode : 'demo') as SavedConnection['sqliteMode'],
    sqliteFileName: typeof raw.sqliteFileName === 'string' ? raw.sqliteFileName : undefined,
    sshTunnel: {
      enabled: Boolean(ssh.enabled),
      hostLabel: typeof ssh.hostLabel === 'string' ? ssh.hostLabel : undefined,
      hostBindingToken: typeof ssh.hostBindingToken === 'string' ? ssh.hostBindingToken : undefined,
    },
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}
