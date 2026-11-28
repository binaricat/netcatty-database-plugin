/**
 * Core domain types for the Netcatty Database BI Analytics & Charting Studio.
 * Wire-aligned with `@netcatty/plugin-sdk/host-react` `PluginBiChart` (`bi-chart`) contract.
 */

import type { QueryResultSet } from '../drivers/types';

export type BiChartType =
  | 'bar'
  | 'horizontal-bar'
  | 'stacked-bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'funnel'
  | 'combo';

export type BiChartColor =
  | 'primary'
  | 'sky'
  | 'emerald'
  | 'amber'
  | 'violet'
  | 'rose'
  | 'cyan'
  | 'indigo'
  | 'teal'
  | 'orange'
  | 'slate'
  | 'muted';

export type BiChartPalette = 'default' | 'categorical' | 'cool' | 'warm' | 'monochrome';

export type BiChartValueFormat = 'number' | 'compact' | 'currency' | 'percent' | 'bytes' | 'ms';

export type BiAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

export type BiSortOrder = 'none' | 'value-desc' | 'value-asc' | 'label-asc';

export type BiTopN = 0 | 10 | 20 | 50;

export interface BiChartScatterPoint {
  x: number;
  y: number;
  label?: string;
  size?: number;
}

export interface BiChartSeries {
  id: string;
  name: string;
  data?: Array<number | null>;
  points?: BiChartScatterPoint[];
  renderAs?: 'bar' | 'line' | 'area';
  yAxis?: 'left' | 'right';
  color?: BiChartColor;
  format?: BiChartValueFormat;
  currency?: string;
}

export interface BiChartActiveFilter {
  seriesIndex?: number;
  datumIndex?: number;
  category?: string;
}

export interface BiChartWidgetProps {
  type: BiChartType;
  title?: string;
  subtitle?: string;
  categories?: string[];
  series: BiChartSeries[];
  palette?: BiChartPalette;
  xAxisLabel?: string;
  yAxisLabel?: string;
  yAxisRightLabel?: string;
  valueFormat?: BiChartValueFormat;
  currency?: string;
  height?: number;
  showGrid?: boolean;
  showLegend?: boolean;
  showDataLabels?: boolean;
  smooth?: boolean;
  donutInnerRatio?: number;
  exportable?: boolean;
  activeFilter?: BiChartActiveFilter | null;
  emptyText?: string;
  ariaLabel?: string;
}

export interface BiDatumClickDetail {
  seriesIndex: number;
  seriesName: string;
  datumIndex: number;
  category: string;
  value: number | null;
  x?: number;
  y?: number;
}

export interface BiExportSvgDetail {
  svg: string;
  suggestedName: string;
  downloadedByHost?: boolean;
}

export interface BiExportPngDetail {
  dataUrl?: string;
  suggestedName: string;
  downloadedByHost?: boolean;
}

export interface BiChartConfig {
  type: BiChartType;
  xField: string;
  yFields: string[];
  groupByField?: string;
  aggregation: BiAggregation;
  sort: BiSortOrder;
  topN: BiTopN;
  valueFormat: BiChartValueFormat;
  currency?: string;
  palette: BiChartPalette;
  showDataLabels: boolean;
  smooth: boolean;
  showGrid?: boolean;
  showLegend?: boolean;
}

export interface BiKpiItem {
  id: string;
  label: string;
  value: number | null;
  formattedValue: string;
  subtext?: string;
  tone?: 'neutral' | 'positive' | 'negative';
}

export interface BiAnalysisCard {
  id: string;
  title: string;
  description?: string;
  sql: string;
  chartConfig: BiChartConfig;
  kpis: BiKpiItem[];
  insights: string[];
  followUps: string[];
  pinned: boolean;
  span: 1 | 2;
  updatedAt: number;
  /** Ephemeral runtime fields — stripped before persisting to storage. */
  result?: QueryResultSet;
  error?: string;
  loading?: boolean;
  repaired?: boolean;
}

export type PersistedBiCard = Omit<BiAnalysisCard, 'result' | 'error' | 'loading' | 'repaired'>;

export interface BiCrossFilter {
  sourceCardId: string;
  column: string;
  value: string;
  seriesIndex?: number;
  datumIndex?: number;
}

export interface BiDashboardRecord {
  version: 1;
  connectionId: string;
  updatedAt: number;
  cards: PersistedBiCard[];
}

export type BiPipelineStage = 'idle' | 'generating' | 'running' | 'repairing' | 'rendering';

export type BiColumnRole = 'temporal' | 'numeric' | 'id' | 'categorical';

export interface BiColumnProfile {
  name: string;
  dataType: string;
  role: BiColumnRole;
  distinctCount: number;
  nullCount: number;
  nonNullCount: number;
  min?: number;
  max?: number;
  hasNegative?: boolean;
}

export interface BiStarterQuery {
  id: string;
  title: string;
  description: string;
  sql: string;
  preferredChartType?: BiChartType;
}

export const BI_CHART_TYPES: readonly BiChartType[] = [
  'bar',
  'horizontal-bar',
  'stacked-bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'funnel',
  'combo',
] as const;

export const BI_AGGREGATIONS: readonly BiAggregation[] = ['sum', 'avg', 'count', 'min', 'max'] as const;

export const BI_VALUE_FORMATS: readonly BiChartValueFormat[] = [
  'compact',
  'number',
  'currency',
  'percent',
  'bytes',
  'ms',
] as const;

export const BI_PALETTES: readonly BiChartPalette[] = [
  'default',
  'categorical',
  'cool',
  'warm',
  'monochrome',
] as const;
