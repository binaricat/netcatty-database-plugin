/**
 * Zero-AI Deterministic Column Profiler, Smart Chart Auto-Recommender,
 * Client-Side Aggregator, Cross-Filter Engine, and Quick Table Analysis Generator.
 * Runs 100% locally in the plugin sandbox with zero external dependencies.
 */

import type { CellValue, ColumnMeta, QueryResultSet, SqlDialect, TableStructure } from '../drivers/types';
import { qualifiedTableName, quoteIdent } from '../drivers/sqlDialect';
import type {
  BiAggregation,
  BiChartActiveFilter,
  BiChartConfig,
  BiChartSeries,
  BiChartType,
  BiChartValueFormat,
  BiChartWidgetProps,
  BiColumnProfile,
  BiColumnRole,
  BiCrossFilter,
  BiKpiItem,
  BiStarterQuery,
} from './types';

const TEMPORAL_TYPE_RE = /\b(?:date|time|timestamp|timestamptz|datetime|year|interval)\b/i;
const NUMERIC_TYPE_RE =
  /\b(?:int|integer|bigint|smallint|tinyint|mediumint|float|double|real|decimal|numeric|number|money|currency|serial|uint|int8|int16|int32|int64|float32|float64)\b/i;
const ISO_DATE_VALUE_RE =
  /^\d{4}[-/](?:0?[1-9]|1[0-2])(?:[-/](?:0?[1-9]|[12]\d|3[01]))?(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$|^\d{4}-Q[1-4]$/i;
const ID_NAME_RE = /^(?:id|uuid|guid|pk|row_?id)$|_(?:id|uuid|guid|key|pk)$/i;
const FUNNEL_NAME_RE = /(?:^|[^a-z])(?:stage|step|funnel|phase|pipeline|conversion)(?:$|[^a-z])/i;
const CURRENCY_NAME_RE = /(?:^|[^a-z])(?:price|amount|revenue|sales|cost|total|spent|budget|profit|margin|gmv|arr|mrr|salary|fee)(?:$|[^a-z])/i;
const PERCENT_NAME_RE = /(?:^|[^a-z])(?:rate|ratio|pct|percent|percentage|share|ctr|cvr)(?:$|[^a-z])/i;
const BYTES_NAME_RE = /(?:^|[^a-z])(?:bytes|size_bytes|memory|disk_bytes)(?:$|[^a-z])/i;
const MS_NAME_RE = /(?:^|[^a-z])(?:latency|duration|elapsed|ms)(?:$|[^a-z])/i;

const MAX_CHART_CATEGORIES = 500;
const MAX_SCATTER_POINTS = 1500;
const MAX_SERIES = 12;

export function toFiniteNumber(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Reject ISO dates/UUIDs/phone-like strings from accidentally parsing as numbers
    if (/^\d{4}[-/]\d{1,2}/.test(trimmed)) return null;
    const cleaned = trimmed.replace(/,/g, '');
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function formatCellCategory(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '(NULL)';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, 120);
    } catch {
      return '[Object]';
    }
  }
  const str = String(value).trim();
  return (str || '(Empty)').slice(0, 120);
}

