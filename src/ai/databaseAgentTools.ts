/**
 * Native Catty Agent Database Tools & Contextual Summary Builder.
 * Exposes 7 strictly-bounded, credential-free Database Agent tools to Netcatty's
 * native Catty Agent sidebar (`ai.sidebar-tools`), reusing our live 51-engine drivers,
 * strict read-only BI SQL gate, and 10-chart `PluginBiChart` auto-chart engine.
 */

import type {
  Disposable,
  JsonValue,
  PluginAISetContextParams,
  PluginAIToolDefinition,
  PluginBiChartToolArtifact,
  PluginContext,
  PluginSqlResultToolArtifact,
} from '@netcatty/plugin-sdk';
type JsonObject = Record<string, JsonValue>;
import { PLUGIN_AI_SIDEBAR_TOOLS_FEATURE } from '@netcatty/plugin-sdk';
import type { CellValue, MongoDriver, QueryResultSet, RelationalDriver, TableStructure } from '../drivers/types';
import {
  appendMongoSafeLimit,
  BI_AGGREGATIONS,
  BI_CHART_TYPES,
  BI_PALETTES,
  BI_VALUE_FORMATS,
  buildBiChartProps,
  buildBiSchemaContext,
  buildSchemaStarterQuestions,
  flattenMongoDocsToResultSet,
  formatMongoBiQuery,
  parseMongoBiQuery,
  recommendChartConfig,
  validateBiReadOnlySql,
  type BiAggregation,
  type BiChartConfig,
  type BiChartPalette,
  type BiChartType,
  type BiChartValueFormat,
  type BiKpiItem,
  type BiSortOrder,
  type BiTopN,
} from '../bi/index';
import { engineToSqlDialect, isMongoDriver, isRelationalDriver, schemaCacheKey } from '../ui/sessionManager';
import { toWireJson } from '../ui/storage';
import type { ActiveSession, SavedConnection } from '../ui/types';

export const DATABASE_WORKBENCH_VIEW_ID = 'com.binaricat.netcatty-database.workbench';
export const AI_SIDEBAR_TOOLS_FEATURE = PLUGIN_AI_SIDEBAR_TOOLS_FEATURE;

export interface DatabaseAgentHostBridge {
  getConnections: () => SavedConnection[];
  getSessions: () => Record<string, ActiveSession>;
  getActiveConnectionId: () => string | null;
  getActiveSql: () => string;
  getLocale: () => string;
  openSqlTab: (connectionId: string, sql: string, title?: string) => void;
  pinChartToDashboard: (
    connectionId: string,
    payload: {
      title: string;
      sql: string;
      result: QueryResultSet;
      chartConfig: BiChartConfig;
    },
  ) => Promise<void>;
  ensureSchemaLoaded: (connectionId: string, database: string, schema: string) => Promise<void>;
}

