/**
 * Lazy-loaded BI Workbench action helpers (pinning SQL charts & table X-Ray).
 * Kept out of initial `DatabaseWorkbench.tsx` bundle so `browser.js` stays under 190 KB.
 */

import type { QueryResultSet, RelationalDriver, SqlDialect, TableStructure } from '../drivers/types';
import { buildBiChartProps, buildTableStarterQueries, recommendChartConfig } from './autoChart';
import { validateBiReadOnlySql } from './readOnlyGuard';
import type { BiAnalysisCard, BiChartConfig } from './types';

export function buildPinnedSqlCard(opts: {
  id: string;
  title: string;
  sql: string;
  result: QueryResultSet;
  chartConfig: BiChartConfig;
}): BiAnalysisCard {
  const built = buildBiChartProps(opts.result, opts.chartConfig, { title: opts.title });
  return {
    id: opts.id,
    title: opts.title,
    sql: opts.sql,
    chartConfig: opts.chartConfig,
    kpis: built.kpis,
    insights: built.insights,
    followUps: [],
    pinned: true,
    span: 1,
    updatedAt: Date.now(),
    result: opts.result,
  };
}

export async function runTableXrayCards(opts: {
  driver: RelationalDriver;
  dialect: SqlDialect;
  database: string;
  schema: string;
  table: string;
  cachedStructure?: TableStructure;
  makeId: () => string;
}): Promise<BiAnalysisCard[]> {
  const structure =
    opts.cachedStructure ??
    (await opts.driver.getTableStructure(opts.database, opts.schema, opts.table).catch(() => null));
  const starters = buildTableStarterQueries(opts.table, structure, opts.dialect, opts.schema);
  const created: BiAnalysisCard[] = [];

  for (const starter of starters) {
    const check = validateBiReadOnlySql(starter.sql, opts.dialect);
    if (!check.ok) continue;
    try {
      const multi = await opts.driver.query(check.safeSql, { maxRows: 500 });
      const res = multi.results[0];
      if (!res) continue;
      const autoCfg = recommendChartConfig(res);
      const chartConfig: BiChartConfig = starter.preferredChartType
        ? { ...autoCfg, type: starter.preferredChartType }
        : autoCfg;
      const built = buildBiChartProps(res, chartConfig, {
        title: starter.title,
        subtitle: starter.description,
      });
      created.push({
        id: opts.makeId(),
        title: starter.title,
        description: starter.description,
        sql: check.safeSql,
        chartConfig,
        kpis: built.kpis,
        insights: built.insights,
        followUps: [],
        pinned: true,
        span: starters.length === 1 ? 2 : 1,
        updatedAt: Date.now(),
        result: res,
      });
    } catch {
      // Skip starter query if engine syntax differs
    }
  }

  return created;
}