export function formatBiValue(
  value: number | null,
  format: BiChartValueFormat = 'compact',
  currency = 'USD',
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (format) {
    case 'currency': {
      const symbol = currency === 'CNY' || currency === 'JPY' ? '¥' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
      const abs = Math.abs(value);
      const sign = value < 0 ? '-' : '';
      if (abs >= 1_000_000_000) return `${sign}${symbol}${(abs / 1_000_000_000).toFixed(2)}B`;
      if (abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(2)}M`;
      if (abs >= 10_000) return `${sign}${symbol}${(abs / 1_000).toFixed(1)}K`;
      return `${sign}${symbol}${abs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    }
    case 'percent': {
      const pct = Math.abs(value) <= 1 && value !== 0 ? value * 100 : value;
      return `${pct.toFixed(1)}%`;
    }
    case 'bytes': {
      const abs = Math.abs(value);
      const sign = value < 0 ? '-' : '';
      if (abs < 1024) return `${sign}${Math.round(abs)} B`;
      if (abs < 1024 ** 2) return `${sign}${(abs / 1024).toFixed(1)} KB`;
      if (abs < 1024 ** 3) return `${sign}${(abs / 1024 ** 2).toFixed(1)} MB`;
      return `${sign}${(abs / 1024 ** 3).toFixed(2)} GB`;
    }
    case 'ms': {
      if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} s`;
      return `${value.toFixed(value % 1 === 0 ? 0 : 1)} ms`;
    }
    case 'number':
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'compact':
    default: {
      const abs = Math.abs(value);
      const sign = value < 0 ? '-' : '';
      if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
      if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
      if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
  }
}

export function inferValueFormatFromColumn(colName: string): BiChartValueFormat {
  if (CURRENCY_NAME_RE.test(colName)) return 'currency';
  if (PERCENT_NAME_RE.test(colName)) return 'percent';
  if (BYTES_NAME_RE.test(colName)) return 'bytes';
  if (MS_NAME_RE.test(colName)) return 'ms';
  return 'compact';
}

/** Classifies every result column into temporal, numeric, id, or categorical. */
export function profileColumns(columns: ColumnMeta[], rows: CellValue[][]): BiColumnProfile[] {
  const sampleSize = Math.min(rows.length, 400);
  return columns.map((col, colIdx) => {
    const distinct = new Set<string>();
    let nullCount = 0;
    let numericHits = 0;
    let temporalHits = 0;
    let min: number | undefined;
    let max: number | undefined;
    let hasNegative = false;

    for (let r = 0; r < sampleSize; r++) {
      const val = rows[r]?.[colIdx];
      if (val === null || val === undefined || val === '') {
        nullCount++;
        continue;
      }
      distinct.add(formatCellCategory(val));
      const num = toFiniteNumber(val);
      if (num !== null) {
        numericHits++;
        if (min === undefined || num < min) min = num;
        if (max === undefined || num > max) max = num;
        if (num < 0) hasNegative = true;
      } else if (typeof val === 'string' && ISO_DATE_VALUE_RE.test(val.trim())) {
        temporalHits++;
      }
    }

    const nonNullCount = sampleSize - nullCount;
    const typeStr = col.dataType || '';
    const isTemporalByType = TEMPORAL_TYPE_RE.test(typeStr);
    const isNumericByType = NUMERIC_TYPE_RE.test(typeStr);
    const isTemporalByData = nonNullCount > 0 && temporalHits / nonNullCount >= 0.8;
    const isNumericByData = nonNullCount > 0 && numericHits / nonNullCount >= 0.85;

    let role: BiColumnRole = 'categorical';
    if (isTemporalByType || isTemporalByData) {
      role = 'temporal';
    } else if (
      (col.isPrimaryKey || ID_NAME_RE.test(col.name)) &&
      (nonNullCount === 0 || (sampleSize >= 4 && distinct.size / Math.max(1, nonNullCount) >= 0.95) || col.isPrimaryKey)
    ) {
      role = 'id';
    } else if (isNumericByType || isNumericByData) {
      role = 'numeric';
    } else if (nonNullCount >= 20 && distinct.size / nonNullCount > 0.97 && /^[0-9a-f-]{16,}$/i.test(Array.from(distinct)[0] ?? '')) {
      role = 'id';
    }

    return {
      name: col.name,
      dataType: typeStr,
      role,
      distinctCount: distinct.size,
      nullCount,
      nonNullCount,
      min,
      max,
      hasNegative,
    };
  });
}

function isMonotonicDescending(values: number[]): boolean {
  if (values.length < 2) return false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) return false;
  }
  return values[0] > values[values.length - 1];
}

/** Deterministic zero-AI chart recommender based on column profiles and distributions. */
export function recommendChartConfig(result: QueryResultSet): BiChartConfig {
  const profiles = profileColumns(result.columns, result.rows);
  const temporals = profiles.filter((p) => p.role === 'temporal');
  const numerics = profiles.filter((p) => p.role === 'numeric');
  const categoricals = profiles.filter((p) => p.role === 'categorical');
  const ids = profiles.filter((p) => p.role === 'id');

  const primaryMetric = numerics[0];
  const valueFormat = primaryMetric ? inferValueFormatFromColumn(primaryMetric.name) : 'compact';

  const base: BiChartConfig = {
    type: 'bar',
    xField: categoricals[0]?.name ?? temporals[0]?.name ?? ids[0]?.name ?? result.columns[0]?.name ?? '',
    yFields: primaryMetric ? [primaryMetric.name] : [],
    aggregation: primaryMetric ? 'sum' : 'count',
    sort: 'value-desc',
    topN: 20,
    valueFormat,
    currency: 'USD',
    palette: 'default',
    showDataLabels: false,
    smooth: false,
    showGrid: true,
    showLegend: true,
  };

  if (result.columns.length === 0) return base;

  // 1. Temporal + numeric -> area (1 metric) or line (2+ metrics)
  if (temporals.length >= 1 && numerics.length >= 1) {
    const yFields = numerics.slice(0, 4).map((n) => n.name);
    return {
      ...base,
      type: yFields.length === 1 ? 'area' : 'line',
      xField: temporals[0].name,
      yFields,
      sort: 'label-asc',
      topN: 0,
    };
  }

  // 2. Stage / funnel categorical + single numeric with monotonic values -> funnel
  if (categoricals.length >= 1 && numerics.length === 1) {
    const funnelCol = categoricals.find((c) => FUNNEL_NAME_RE.test(c.name) && c.distinctCount >= 2 && c.distinctCount <= 10);
    if (funnelCol) {
      const xIdx = result.columns.findIndex((c) => c.name === funnelCol.name);
      const yIdx = result.columns.findIndex((c) => c.name === numerics[0].name);
      if (xIdx >= 0 && yIdx >= 0 && result.rows.length <= 12) {
        const vals = result.rows.map((r) => toFiniteNumber(r[yIdx])).filter((v): v is number => v !== null && v >= 0);
        if (vals.length >= 2 && isMonotonicDescending(vals)) {
          return {
            ...base,
            type: 'funnel',
            xField: funnelCol.name,
            yFields: [numerics[0].name],
            sort: 'value-desc',
            topN: 10,
          };
        }
      }
    }
  }

  // 3. Two categoricals (second low cardinality 2..8) + numeric -> stacked-bar
  if (categoricals.length >= 2 && numerics.length >= 1) {
    const primaryCat = categoricals[0];
    const groupCat = categoricals.find((c, i) => i > 0 && c.distinctCount >= 2 && c.distinctCount <= 8);
    if (groupCat && primaryCat.distinctCount <= 24 && result.rows.length >= primaryCat.distinctCount + 1) {
      return {
        ...base,
        type: 'stacked-bar',
        xField: primaryCat.name,
        yFields: [numerics[0].name],
        groupByField: groupCat.name,
        sort: 'value-desc',
        topN: 20,
      };
    }
  }

  // 4. Categorical + 2 numeric with >5x scale disparity -> combo (bar left + line right)
  if (categoricals.length >= 1 && numerics.length >= 2) {
    const m1 = Math.max(Math.abs(numerics[0].max ?? 0), Math.abs(numerics[0].min ?? 0));
    const m2 = Math.max(Math.abs(numerics[1].max ?? 0), Math.abs(numerics[1].min ?? 0));
    if (m1 > 0 && m2 > 0 && Math.max(m1 / m2, m2 / m1) >= 5) {
      return {
        ...base,
        type: 'combo',
        xField: categoricals[0].name,
        yFields: [numerics[0].name, numerics[1].name],
        sort: 'value-desc',
        topN: 20,
      };
    }
    return {
      ...base,
      type: 'bar',
      xField: categoricals[0].name,
      yFields: numerics.slice(0, 3).map((n) => n.name),
      sort: 'value-desc',
      topN: 20,
    };
  }

  // 5. Categorical + single numeric
  if (categoricals.length >= 1 && numerics.length === 1) {
    const cat = categoricals[0];
    const num = numerics[0];
    if (cat.distinctCount >= 2 && cat.distinctCount <= 7 && !num.hasNegative) {
      return {
        ...base,
        type: 'donut',
        xField: cat.name,
        yFields: [num.name],
        sort: 'value-desc',
        topN: 10,
      };
    }
    if (cat.distinctCount >= 8 && cat.distinctCount <= 25) {
      return {
        ...base,
        type: 'horizontal-bar',
        xField: cat.name,
        yFields: [num.name],
        sort: 'value-desc',
        topN: 20,
      };
    }
    return {
      ...base,
      type: 'bar',
      xField: cat.name,
      yFields: [num.name],
      sort: 'value-desc',
      topN: 20,
    };
  }

  // 6. Two+ numerics with no categorical -> scatter
  if (numerics.length >= 2 && categoricals.length === 0) {
    return {
      ...base,
      type: 'scatter',
      xField: numerics[0].name,
      yFields: [numerics[1].name],
      sort: 'none',
      topN: 0,
    };
  }

  // 7. Only categorical (no numeric) -> count distribution bar or donut
  if (categoricals.length >= 1 && numerics.length === 0) {
    const cat = categoricals[0];
    return {
      ...base,
      type: cat.distinctCount >= 2 && cat.distinctCount <= 7 ? 'donut' : 'bar',
      xField: cat.name,
      yFields: [],
      aggregation: 'count',
      valueFormat: 'compact',
      sort: 'value-desc',
      topN: 20,
    };
  }

  // 8. Fallback (e.g., id + numeric)
  if (ids.length >= 1 && numerics.length >= 1) {
    return {
      ...base,
      type: 'bar',
      xField: ids[0].name,
      yFields: [numerics[0].name],
      sort: 'value-desc',
      topN: 20,
    };
  }

  return base;
}

function aggregateValues(values: number[], agg: BiAggregation): number | null {
  if (agg === 'count') return values.length;
  if (values.length === 0) return null;
  switch (agg) {
    case 'sum':
      return values.reduce((acc, v) => acc + v, 0);
    case 'avg':
      return values.reduce((acc, v) => acc + v, 0) / values.length;
    case 'min':
      return values.reduce((m, v) => (v < m ? v : m), values[0]);
    case 'max':
      return values.reduce((m, v) => (v > m ? v : m), values[0]);
  }
}

export interface BuiltBiChartBundle {
  props: BiChartWidgetProps;
  kpis: BiKpiItem[];
  insights: string[];
  effectiveXField: string;
  effectiveYFields: string[];
}

/**
 * Aggregates and transforms a raw QueryResultSet + BiChartConfig into strictly bounded
 * `PluginBiChartWidgetProps`, deterministic KPIs, and executive bullet insights.
 */
export function buildBiChartProps(
  result: QueryResultSet,
  config: BiChartConfig,
  opts?: {
    title?: string;
    subtitle?: string;
    height?: number;
    activeFilter?: BiChartActiveFilter | null;
    emptyText?: string;
  },
): BuiltBiChartBundle {
  const colIndex = new Map<string, number>();
  result.columns.forEach((c, idx) => colIndex.set(c.name, idx));

  const effectiveXField = colIndex.has(config.xField)
    ? config.xField
    : (result.columns[0]?.name ?? '');
  const validYFields = config.yFields.filter((f) => colIndex.has(f)).slice(0, MAX_SERIES);
  const effectiveYFields = validYFields;
  const xIdx = colIndex.get(effectiveXField) ?? -1;

  // Empty result guard
  if (result.rows.length === 0 || xIdx < 0) {
    return {
      props: {
        type: config.type,
        title: opts?.title,
        subtitle: opts?.subtitle,
        categories: [],
        series: [],
        palette: config.palette,
        valueFormat: config.valueFormat,
        currency: config.currency ?? 'USD',
        height: opts?.height ?? 280,
        showGrid: config.showGrid ?? true,
        showLegend: config.showLegend ?? true,
        showDataLabels: config.showDataLabels,
        smooth: config.smooth,
        exportable: true,
        activeFilter: opts?.activeFilter ?? null,
        emptyText: opts?.emptyText ?? 'No data available to chart',
      },
      kpis: [
        {
          id: 'rows',
          label: 'Rows',
          value: 0,
          formattedValue: '0',
          tone: 'neutral',
        },
      ],
      insights: [],
      effectiveXField,
      effectiveYFields,
    };
  }

  // Scatter path: xField numeric vs yFields[0] numeric
  if (config.type === 'scatter') {
    const yField = effectiveYFields[0] ?? result.columns[1]?.name ?? effectiveXField;
    const yIdx = colIndex.get(yField) ?? xIdx;
    const labelCol = result.columns.find((c) => c.name !== effectiveXField && c.name !== yField);
    const labelIdx = labelCol ? (colIndex.get(labelCol.name) ?? -1) : -1;

    const points: NonNullable<BiChartSeries['points']> = [];
    const xs: number[] = [];
    const ys: number[] = [];

    for (let i = 0; i < result.rows.length && points.length < MAX_SCATTER_POINTS; i++) {
      const row = result.rows[i];
      const xv = toFiniteNumber(row[xIdx]);
      const yv = toFiniteNumber(row[yIdx]);
      if (xv === null || yv === null) continue;
      xs.push(xv);
      ys.push(yv);
      points.push({
        x: xv,
        y: yv,
        label: labelIdx >= 0 ? formatCellCategory(row[labelIdx]).slice(0, 80) : `#${i + 1}`,
      });
    }

    const avgX = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const avgY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    const maxY = ys.length ? Math.max(...ys) : null;

    const kpis: BiKpiItem[] = [
      { id: 'points', label: 'Data Points', value: points.length, formattedValue: formatBiValue(points.length, 'number') },
      { id: 'avg-x', label: `Avg ${effectiveXField}`, value: avgX, formattedValue: formatBiValue(avgX, 'compact') },
      { id: 'avg-y', label: `Avg ${yField}`, value: avgY, formattedValue: formatBiValue(avgY, config.valueFormat, config.currency) },
      { id: 'max-y', label: `Max ${yField}`, value: maxY, formattedValue: formatBiValue(maxY, config.valueFormat, config.currency) },
    ];

    return {
      props: {
        type: 'scatter',
        title: opts?.title,
        subtitle: opts?.subtitle,
        series: [
          {
            id: `scatter-${yField}`,
            name: `${effectiveXField} vs ${yField}`.slice(0, 80),
            points,
            format: config.valueFormat,
            currency: config.currency ?? 'USD',
          },
        ],
        palette: config.palette,
        xAxisLabel: effectiveXField.slice(0, 80),
        yAxisLabel: yField.slice(0, 80),
        valueFormat: config.valueFormat,
        currency: config.currency ?? 'USD',
        height: opts?.height ?? 280,
        showGrid: config.showGrid ?? true,
        showLegend: false,
        showDataLabels: config.showDataLabels,
        exportable: true,
        activeFilter: opts?.activeFilter ?? null,
        emptyText: opts?.emptyText,
      },
      kpis,
      insights: computeScatterInsights(xs, ys, effectiveXField, yField),
      effectiveXField,
      effectiveYFields: [yField],
    };
  }

  // Stacked-bar pivoted by groupByField
  const groupIdx =
    config.groupByField && config.groupByField !== effectiveXField && colIndex.has(config.groupByField)
      ? (colIndex.get(config.groupByField) ?? -1)
      : -1;

  if (groupIdx >= 0 && (config.type === 'stacked-bar' || config.type === 'bar' || config.type === 'line' || config.type === 'area')) {
    const metricField = effectiveYFields[0];
    const metricIdx = metricField ? (colIndex.get(metricField) ?? -1) : -1;
    const useCount = metricIdx < 0 || config.aggregation === 'count';

    const catOrder: string[] = [];
    const groupTotals = new Map<string, number>();
    const buckets = new Map<string, Map<string, number[]>>();

    for (const row of result.rows) {
      const cat = formatCellCategory(row[xIdx]);
      const grp = formatCellCategory(row[groupIdx]).slice(0, 80);
      if (!buckets.has(cat)) {
        buckets.set(cat, new Map());
        catOrder.push(cat);
      }
      const grpMap = buckets.get(cat)!;
      if (!grpMap.has(grp)) grpMap.set(grp, []);
      if (useCount) {
        grpMap.get(grp)!.push(1);
        groupTotals.set(grp, (groupTotals.get(grp) ?? 0) + 1);
      } else {
        const num = toFiniteNumber(row[metricIdx]);
        if (num !== null) {
          grpMap.get(grp)!.push(num);
          groupTotals.set(grp, (groupTotals.get(grp) ?? 0) + Math.abs(num));
        }
      }
    }

    const topGroups = Array.from(groupTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SERIES)
      .map(([g]) => g);

    let entries = catOrder.map((cat) => {
      const grpMap = buckets.get(cat)!;
      const values = topGroups.map((grp) => aggregateValues(grpMap.get(grp) ?? [], useCount ? 'count' : config.aggregation));
      const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
      return { cat, values, total };
    });

    entries = sortAndLimitBuckets(entries, config.sort, config.topN, config.aggregation);
    const categories = entries.map((e) => e.cat);
    const series: BiChartSeries[] = topGroups.map((grp, gIdx) => ({
      id: `grp-${gIdx}`,
      name: grp,
      data: entries.map((e) => e.values[gIdx] ?? null),
      format: config.valueFormat,
      currency: config.currency ?? 'USD',
    }));

    const totals = entries.map((e) => e.total);
    const kpis = computeCategoryKpis(categories, totals, metricField || 'Count', result.rowCount, config.valueFormat, config.currency);
    const insights = computeCategoryInsights(categories, totals, effectiveXField, metricField || 'Count', config.valueFormat, config.currency, config.type);

    return {
      props: {
        type: config.type,
        title: opts?.title,
        subtitle: opts?.subtitle,
        categories,
        series,
        palette: config.palette,
        xAxisLabel: effectiveXField.slice(0, 80),
        yAxisLabel: (metricField || 'Count').slice(0, 80),
        valueFormat: config.valueFormat,
        currency: config.currency ?? 'USD',
        height: opts?.height ?? 280,
        showGrid: config.showGrid ?? true,
        showLegend: config.showLegend ?? true,
        showDataLabels: config.showDataLabels,
        smooth: config.smooth,
        exportable: true,
        activeFilter: opts?.activeFilter ?? null,
        emptyText: opts?.emptyText,
      },
      kpis,
      insights,
      effectiveXField,
      effectiveYFields,
    };
  }

  // Standard categorical / temporal / pie / donut / funnel / combo aggregation
  const isSingleSeriesType = config.type === 'pie' || config.type === 'donut' || config.type === 'funnel';
  const targetMetrics =
    effectiveYFields.length > 0
      ? (isSingleSeriesType ? effectiveYFields.slice(0, 1) : effectiveYFields)
      : ['__count__'];

  const catOrder: string[] = [];
  const buckets = new Map<string, number[][]>();

  for (const row of result.rows) {
    const cat = formatCellCategory(row[xIdx]);
    let metricLists = buckets.get(cat);
    if (!metricLists) {
      metricLists = targetMetrics.map(() => []);
      buckets.set(cat, metricLists);
      catOrder.push(cat);
    }
    targetMetrics.forEach((field, mIdx) => {
      if (field === '__count__') {
        metricLists![mIdx].push(1);
      } else {
        const idx = colIndex.get(field) ?? -1;
        const val = idx >= 0 ? toFiniteNumber(row[idx]) : null;
        if (val !== null) metricLists![mIdx].push(val);
      }
    });
  }

  let entries = catOrder.map((cat) => {
    const lists = buckets.get(cat)!;
    const values = targetMetrics.map((field, mIdx) =>
      aggregateValues(lists[mIdx], field === '__count__' ? 'count' : config.aggregation),
    );
    const total = values[0] ?? 0;
    return { cat, values, total };
  });

  entries = sortAndLimitBuckets(entries, config.sort, config.topN, config.aggregation);

  const categories = entries.map((e) => e.cat);
  const firstMax = Math.max(0, ...entries.map((e) => Math.abs(e.values[0] ?? 0)));
  const secondMax =
    targetMetrics.length >= 2 ? Math.max(0, ...entries.map((e) => Math.abs(e.values[1] ?? 0))) : 0;
  const dualAxisNeeded =
    config.type === 'combo' &&
    targetMetrics.length >= 2 &&
    firstMax > 0 &&
    secondMax > 0 &&
    Math.max(firstMax / secondMax, secondMax / firstMax) >= 4;

  const series: BiChartSeries[] = targetMetrics.map((field, mIdx) => {
    const name = field === '__count__' ? 'Row Count' : field;
    const seriesFormat = field === '__count__' ? 'compact' : (mIdx === 0 ? config.valueFormat : inferValueFormatFromColumn(field));
    const baseSeries: BiChartSeries = {
      id: `s-${mIdx}-${name.slice(0, 24)}`,
      name: name.slice(0, 80),
      data: entries.map((e) => e.values[mIdx] ?? null),
      format: seriesFormat,
      currency: config.currency ?? 'USD',
    };
    if (config.type === 'combo') {
      baseSeries.renderAs = mIdx === 0 ? 'bar' : 'line';
      baseSeries.yAxis = mIdx === 0 ? 'left' : (dualAxisNeeded ? 'right' : 'left');
    }
    return baseSeries;
  });

  const primarySeriesData = entries.map((e) => e.values[0] ?? 0);
  const primaryLabel = targetMetrics[0] === '__count__' ? 'Count' : targetMetrics[0];
  const kpis = computeCategoryKpis(
    categories,
    primarySeriesData,
    primaryLabel,
    result.rowCount,
    targetMetrics[0] === '__count__' ? 'compact' : config.valueFormat,
    config.currency,
  );
  const insights = computeCategoryInsights(
    categories,
    primarySeriesData,
    effectiveXField,
    primaryLabel,
    targetMetrics[0] === '__count__' ? 'compact' : config.valueFormat,
    config.currency,
    config.type,
  );

  return {
    props: {
      type: config.type,
      title: opts?.title,
      subtitle: opts?.subtitle,
      categories,
      series,
      palette: config.palette,
      xAxisLabel: effectiveXField.slice(0, 80),
      yAxisLabel: primaryLabel.slice(0, 80),
      yAxisRightLabel: dualAxisNeeded ? (targetMetrics[1] ?? '').slice(0, 80) : undefined,
      valueFormat: targetMetrics[0] === '__count__' ? 'compact' : config.valueFormat,
      currency: config.currency ?? 'USD',
      height: opts?.height ?? 280,
      showGrid: config.showGrid ?? true,
      showLegend: config.showLegend ?? (series.length > 1 || isSingleSeriesType),
      showDataLabels: config.showDataLabels,
      smooth: config.smooth,
      exportable: true,
      activeFilter: opts?.activeFilter ?? null,
      emptyText: opts?.emptyText,
    },
    kpis,
    insights,
    effectiveXField,
    effectiveYFields,
  };
}