export const DATABASE_AGENT_TOOLS: readonly PluginAIToolDefinition[] = [
  {
    name: 'db_list_connections',
    description:
      'List all saved and currently connected database connections in Netcatty Database (metadata only; never returns passwords or secrets).',
    risk: 'read',
    viewId: DATABASE_WORKBENCH_VIEW_ID,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'db_list_tables',
    description:
      'List schemas, tables, views (or MongoDB collections) and row count estimates for the active database connection (or a specified connectionId/database/schema).',
    risk: 'read',
    viewId: DATABASE_WORKBENCH_VIEW_ID,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'Optional connection ID; defaults to the active connection.' },
        database: { type: 'string', description: 'Optional database name; defaults to the active database.' },
        schema: { type: 'string', description: 'Optional schema name; defaults to the active schema.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'db_describe_table',
    description:
      'Inspect a table (or MongoDB collection) schema in detail: columns/inferred fields, data types, nullability/presence, primary keys, foreign keys, indexes, and check constraints.',
    risk: 'read',
    viewId: DATABASE_WORKBENCH_VIEW_ID,
    inputSchema: {
      type: 'object',
      required: ['table'],
      properties: {
        table: { type: 'string', description: 'Table name to describe.' },
        connectionId: { type: 'string', description: 'Optional connection ID.' },
        database: { type: 'string', description: 'Optional database name.' },
        schema: { type: 'string', description: 'Optional schema name.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'db_run_readonly_sql',
    description:
      'Execute a strictly read-only SQL query (SELECT, WITH CTE, EXPLAIN, SHOW) OR for MongoDB a read-only JSON aggregation {"collection":"<name>","pipeline":[...]} (blocking $out/$merge) with automatic row limiting (default 200) and render an inline result table artifact. Never executes writes/DDL; use db_open_sql_tab to draft writes for user review.',
    risk: 'read',
    viewId: DATABASE_WORKBENCH_VIEW_ID,
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'Single read-only SQL query (SELECT / WITH / EXPLAIN / SHOW).' },
        limit: { type: 'number', description: 'Maximum rows to return (1..500, default 200).' },
        title: { type: 'string', description: 'Optional short title for opening the SQL in an editor tab.' },
        connectionId: { type: 'string', description: 'Optional connection ID.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'db_create_bi_chart',
    description:
      'Run a strictly read-only SQL query (or for MongoDB, JSON {"collection":"<name>","pipeline":[...]}) and render an interactive inline BI chart (bar, horizontal-bar, stacked-bar, line, area, pie, donut, scatter, funnel, or combo) with KPI metrics directly inside the chat, complete with 1-click Pin to BI Dashboard action.',
    risk: 'read',
    viewId: DATABASE_WORKBENCH_VIEW_ID,
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'Single read-only analytical SQL query.' },
        title: { type: 'string', description: 'Concise chart title (max 80 chars).' },
        description: { type: 'string', description: 'Optional one-sentence chart subtitle/description.' },
        chartType: {
          type: 'string',
          enum: [...BI_CHART_TYPES],
          description: 'Optional chart type; auto-recommended from column profiles if omitted.',
        },
        xField: { type: 'string', description: 'Optional X-axis or category column name.' },
        yFields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional numeric metric column name(s).',
        },
        groupByField: { type: 'string', description: 'Optional second categorical column for stacked-bar.' },
        aggregation: {
          type: 'string',
          enum: [...BI_AGGREGATIONS],
          description: 'Optional aggregation function (sum/avg/count/min/max).',
        },
        sort: {
          type: 'string',
          enum: ['none', 'value-desc', 'value-asc', 'label-asc'],
          description: 'Optional category sort order.',
        },
        topN: {
          type: 'number',
          enum: [0, 10, 20, 50],
          description: 'Optional top-N cap rolling tail categories into Other.',
        },
        valueFormat: {
          type: 'string',
          enum: [...BI_VALUE_FORMATS],
          description: 'Optional value formatter (compact/number/currency/percent/bytes/ms).',
        },
        currency: { type: 'string', description: 'Optional 3-letter ISO currency code (e.g. USD, CNY).' },
        palette: {
          type: 'string',
          enum: [...BI_PALETTES],
          description: 'Optional color palette.',
        },
        connectionId: { type: 'string', description: 'Optional connection ID.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'db_pin_chart_to_dashboard',
    description:
      'Pin an analytical SQL query and its BI chart configuration onto the active connection persistent BI Dashboard.',
    risk: 'read',
    viewId: DATABASE_WORKBENCH_VIEW_ID,
    inputSchema: {
      type: 'object',
      required: ['title', 'sql'],
      properties: {
        title: { type: 'string', description: 'Chart card title.' },
        sql: { type: 'string', description: 'Single read-only SQL query.' },
        chartConfig: {
          type: 'object',
          description: 'Optional full BiChartConfig object.',
        },
        chartType: { type: 'string', enum: [...BI_CHART_TYPES] },
        xField: { type: 'string' },
        yFields: { type: 'array', items: { type: 'string' } },
        groupByField: { type: 'string' },
        aggregation: { type: 'string', enum: [...BI_AGGREGATIONS] },
        valueFormat: { type: 'string', enum: [...BI_VALUE_FORMATS] },
        connectionId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'db_open_sql_tab',
    description:
      'Open a new SQL Editor tab in Netcatty Database pre-filled with SQL without executing it. Use this whenever drafting write/DDL statements (INSERT/UPDATE/DELETE/CREATE/ALTER) or complex queries for the user to inspect and run.',
    risk: 'read',
    viewId: DATABASE_WORKBENCH_VIEW_ID,
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'SQL text to place in the editor tab.' },
        title: { type: 'string', description: 'Optional tab title.' },
        connectionId: { type: 'string', description: 'Optional connection ID.' },
      },
      additionalProperties: false,
    },
  },
];

function toPrimitiveCell(value: CellValue | undefined): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  try {
    const s = JSON.stringify(value);
    return s.length > 240 ? `${s.slice(0, 237)}...` : s;
  } catch {
    return '[Object]';
  }
}

function mapKpisForArtifact(kpis: BiKpiItem[]): NonNullable<PluginBiChartToolArtifact['kpis']> {
  return kpis.slice(0, 5).map((k) => ({
    label: k.label,
    value: k.formattedValue,
    ...(k.subtext ? { delta: k.subtext } : {}),
    tone: k.tone === 'positive' ? 'positive' : k.tone === 'negative' ? 'negative' : 'default',
  }));
}

function resolveSession(bridge: DatabaseAgentHostBridge, connectionId?: string): ActiveSession | null {
  const sessions = bridge.getSessions();
  if (connectionId && sessions[connectionId]) return sessions[connectionId];
  const activeId = bridge.getActiveConnectionId();
  if (activeId && sessions[activeId]) return sessions[activeId];
  const first = Object.values(sessions)[0];
  return first ?? null;
}

