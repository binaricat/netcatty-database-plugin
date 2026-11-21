import { useEffect, useMemo, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import {
  canonicalHostStreamEndpoint,
  HostStreamEndpointError,
  supportsHostByteStreams,
  validateSshHostSelection,
  type SelectedSshHost,
} from './hostStreamEndpoint';
import {
  connectSshHostSql,
  SshHostSqlError,
  type SshHostColumnSummary,
  type SshHostReadResult,
  type SshHostSqlConnectOptions,
  type SshHostSqlEngine,
  type SshHostSqlSession,
  type SshHostTableSummary,
} from './sshHostSqlSession';

export interface SshHostDatabaseState {
  status: 'disconnected' | 'connecting' | 'connected' | 'closed';
  busy: boolean;
  engine: SshHostSqlEngine | null;
  endpoint: string | null;
  database: string | null;
  schema: string;
  hostLabel: string | null;
  error: string | null;
  tables: SshHostTableSummary[];
  tablesTruncated: boolean;
  selectedTable: string | null;
  columns: SshHostColumnSummary[];
  columnsTruncated: boolean;
  result: SshHostReadResult | null;
}

type SessionLike = Pick<SshHostSqlSession, 'engine' | 'endpoint' | 'database' | 'isClosed' | 'listTables' | 'listColumns' | 'readTable' | 'close'>;

export interface SshHostDatabaseDependencies {
  connect?: (options: SshHostSqlConnectOptions) => Promise<SessionLike>;
}

const initialState = (): SshHostDatabaseState => ({
  status: 'disconnected',
  busy: false,
  engine: null,
  endpoint: null,
  database: null,
  schema: 'public',
  hostLabel: null,
  error: null,
  tables: [],
  tablesTruncated: false,
  selectedTable: null,
  columns: [],
  columnsTruncated: false,
  result: null,
});

function safeErrorCode(error: unknown): string {
  if (error instanceof SshHostSqlError || error instanceof HostStreamEndpointError) {
    return error.code;
  }
  return 'unavailable';
}

export function createSshHostDatabaseController(
  deps: SshHostDatabaseDependencies,
  selectedHost?: SelectedSshHost,
  now = Date.now,
) {
  let state = initialState();
  let generation = 0;
  let session: SessionLike | null = null;
  let abort: AbortController | null = null;
  const listeners = new Set<() => void>();

  const emit = (patch: Partial<SshHostDatabaseState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const disconnect = () => {
    generation++;
    abort?.abort();
    abort = null;
    const old = session;
    session = null;
    state = initialState();
    for (const listener of listeners) listener();
    if (old) void old.close().catch(() => {});
  };

  const checkClosed = () => {
    if (session?.isClosed) {
      generation++;
      abort?.abort();
      abort = null;
      session = null;
      emit({
        status: 'closed',
        busy: false,
        error: 'closed',
        tables: [],
        tablesTruncated: false,
        selectedTable: null,
        columns: [],
        columnsTruncated: false,
        result: null,
      });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    disconnect,
    dispose: disconnect,
    checkClosed,

    async connect(input: { engine: SshHostSqlEngine; endpoint: string; database: string; schema?: string; username: string; password: string }) {
      if (state.busy || state.status === 'connected') return;
      if (!deps.connect) {
        emit({ error: 'unsupported-host' });
        return;
      }
      let validatedHost;
      let endpoint;
      try {
        validatedHost = validateSshHostSelection(selectedHost, now());
        endpoint = canonicalHostStreamEndpoint(input.endpoint);
      } catch (error) {
        emit({ error: safeErrorCode(error) });
        return;
      }
      const database = input.database.trim();
      const schema = (input.schema?.trim() || (input.engine === 'postgres' ? 'public' : database));
      disconnect();
      const rev = generation;
      abort = new AbortController();
      emit({
        status: 'connecting',
        busy: true,
        engine: input.engine,
        endpoint,
        database,
        schema,
        hostLabel: validatedHost.label,
        error: null,
      });
      try {
        const opened = await deps.connect({
          engine: input.engine,
          target: validatedHost.target,
          expectedRevision: validatedHost.expectedRevision,
          endpoint,
          database,
          username: input.username,
          password: input.password,
          signal: abort.signal,
        });
        if (rev !== generation) {
          void opened.close().catch(() => {});
          return;
        }
        session = opened;
        emit({
          status: opened.isClosed ? 'closed' : 'connected',
          busy: false,
          error: opened.isClosed ? 'closed' : null,
        });
        checkClosed();
      } catch (error) {
        if (rev === generation) {
          abort?.abort();
          abort = null;
          emit({
            status: 'disconnected',
            busy: false,
            engine: null,
            endpoint: null,
            database: null,
            error: safeErrorCode(error),
          });
        }
      }
    },

    async listTables(schemaOverride?: string) {
      checkClosed();
      if (state.busy || !session || state.status !== 'connected') return;
      const active = session;
      const rev = generation;
      const targetSchema = (schemaOverride ?? state.schema).trim();
      emit({ busy: true, error: null, schema: targetSchema });
      try {
        const page = await active.listTables(targetSchema, { signal: abort?.signal });
        if (rev === generation) {
          checkClosed();
          if (rev === generation) {
            emit({
              busy: false,
              tables: page.items,
              tablesTruncated: page.truncated,
              selectedTable: null,
              columns: [],
              columnsTruncated: false,
              result: null,
            });
          }
        }
      } catch (error) {
        if (rev === generation) {
          checkClosed();
          if (rev === generation) emit({ busy: false, error: safeErrorCode(error) });
        }
      }
    },

    async selectTable(tableName: string) {
      checkClosed();
      if (state.busy || !session || state.status !== 'connected') return;
      const active = session;
      const rev = generation;
      emit({ busy: true, error: null, selectedTable: tableName, columns: [], result: null });
      try {
        const page = await active.listColumns(state.schema, tableName, { signal: abort?.signal });
        if (rev === generation) {
          checkClosed();
          if (rev === generation) {
            emit({
              busy: false,
              columns: page.items,
              columnsTruncated: page.truncated,
            });
          }
        }
      } catch (error) {
        if (rev === generation) {
          checkClosed();
          if (rev === generation) emit({ busy: false, error: safeErrorCode(error) });
        }
      }
    },

    async readSelectedTable(limit = 50) {
      checkClosed();
      if (state.busy || !session || state.status !== 'connected' || !state.selectedTable || !state.columns.length) return;
      const active = session;
      const rev = generation;
      const cols = state.columns.slice(0, 16).map((col) => col.name);
      emit({ busy: true, error: null });
      try {
        const result = await active.readTable(state.schema, state.selectedTable, cols, { limit, signal: abort?.signal });
        if (rev === generation) {
          checkClosed();
          if (rev === generation) emit({ busy: false, result });
        }
      } catch (error) {
        if (rev === generation) {
          checkClosed();
          if (rev === generation) emit({ busy: false, error: safeErrorCode(error) });
        }
      }
    },
  };
}

export function useSshHostDatabase(context: PluginContext, selectedHost?: SelectedSshHost) {
  const hostStreamsEnabled = supportsHostByteStreams(context);
  const controller = useMemo(
    () => createSshHostDatabaseController(
      hostStreamsEnabled ? { connect: (options) => connectSshHostSql(context.network, options) } : {},
      selectedHost,
    ),
    [context, selectedHost, hostStreamsEnabled],
  );
  const [state, setState] = useState(controller.getSnapshot);
  useEffect(() => {
    setState(controller.getSnapshot());
    const unsubscribe = controller.subscribe(() => setState(controller.getSnapshot()));
    const timer = setInterval(controller.checkClosed, 500);
    return () => {
      clearInterval(timer);
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);
  return { ...state, controller, hostStreamsEnabled };
}