function sortAndLimitBuckets(
  entries: Array<{ cat: string; values: Array<number | null>; total: number }>,
  sort: BiChartConfig['sort'],
  topN: BiChartConfig['topN'],
  aggregation: BiAggregation,
): Array<{ cat: string; values: Array<number | null>; total: number }> {
  let list = [...entries];
  if (sort === 'value-desc') {
    list.sort((a, b) => b.total - a.total);
  } else if (sort === 'value-asc') {
    list.sort((a, b) => a.total - b.total);
  } else if (sort === 'label-asc') {
    list.sort((a, b) => a.cat.localeCompare(b.cat, undefined, { numeric: true, sensitivity: 'base' }));
  }

  const limit = topN > 0 ? Math.min(topN, MAX_CHART_CATEGORIES) : MAX_CHART_CATEGORIES;
  if (list.length > limit) {
    const head = list.slice(0, limit - 1);
    const tail = list.slice(limit - 1);
    const seriesCount = head[0]?.values.length ?? 0;
    const otherValues: Array<number | null> = [];
    for (let s = 0; s < seriesCount; s++) {
      const tailNums = tail.map((e) => e.values[s]).filter((v): v is number => v !== null && Number.isFinite(v));
      if (tailNums.length === 0) {
        otherValues.push(null);
      } else if (aggregation === 'avg') {
        otherValues.push(tailNums.reduce((a, b) => a + b, 0) / tailNums.length);
      } else if (aggregation === 'min') {
        otherValues.push(Math.min(...tailNums));
      } else if (aggregation === 'max') {
        otherValues.push(Math.max(...tailNums));
      } else {
        otherValues.push(tailNums.reduce((a, b) => a + b, 0));
      }
    }
    const otherTotal = otherValues.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    list = [...head, { cat: `Other (${tail.length})`, values: otherValues, total: otherTotal }];
  }
  return list;
}