function mergeChartConfigFromArgs(result: QueryResultSet, args: Record<string, unknown>): BiChartConfig {
  const auto = recommendChartConfig(result);
  const nested =
    args.chartConfig && typeof args.chartConfig === 'object' && !Array.isArray(args.chartConfig)
      ? (args.chartConfig as Record<string, unknown>)
      : {};
  const src = { ...nested, ...args };
  const colSet = new Set(result.columns.map((c) => c.name));

  const chartTypeRaw =
    typeof src.chartType === 'string' ? src.chartType : typeof src.type === 'string' ? src.type : undefined;
  const type =
    chartTypeRaw && (BI_CHART_TYPES as readonly string[]).includes(chartTypeRaw)
      ? (chartTypeRaw as BiChartType)
      : auto.type;

  const xField = typeof src.xField === 'string' && colSet.has(src.xField) ? src.xField : auto.xField;
  const rawYs = Array.isArray(src.yFields)
    ? src.yFields.filter((f): f is string => typeof f === 'string' && colSet.has(f))
    : [];
  const yFields = rawYs.length > 0 ? rawYs : auto.yFields;
  const groupByField =
    typeof src.groupByField === 'string' && colSet.has(src.groupByField) && src.groupByField !== xField
      ? src.groupByField
      : auto.groupByField;

  const aggRaw = typeof src.aggregation === 'string' ? src.aggregation : undefined;
  const aggregation =
    aggRaw && (BI_AGGREGATIONS as readonly string[]).includes(aggRaw)
      ? (aggRaw as BiAggregation)
      : auto.aggregation;

  const fmtRaw = typeof src.valueFormat === 'string' ? src.valueFormat : undefined;
  const valueFormat =
    fmtRaw && (BI_VALUE_FORMATS as readonly string[]).includes(fmtRaw)
      ? (fmtRaw as BiChartValueFormat)
      : auto.valueFormat;

  const palRaw = typeof src.palette === 'string' ? src.palette : undefined;
  const palette =
    palRaw && (BI_PALETTES as readonly string[]).includes(palRaw)
      ? (palRaw as BiChartPalette)
      : auto.palette;

  const sortRaw = typeof src.sort === 'string' ? src.sort : undefined;
  const sort: BiSortOrder =
    sortRaw === 'none' || sortRaw === 'value-desc' || sortRaw === 'value-asc' || sortRaw === 'label-asc'
      ? sortRaw
      : auto.sort;

  const topNRaw = typeof src.topN === 'number' ? src.topN : undefined;
  const topN: BiTopN = topNRaw === 0 || topNRaw === 10 || topNRaw === 20 || topNRaw === 50 ? topNRaw : auto.topN;

  return {
    ...auto,
    type,
    xField,
    yFields,
    groupByField,
    aggregation,
    sort,
    topN,
    valueFormat,
    currency: typeof src.currency === 'string' && /^[A-Z]{3}$/.test(src.currency) ? src.currency : auto.currency,
    palette,
  };
}

/**
 * Executes one of the 7 Database Agent tools against live workbench state and drivers.
 * Always returns strictly wire-safe `JsonObject` with zero credentials or `undefined` fields.
 */