function computeCategoryKpis(
  categories: string[],
  values: number[],
  metricLabel: string,
  rowCount: number,
  format: BiChartValueFormat,
  currency?: string,
): BiKpiItem[] {
  const finite = values.filter((v) => Number.isFinite(v));
  const total = finite.reduce((acc, v) => acc + v, 0);
  const avg = finite.length > 0 ? total / finite.length : null;
  let peakIdx = -1;
  let peakVal = -Infinity;
  values.forEach((v, i) => {
    if (Number.isFinite(v) && v > peakVal) {
      peakVal = v;
      peakIdx = i;
    }
  });
  const peakShare = total > 0 && peakIdx >= 0 ? (peakVal / total) * 100 : null;

  return [
    {
      id: 'total',
      label: `Total ${metricLabel}`,
      value: total,
      formattedValue: formatBiValue(total, format, currency),
      subtext: `${categories.length} groups`,
      tone: 'neutral',
    },
    {
      id: 'avg',
      label: `Average ${metricLabel}`,
      value: avg,
      formattedValue: formatBiValue(avg, format, currency),
      subtext: 'per group',
      tone: 'neutral',
    },
    ...(peakIdx >= 0
      ? [
          {
            id: 'peak',
            label: `Top: ${categories[peakIdx].slice(0, 28)}`,
            value: peakVal,
            formattedValue: formatBiValue(peakVal, format, currency),
            subtext: peakShare !== null ? `${peakShare.toFixed(1)}% share` : undefined,
            tone: 'positive' as const,
          },
        ]
      : []),
    {
      id: 'rows',
      label: 'Source Rows',
      value: rowCount,
      formattedValue: formatBiValue(rowCount, 'number'),
      tone: 'neutral',
    },
  ];
}

function computeCategoryInsights(
  categories: string[],
  values: number[],
  xField: string,
  yField: string,
  format: BiChartValueFormat,
  currency: string | undefined,
  chartType: BiChartType,
): string[] {
  if (categories.length === 0 || values.length === 0) return [];
  const bullets: string[] = [];
  const total = values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  if ((chartType === 'line' || chartType === 'area') && values.length >= 2) {
    const first = values[0];
    const last = values[values.length - 1];
    if (Number.isFinite(first) && Number.isFinite(last) && first !== 0) {
      const pct = ((last - first) / Math.abs(first)) * 100;
      const dir = pct >= 0 ? 'up' : 'down';
      bullets.push(
        `${yField} moved ${dir} ${Math.abs(pct).toFixed(1)}% from ${categories[0]} (${formatBiValue(first, format, currency)}) to ${categories[categories.length - 1]} (${formatBiValue(last, format, currency)}).`,
      );
    }
  }

  const ranked = categories
    .map((cat, i) => ({ cat, val: values[i] ?? 0 }))
    .filter((x) => Number.isFinite(x.val))
    .sort((a, b) => b.val - a.val);

  if (ranked.length >= 1) {
    const top = ranked[0];
    const share = total > 0 ? ` (${((top.val / total) * 100).toFixed(1)}% of total)` : '';
    bullets.push(`${top.cat} leads ${xField} with ${formatBiValue(top.val, format, currency)}${share}.`);
  }

  if (ranked.length >= 3 && total > 0) {
    const top3Sum = ranked.slice(0, 3).reduce((acc, r) => acc + r.val, 0);
    const share3 = (top3Sum / total) * 100;
    bullets.push(`Top 3 ${xField} segments account for ${share3.toFixed(1)}% of ${yField}.`);
  } else if (ranked.length >= 2) {
    const low = ranked[ranked.length - 1];
    bullets.push(`Lowest observed segment is ${low.cat} at ${formatBiValue(low.val, format, currency)}.`);
  }

  return bullets.slice(0, 4);
}