export async function executeDatabaseAgentTool(
  toolName: string,
  rawArgs: Readonly<Record<string, unknown>> | undefined,
  bridge: DatabaseAgentHostBridge,
): Promise<JsonObject> {
  const args: Record<string, unknown> = rawArgs && typeof rawArgs === 'object' ? { ...rawArgs } : {};
  const requestedConnId = typeof args.connectionId === 'string' ? args.connectionId : undefined;
  const isZh = (bridge.getLocale() || 'en').toLowerCase().startsWith('zh');

  if (toolName === 'db_list_connections') {
    const connections = bridge.getConnections();
    const sessions = bridge.getSessions();
    const activeConnectionId = bridge.getActiveConnectionId();
    return toWireJson({
      activeConnectionId,
      activeCount: Object.keys(sessions).length,
      connections: connections.map((c) => {
        const sess = sessions[c.id];
        return {
          id: c.id,
          name: c.name,
          group: c.group || undefined,
          engine: c.engine,
          host: c.engine === 'sqlite' ? c.sqliteFileName || 'in-memory' : c.host,
          port: c.engine === 'sqlite' ? undefined : c.port,
          database: sess?.activeDatabase || c.database,
          schema: sess?.activeSchema || c.schema || undefined,
          readOnly: Boolean(c.readOnly),
          connected: Boolean(sess),
          serverVersion: sess?.info.serverVersion,
        };
      }),
    }) as JsonObject;
  }

  const session = resolveSession(bridge, requestedConnId);
  if (!session) {
    throw new Error(
      'No active database connection. Ask the user to connect to a database or launch Sample SQLite first.',
    );
  }

  if (toolName === 'db_open_sql_tab') {
    const sql = typeof args.sql === 'string' ? args.sql : '';
    if (!sql.trim()) throw new Error('sql parameter is required.');
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 60) : 'AI Draft';
    bridge.openSqlTab(session.connectionId, sql, title);
    return toWireJson({
      opened: true,
      connectionId: session.connectionId,
      connectionName: session.connection.name,
      title,
      sqlLength: sql.length,
    }) as JsonObject;
  }

  if (isMongoDriver(session.driver)) {
    const mongoDriver = session.driver as MongoDriver;
    const database =
      typeof args.database === 'string' && args.database.trim()
        ? args.database.trim()
        : session.activeDatabase;

    if (toolName === 'db_list_tables') {
      const collections =
        session.mongoCollectionsByDb[database] ?? (await mongoDriver.listCollections(database));
      return toWireJson({
        connectionId: session.connectionId,
        connectionName: session.connection.name,
        engine: session.connection.engine,
        family: 'mongodb',
        database,
        collections: collections.slice(0, 120).map((c) => ({
          name: c.name,
          type: c.type,
        })),
        tables: collections.slice(0, 120).map((c) => ({
          name: c.name,
          kind: c.type || 'collection',
        })),
      }) as JsonObject;
    }

    if (toolName === 'db_describe_table') {
      const collection = typeof args.table === 'string' ? args.table.trim() : '';
      if (!collection) throw new Error('table (collection) parameter is required.');
      const [analysis, indexes] = await Promise.all([
        mongoDriver.analyzeCollectionSchema(database, collection, 50),
        mongoDriver.listIndexes(database, collection).catch(() => []),
      ]);
      return toWireJson({
        connectionId: session.connectionId,
        connectionName: session.connection.name,
        family: 'mongodb',
        database,
        collection,
        sampleCount: analysis.sampleCount,
        totalDocuments: analysis.totalDocuments,
        fields: analysis.fields.map((f) => ({
          path: f.path,
          types: f.types,
          percentage: f.percentage,
          samples: f.samples.slice(0, 3),
        })),
        columns: analysis.fields.map((f) => ({
          name: f.path,
          dataType: f.types.map((tp) => tp.type).join(' | ') || 'mixed',
          nullable: f.percentage < 100,
          isPrimaryKey: f.path === '_id',
        })),
        indexes: indexes.map((ix) => ({
          name: ix.name,
          key: ix.key,
          unique: Boolean(ix.unique),
        })),
      }) as JsonObject;
    }

    if (toolName === 'db_run_readonly_sql') {
      const rawQuery = typeof args.sql === 'string' ? args.sql : '';
      const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 200;
      const maxRows = Math.max(1, Math.min(500, Math.floor(requestedLimit)));
      const parsed = parseMongoBiQuery(rawQuery);
      const targetDb = parsed.database || database;
      const safePipeline = appendMongoSafeLimit(parsed.pipeline, maxRows);
      const formattedQuery = formatMongoBiQuery({ database: targetDb, collection: parsed.collection, pipeline: safePipeline });

      const started = performance.now();
      const docs = await mongoDriver.aggregate(targetDb, parsed.collection, safePipeline);
      const res = flattenMongoDocsToResultSet(docs, Math.round(performance.now() - started), formattedQuery);
      const columns = res.columns.map((c) => c.name);
      const safeRows = res.rows.slice(0, maxRows).map((r) => r.map((cell) => toPrimitiveCell(cell)));
      const title =
        typeof args.title === 'string' && args.title.trim()
          ? args.title.trim().slice(0, 60)
          : `${parsed.collection} Aggregate`;
      const truncated = safeRows.length > 50;

      const artifact: PluginSqlResultToolArtifact = {
        kind: 'sql-result',
        title,
        sql: formattedQuery,
        columns,
        rows: safeRows.slice(0, 50),
        rowCount: res.rowCount,
        totalRows: res.rowCount,
        durationMs: res.executionMs,
        truncated,
        chartAction: {
          toolName: 'db_create_bi_chart',
          label: isZh ? '生成 BI 图表' : 'Visualize as Chart',
          args: { sql: formattedQuery, title, connectionId: session.connectionId },
        },
      };

      return toWireJson({
        sql: formattedQuery,
        collection: parsed.collection,
        columns,
        rows: safeRows.slice(0, 50),
        rowCount: res.rowCount,
        truncated,
        executionMs: res.executionMs,
        _netcattyArtifact: artifact,
      }) as JsonObject;
    }

    if (toolName === 'db_create_bi_chart') {
      const rawQuery = typeof args.sql === 'string' ? args.sql : '';
      const parsed = parseMongoBiQuery(rawQuery);
      const targetDb = parsed.database || database;
      const safePipeline = appendMongoSafeLimit(parsed.pipeline, 500);
      const formattedQuery = formatMongoBiQuery({ database: targetDb, collection: parsed.collection, pipeline: safePipeline });

      const started = performance.now();
      const docs = await mongoDriver.aggregate(targetDb, parsed.collection, safePipeline);
      const res = flattenMongoDocsToResultSet(docs, Math.round(performance.now() - started), formattedQuery);
      if (res.columns.length === 0) {
        throw new Error('MongoDB aggregation returned no tabular columns to chart.');
      }

      const title =
        typeof args.title === 'string' && args.title.trim()
          ? args.title.trim().slice(0, 80)
          : `${parsed.collection} BI Chart`;
      const description =
        typeof args.description === 'string' && args.description.trim()
          ? args.description.trim().slice(0, 180)
          : undefined;
      const chartConfig = mergeChartConfigFromArgs(res, args);
      const built = buildBiChartProps(res, chartConfig, {
        title,
        subtitle: description,
        height: 260,
      });

      const artifact: PluginBiChartToolArtifact = {
        kind: 'bi-chart',
        title,
        subtitle: description,
        chartSpec: toWireJson(built.props) as unknown as PluginBiChartToolArtifact['chartSpec'],
        kpis: mapKpisForArtifact(built.kpis),
        sql: formattedQuery,
        pinAction: {
          toolName: 'db_pin_chart_to_dashboard',
          label: isZh ? '固定到 BI 看板' : 'Pin to BI Dashboard',
          args: toWireJson({
            title,
            sql: formattedQuery,
            chartConfig,
            connectionId: session.connectionId,
          }) as Record<string, JsonValue>,
        },
      };

      return toWireJson({
        title,
        description,
        sql: formattedQuery,
        collection: parsed.collection,
        chartType: chartConfig.type,
        xField: built.effectiveXField,
        yFields: built.effectiveYFields,
        rowCount: res.rowCount,
        executionMs: res.executionMs,
        kpis: artifact.kpis,
        insights: built.insights,
        _netcattyArtifact: artifact,
      }) as JsonObject;
    }

    if (toolName === 'db_pin_chart_to_dashboard') {
      const rawQuery = typeof args.sql === 'string' ? args.sql : '';
      const title =
        typeof args.title === 'string' && args.title.trim()
          ? args.title.trim().slice(0, 80)
          : 'Pinned MongoDB Chart';
      const parsed = parseMongoBiQuery(rawQuery);
      const targetDb = parsed.database || database;
      const safePipeline = appendMongoSafeLimit(parsed.pipeline, 500);
      const formattedQuery = formatMongoBiQuery({ database: targetDb, collection: parsed.collection, pipeline: safePipeline });

      const started = performance.now();
      const docs = await mongoDriver.aggregate(targetDb, parsed.collection, safePipeline);
      const res = flattenMongoDocsToResultSet(docs, Math.round(performance.now() - started), formattedQuery);
      if (res.columns.length === 0) {
        throw new Error('Pinned MongoDB aggregation returned no tabular columns.');
      }

      const chartConfig = mergeChartConfigFromArgs(res, args);
      await bridge.pinChartToDashboard(session.connectionId, {
        title,
        sql: formattedQuery,
        result: res,
        chartConfig,
      });

      return toWireJson({
        pinned: true,
        title,
        connectionId: session.connectionId,
        connectionName: session.connection.name,
        collection: parsed.collection,
        chartType: chartConfig.type,
        rowCount: res.rowCount,
      }) as JsonObject;
    }

    throw new Error(`Unknown Database Agent tool: ${toolName}`);
  }

  if (!isRelationalDriver(session.driver)) {
    return toWireJson({
      connectionId: session.connectionId,
      connectionName: session.connection.name,
      engine: session.connection.engine,
      family: session.family,
      message: `Connection "${session.connection.name}" uses the ${session.family} engine. SQL tools require a relational SQL connection.`,
      mongoCollections: session.mongoCollectionsByDb[session.activeDatabase]?.map((c) => c.name),
      searchIndices: session.searchIndices?.map((i) => i.name),
      kvNamespaces: session.kvNamespaces?.map((n) => n.name),
    }) as JsonObject;
  }

  const driver = session.driver as RelationalDriver;
  const dialect = engineToSqlDialect(session.connection.engine);
  const database = typeof args.database === 'string' && args.database.trim() ? args.database.trim() : session.activeDatabase;
  const schema = typeof args.schema === 'string' && args.schema.trim() ? args.schema.trim() : session.activeSchema;

  if (toolName === 'db_list_tables') {
    const key = schemaCacheKey(database, schema);
    if (!session.objectsBySchema[key]?.loaded) {
      await bridge.ensureSchemaLoaded(session.connectionId, database, schema);
    }
    const refreshed = resolveSession(bridge, session.connectionId) ?? session;
    const cache = refreshed.objectsBySchema[key];
    const tables = cache?.tables ?? (await driver.listTables(database, schema));
    const views = cache?.views ?? (await driver.listViews(database, schema).catch(() => []));

    return toWireJson({
      connectionId: session.connectionId,
      connectionName: session.connection.name,
      engine: session.connection.engine,
      dialect,
      database,
      schema,
      schemas: session.schemas.map((s) => s.name).slice(0, 50),
      tables: tables.slice(0, 120).map((t) => ({
        name: t.name,
        kind: t.kind,
        rowCountEstimate: t.rowCountEstimate,
        comment: t.comment,
      })),
      views: views.slice(0, 60).map((v) => ({
        name: v.name,
        isMaterialized: v.isMaterialized,
      })),
    }) as JsonObject;
  }

  if (toolName === 'db_describe_table') {
    const table = typeof args.table === 'string' ? args.table.trim() : '';
    if (!table) throw new Error('table parameter is required.');
    const key = schemaCacheKey(database, schema);
    const cached = session.objectsBySchema[key]?.structures[table];
    const structure: TableStructure = cached ?? (await driver.getTableStructure(database, schema, table));

    return toWireJson({
      connectionId: session.connectionId,
      connectionName: session.connection.name,
      dialect,
      database,
      schema,
      table: structure.table,
      columns: structure.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        nullable: c.nullable,
        defaultValue: c.defaultValue,
        isPrimaryKey: c.isPrimaryKey,
        isForeignKey: c.isForeignKey,
        isAutoIncrement: c.isAutoIncrement,
        unique: c.unique,
        comment: c.comment,
      })),
      indexes: structure.indexes.map((i) => ({
        name: i.name,
        columns: i.columns,
        unique: i.unique,
        primary: i.primary,
      })),
      foreignKeys: structure.foreignKeys.map((fk) => ({
        name: fk.name,
        columns: fk.columns,
        referencedSchema: fk.referencedSchema,
        referencedTable: fk.referencedTable,
        referencedColumns: fk.referencedColumns,
      })),
      checkConstraints: structure.checkConstraints ?? [],
    }) as JsonObject;
  }

  if (toolName === 'db_run_readonly_sql') {
    const rawSql = typeof args.sql === 'string' ? args.sql : '';
    const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 200;
    const maxRows = Math.max(1, Math.min(500, Math.floor(requestedLimit)));
    const check = validateBiReadOnlySql(rawSql, dialect, maxRows);
    if (!check.ok) {
      throw new Error(
        `Read-only SQL guard blocked this query: ${check.reason} Use db_open_sql_tab to draft write or DDL statements for the user to review.`,
      );
    }

    const multi = await driver.query(check.safeSql, { maxRows });
    const res = multi.results[0];
    if (!res) {
      return toWireJson({
        sql: check.safeSql,
        columns: [],
        rows: [],
        rowCount: 0,
        executionMs: multi.totalExecutionMs,
      }) as JsonObject;
    }

    const columns = res.columns.map((c) => c.name);
    const safeRows = res.rows.slice(0, maxRows).map((r) => r.map((cell) => toPrimitiveCell(cell)));
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 60) : 'AI Query';
    const truncated = res.truncated || safeRows.length > 50;

    const artifact: PluginSqlResultToolArtifact = {
      kind: 'sql-result',
      title,
      sql: check.safeSql,
      columns,
      rows: safeRows.slice(0, 50),
      rowCount: res.rowCount,
      totalRows: res.rowCount,
      durationMs: res.executionMs,
      truncated,
      openAction: {
        toolName: 'db_open_sql_tab',
        label: isZh ? '在 SQL 编辑器打开' : 'Open in SQL Editor',
        args: { sql: check.safeSql, title, connectionId: session.connectionId },
      },
      chartAction: {
        toolName: 'db_create_bi_chart',
        label: isZh ? '生成 BI 图表' : 'Visualize as Chart',
        args: { sql: check.safeSql, title, connectionId: session.connectionId },
      },
    };

    return toWireJson({
      sql: check.safeSql,
      limitApplied: check.limitApplied,
      columns,
      rows: safeRows.slice(0, 50),
      rowCount: res.rowCount,
      truncated,
      executionMs: res.executionMs,
      _netcattyArtifact: artifact,
    }) as JsonObject;
  }

  if (toolName === 'db_create_bi_chart') {
    const rawSql = typeof args.sql === 'string' ? args.sql : '';
    const check = validateBiReadOnlySql(rawSql, dialect, 500);
    if (!check.ok) {
      throw new Error(`Read-only SQL guard blocked BI chart query: ${check.reason}`);
    }

    const multi = await driver.query(check.safeSql, { maxRows: 500 });
    const res = multi.results[0];
    if (!res || res.columns.length === 0) {
      throw new Error('Query returned no tabular columns to chart.');
    }

    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 80) : 'BI Chart';
    const description =
      typeof args.description === 'string' && args.description.trim()
        ? args.description.trim().slice(0, 180)
        : undefined;
    const chartConfig = mergeChartConfigFromArgs(res, args);
    const built = buildBiChartProps(res, chartConfig, {
      title,
      subtitle: description,
      height: 260,
    });

    const artifact: PluginBiChartToolArtifact = {
      kind: 'bi-chart',
      title,
      subtitle: description,
      chartSpec: toWireJson(built.props) as unknown as PluginBiChartToolArtifact['chartSpec'],
      kpis: mapKpisForArtifact(built.kpis),
      sql: check.safeSql,
      pinAction: {
        toolName: 'db_pin_chart_to_dashboard',
        label: isZh ? '固定到 BI 看板' : 'Pin to BI Dashboard',
        args: toWireJson({
          title,
          sql: check.safeSql,
          chartConfig,
          connectionId: session.connectionId,
        }) as Record<string, JsonValue>,
      },
      openAction: {
        toolName: 'db_open_sql_tab',
        label: isZh ? '在 SQL 编辑器打开' : 'Open in SQL Editor',
        args: {
          sql: check.safeSql,
          title,
          connectionId: session.connectionId,
        },
      },
    };

    return toWireJson({
      title,
      description,
      sql: check.safeSql,
      chartType: chartConfig.type,
      xField: built.effectiveXField,
      yFields: built.effectiveYFields,
      rowCount: res.rowCount,
      executionMs: res.executionMs,
      kpis: artifact.kpis,
      insights: built.insights,
      _netcattyArtifact: artifact,
    }) as JsonObject;
  }

  if (toolName === 'db_pin_chart_to_dashboard') {
    const rawSql = typeof args.sql === 'string' ? args.sql : '';
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 80) : 'Pinned BI Chart';
    const check = validateBiReadOnlySql(rawSql, dialect, 500);
    if (!check.ok) {
      throw new Error(`Read-only SQL guard blocked pinned chart SQL: ${check.reason}`);
    }

    const multi = await driver.query(check.safeSql, { maxRows: 500 });
    const res = multi.results[0];
    if (!res || res.columns.length === 0) {
      throw new Error('Pinned chart query returned no tabular columns.');
    }

    const chartConfig = mergeChartConfigFromArgs(res, args);
    await bridge.pinChartToDashboard(session.connectionId, {
      title,
      sql: check.safeSql,
      result: res,
      chartConfig,
    });

    return toWireJson({
      pinned: true,
      title,
      connectionId: session.connectionId,
      connectionName: session.connection.name,
      chartType: chartConfig.type,
      rowCount: res.rowCount,
    }) as JsonObject;
  }

  throw new Error(`Unknown Database Agent tool: ${toolName}`);
}