function computeScatterInsights(xs: number[], ys: number[], xField: string, yField: string): string[] {
  if (xs.length < 3 || xs.length !== ys.length) return [];
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const denom = Math.sqrt(denX * denY);
  if (!Number.isFinite(denom) || denom === 0) return [];
  const r = num / denom;
  const strength = Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.35 ? 'moderate' : 'weak';
  const dir = r >= 0 ? 'positive' : 'negative';
  return [
    `Observed ${strength} ${dir} correlation (r = ${r.toFixed(2)}) between ${xField} and ${yField} across ${xs.length} points.`,
  ];
}

/** Applies interactive cross-filtering from a clicked chart datum onto a QueryResultSet. */
export function applyCrossFilter(result: QueryResultSet, filter: BiCrossFilter | null): QueryResultSet {
  if (!filter || !filter.column) return result;
  const colIdx = result.columns.findIndex((c) => c.name === filter.column);
  if (colIdx < 0) return result;
  // Clicking rolled-up "Other (N)" does not match a literal category value
  if (/^Other \(\d+\)$/.test(filter.value)) return result;

  const filteredRows = result.rows.filter((row) => formatCellCategory(row[colIdx]) === filter.value);
  return {
    ...result,
    rows: filteredRows,
    rowCount: filteredRows.length,
  };
}

/**
 * Generates 2-4 deterministic, safe, read-only SQL starter analyses for any relational table
 * ("X-Ray / Quick Analyze" mode with zero AI required).
 */
export function buildTableStarterQueries(
  tableName: string,
  structure: TableStructure | null,
  dialect: SqlDialect,
  schema?: string,
): BiStarterQuery[] {
  const tblRef = qualifiedTableName('', schema && schema !== 'main' ? schema : '', tableName, dialect);
  const cols = structure?.columns ?? [];
  const queries: BiStarterQuery[] = [];

  const qCol = (name: string) => quoteIdent(name, dialect);
  const temporalCols = cols.filter((c) => TEMPORAL_TYPE_RE.test(c.dataType) || /(?:created|updated|date|time|at)$/i.test(c.name));
  const numericCols = cols.filter(
    (c) => !c.isPrimaryKey && !ID_NAME_RE.test(c.name) && NUMERIC_TYPE_RE.test(c.dataType),
  );
  const catCols = cols.filter(
    (c) =>
      !c.isPrimaryKey &&
      !ID_NAME_RE.test(c.name) &&
      !TEMPORAL_TYPE_RE.test(c.dataType) &&
      !NUMERIC_TYPE_RE.test(c.dataType) &&
      !/^(?:email|password|hash|token|secret|notes|description|body|content)$/i.test(c.name),
  );

  // 1. Categorical + Numeric breakdown (or Categorical count)
  if (catCols.length > 0 && numericCols.length > 0) {
    const cat = catCols[0].name;
    const num = numericCols[0].name;
    queries.push({
      id: `xray-${tableName}-cat-num`,
      title: `${num} by ${cat}`,
      description: `Total ${num} and record count grouped by ${cat} in ${tableName}.`,
      sql: `SELECT ${qCol(cat)}, COUNT(*) AS record_count, ROUND(SUM(${qCol(num)}), 2) AS total_${num.replace(/[^a-zA-Z0-9_]/g, '_')} FROM ${tblRef} GROUP BY ${qCol(cat)} ORDER BY 3 DESC LIMIT 20`,
      preferredChartType: 'bar',
    });
  } else if (catCols.length > 0) {
    const cat = catCols[0].name;
    queries.push({
      id: `xray-${tableName}-cat-cnt`,
      title: `Distribution by ${cat}`,
      description: `Record distribution across ${cat} in ${tableName}.`,
      sql: `SELECT ${qCol(cat)}, COUNT(*) AS record_count FROM ${tblRef} GROUP BY ${qCol(cat)} ORDER BY record_count DESC LIMIT 20`,
      preferredChartType: 'donut',
    });
  }

  // 2. Time trend if temporal column exists
  if (temporalCols.length > 0) {
    const tCol = temporalCols[0].name;
    const dayExpr =
      dialect === 'sqlite'
        ? `substr(${qCol(tCol)}, 1, 10)`
        : dialect === 'mysql'
          ? `DATE(${qCol(tCol)})`
          : dialect === 'mssql'
            ? `CONVERT(varchar(10), ${qCol(tCol)}, 23)`
            : `CAST(${qCol(tCol)} AS DATE)`;
    if (numericCols.length > 0) {
      const num = numericCols[0].name;
      queries.push({
        id: `xray-${tableName}-trend`,
        title: `${num} Trend over Time`,
        description: `Daily ${num} trend by ${tCol}.`,
        sql: `SELECT ${dayExpr} AS period, COUNT(*) AS record_count, SUM(${qCol(num)}) AS total_${num.replace(/[^a-zA-Z0-9_]/g, '_')} FROM ${tblRef} WHERE ${qCol(tCol)} IS NOT NULL GROUP BY ${dayExpr} ORDER BY period ASC LIMIT 90`,
        preferredChartType: 'area',
      });
    } else {
      queries.push({
        id: `xray-${tableName}-trend-cnt`,
        title: `Activity Trend over Time`,
        description: `Daily record count by ${tCol}.`,
        sql: `SELECT ${dayExpr} AS period, COUNT(*) AS record_count FROM ${tblRef} WHERE ${qCol(tCol)} IS NOT NULL GROUP BY ${dayExpr} ORDER BY period ASC LIMIT 90`,
        preferredChartType: 'area',
      });
    }
  }

  // 3. Top records by primary numeric column
  if (numericCols.length > 0) {
    const labelCol = catCols[0]?.name ?? cols.find((c) => !NUMERIC_TYPE_RE.test(c.dataType))?.name ?? cols[0]?.name;
    const num = numericCols[0].name;
    if (labelCol && labelCol !== num) {
      queries.push({
        id: `xray-${tableName}-top`,
        title: `Top ${tableName} by ${num}`,
        description: `Highest ${num} entries in ${tableName}.`,
        sql: `SELECT ${qCol(labelCol)}, ${qCol(num)} FROM ${tblRef} WHERE ${qCol(num)} IS NOT NULL ORDER BY ${qCol(num)} DESC LIMIT 15`,
        preferredChartType: 'horizontal-bar',
      });
    }
  }

  // 4. Fallback overview query if table has unusual schema
  if (queries.length === 0) {
    queries.push({
      id: `xray-${tableName}-sample`,
      title: `${tableName} Overview`,
      description: `Top rows from ${tableName}.`,
      sql: `SELECT * FROM ${tblRef} LIMIT 100`,
      preferredChartType: 'bar',
    });
  }

  return queries.slice(0, 4);
}