/**
 * Builds bounded live context (`<= 10 KB` UTF-8) + schema-tailored starter prompt chips
 * for Netcatty's native Catty Agent sidebar (`context.ai.setContext`).
 */
export function buildDatabaseAgentContext(opts: {
  session: ActiveSession | undefined;
  connectionsCount: number;
  activeSql: string;
  locale: string;
}): PluginAISetContextParams {
  const isZh = (opts.locale || 'en').toLowerCase().startsWith('zh');
  const { session, connectionsCount, activeSql } = opts;

  if (!session) {
    return {
      viewId: DATABASE_WORKBENCH_VIEW_ID,
      title: isZh ? '数据库工作台' : 'Database Workbench',
      subtitle: isZh ? `${connectionsCount} 个已保存连接 · 未连接` : `${connectionsCount} saved · Disconnected`,
      summary: `Active plugin page: Netcatty Database Workbench.\nNo database is currently connected (${connectionsCount} saved connection(s)). Use db_list_connections to inspect saved connections or guide the user to connect or launch Sample SQLite.`,
      suggestedPrompts: isZh
        ? [
            { label: '查看已保存连接', prompt: '列出所有已保存的数据库连接及其配置摘要' },
            { label: 'SSH 隧道指南', prompt: '如何通过 Netcatty Vault SSH 隧道连接远程 PostgreSQL 或 MySQL？' },
          ]
        : [
            { label: 'Saved Connections', prompt: 'List all my saved database connections and their status' },
            { label: 'SSH Tunnel Guide', prompt: 'How do I connect to a remote database via a Netcatty Vault SSH tunnel?' },
          ],
    };
  }

  const dialect = isRelationalDriver(session.driver)
    ? engineToSqlDialect(session.connection.engine)
    : session.family;
  const cache = session.objectsBySchema[schemaCacheKey(session.activeDatabase, session.activeSchema)];
  const tables = cache?.tables ?? [];
  const structures = cache?.structures ?? {};

  const isMongo = isMongoDriver(session.driver);
  const mongoCollections = isMongo ? (session.mongoCollectionsByDb[session.activeDatabase] ?? []) : [];

  const parts: string[] = [
    `Active Database Connection: ${session.connection.name} (id=${session.connectionId})`,
    `Engine: ${session.connection.engine} | Family: ${session.family} | Dialect: ${dialect} | Server: ${session.info.serverVersion}`,
    `Database: ${session.activeDatabase}${session.activeSchema ? ` | Schema: ${session.activeSchema}` : ''} | ReadOnly: ${Boolean(session.connection.readOnly)}`,
    isMongo
      ? 'Guidance (MongoDB Aggregation BI): Use db_list_tables to list collections, db_describe_table to inspect sampled collection field schemas & indexes, and pass JSON {"collection":"<name>","pipeline":[...]} in the `sql` parameter of db_run_readonly_sql / db_create_bi_chart / db_pin_chart_to_dashboard. Only read-only aggregation pipelines are allowed ($out and $merge are blocked).'
      : 'Guidance: Use db_list_tables / db_describe_table to inspect schema, db_run_readonly_sql for read-only exploration, db_create_bi_chart to render interactive inline BI charts (bar, horizontal-bar, stacked-bar, line, area, pie, donut, scatter, funnel, combo), db_pin_chart_to_dashboard to pin charts into the BI Dashboard, and db_open_sql_tab to draft any write/DDL SQL safely without executing it.',
  ];

  if (isMongo && mongoCollections.length > 0) {
    const colSummary = mongoCollections
      .slice(0, 60)
      .map((c) => `- ${c.name} (${c.type || 'collection'})`)
      .join('\n');
    parts.push(`Collections in database "${session.activeDatabase}":\n${colSummary}`);
  } else if (isRelationalDriver(session.driver) && tables.length > 0) {
    parts.push(
      buildBiSchemaContext({
        engine: session.connection.engine,
        dialect: engineToSqlDialect(session.connection.engine),
        database: session.activeDatabase,
        schema: session.activeSchema,
        tables,
        structures,
        question: activeSql || '',
        maxBytes: 7200,
      }),
    );
  }

  if (activeSql.trim()) {
    parts.push(`Current SQL Editor Draft:\n${activeSql.trim().slice(0, 1500)}`);
  }

  let summary = parts.join('\n\n');
  const encoder = new TextEncoder();
  while (encoder.encode(summary).length > 10_000) {
    summary = summary.slice(0, Math.floor(summary.length * 0.85));
  }

  const firstColName = mongoCollections[0]?.name;
  const starterBase = isMongo
    ? []
    : buildSchemaStarterQuestions(
        tables.map((t) => t.name),
        structures,
        opts.locale,
      );
  const suggestedPrompts: Array<{ label: string; prompt: string }> = isMongo
    ? [
        ...(firstColName
          ? [
              {
                label: isZh ? `${firstColName} 聚合图表` : `${firstColName} BI Chart`,
                prompt: isZh
                  ? `检查 ${firstColName} 集合字段结构，运行只读 MongoDB 聚合管道并生成交互式 BI 图表`
                  : `Inspect the ${firstColName} collection schema, run a read-only MongoDB aggregation pipeline, and render an interactive BI chart`,
              },
            ]
          : []),
        {
          label: isZh ? '集合结构总览' : 'Collections Overview',
          prompt: isZh
            ? '列出当前 MongoDB 数据库的所有集合并分析主要集合的字段结构与索引'
            : 'List all collections in this MongoDB database and summarize key field schemas and indexes',
        },
      ]
    : [
        ...(starterBase[0]
          ? [
              {
                label: isZh ? 'BI 图表分析' : 'BI Chart Analysis',
                prompt: isZh
                  ? `使用 BI 图表分析：${starterBase[0]}`
                  : `Run a query and render a BI chart: ${starterBase[0]}`,
              },
            ]
          : []),
        ...starterBase.slice(1, 3).map((q) => ({
          label: q.length > 26 ? `${q.slice(0, 24)}…` : q,
          prompt: q,
        })),
        {
          label: isZh ? '表结构与外键总览' : 'Schema Overview',
          prompt: isZh
            ? '总结当前数据库的核心表结构、字段类型和外键关系'
            : 'Summarize the key tables, columns, and foreign key relationships in this database',
        },
      ].slice(0, 4);

  return {
    viewId: DATABASE_WORKBENCH_VIEW_ID,
    title: session.connection.name.slice(0, 120),
    subtitle: `${session.connection.engine} · ${session.activeDatabase}${session.activeSchema && session.activeSchema !== session.activeDatabase ? `.${session.activeSchema}` : ''}`.slice(
      0,
      160,
    ),
    summary,
    suggestedPrompts,
  };
}

/**
 * Registers all 7 Database Agent tools with Netcatty's native Catty Agent sidebar.
 * Returns a Disposable (or no-op disposable if host does not support `ai.sidebar-tools`).
 */
export async function registerDatabaseAgentSidebar(
  context: PluginContext,
  bridge: DatabaseAgentHostBridge,
): Promise<Disposable> {
  if (
    !context.enabledFeatures.has(AI_SIDEBAR_TOOLS_FEATURE) ||
    typeof context.ai?.registerTools !== 'function'
  ) {
    return { dispose() {} };
  }

  return context.ai.registerTools(
    DATABASE_AGENT_TOOLS,
    async (toolName, args) => executeDatabaseAgentTool(toolName, args, bridge),
    { viewId: DATABASE_WORKBENCH_VIEW_ID },
  );
}