/** Generates concise schema-derived starter analytical questions for the BI Ask Bar. */
export function buildSchemaStarterQuestions(
  tableNames: string[],
  structures: Record<string, TableStructure>,
  locale?: string,
): string[] {
  const isZh = (locale ?? 'en').toLowerCase().startsWith('zh');
  if (tableNames.length === 0) {
    return isZh
      ? ['统计各分类的记录数量分布', '查看最近趋势变化与关键指标']
      : ['Show record distribution by category', 'Analyze recent trends and key metrics'];
  }

  const questions: string[] = [];
  const lowerNames = tableNames.map((n) => n.toLowerCase());

  if (lowerNames.includes('orders') && lowerNames.includes('customers')) {
    questions.push(
      isZh ? '按客户和等级统计订单总金额与订单数' : 'Total revenue and order count by customer tier',
      isZh ? '各订单状态的金额分布占比' : 'Order revenue breakdown by status',
    );
  }
  if (lowerNames.includes('products')) {
    questions.push(
      isZh ? '商品价格与库存分布对比' : 'Compare product price vs stock across catalog',
    );
  }

  for (const tbl of tableNames.slice(0, 4)) {
    if (questions.length >= 4) break;
    const st = structures[tbl];
    const numCol = st?.columns.find((c) => !c.isPrimaryKey && !ID_NAME_RE.test(c.name) && NUMERIC_TYPE_RE.test(c.dataType));
    const catCol = st?.columns.find(
      (c) => !c.isPrimaryKey && !ID_NAME_RE.test(c.name) && !NUMERIC_TYPE_RE.test(c.dataType) && !TEMPORAL_TYPE_RE.test(c.dataType),
    );
    if (numCol && catCol) {
      questions.push(
        isZh
          ? `按 ${catCol.name} 汇总 ${tbl} 的 ${numCol.name}`
          : `Summarize ${numCol.name} in ${tbl} by ${catCol.name}`,
      );
    } else if (catCol) {
      questions.push(
        isZh ? `统计 ${tbl} 中 ${catCol.name} 的分布` : `Distribution of ${catCol.name} in ${tbl}`,
      );
    }
  }

  return Array.from(new Set(questions)).slice(0, 4);
}
