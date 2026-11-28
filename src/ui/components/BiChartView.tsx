/**
 * Host-rendered `bi-chart` widget bridge + compact BI chart configuration bar.
 * Shared by `BiAnalyticsTab` and `SqlQueryTab` (both lazy-loaded chunks).
 */

import React from 'react';
import {
  PluginBiChart,
  type PluginBiChartProps,
} from '@netcatty/plugin-sdk/host-react';
import type { ColumnMeta } from '../../drivers/types';
import {
  BI_AGGREGATIONS,
  BI_CHART_TYPES,
  BI_VALUE_FORMATS,
  type BiAggregation,
  type BiChartConfig,
  type BiChartType,
  type BiChartValueFormat,
  type BiSortOrder,
  type BiTopN,
} from '../../bi/types';

export type BiChartViewProps = PluginBiChartProps;

/** Renders the official host-owned `PluginBiChart` (`bi-chart`) widget from `@netcatty/plugin-sdk/host-react`. */
export function BiChartView(props: BiChartViewProps) {
  return <PluginBiChart {...props} />;
}

const CHART_TYPE_LABELS: Record<BiChartType, string> = {
  bar: 'Bar',
  'horizontal-bar': 'H-Bar',
  'stacked-bar': 'Stacked',
  line: 'Line',
  area: 'Area',
  pie: 'Pie',
  donut: 'Donut',
  scatter: 'Scatter',
  funnel: 'Funnel',
  combo: 'Combo',
};

export interface BiChartControlsBarProps {
  config: BiChartConfig;
  columns: ColumnMeta[];
  compact?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onChange: (patch: Partial<BiChartConfig>) => void;
}

export function BiChartControlsBar({
  config,
  columns,
  compact = false,
  t,
  onChange,
}: BiChartControlsBarProps) {
  const primaryY = config.yFields[0] ?? '';
  const secondaryY = config.yFields[1] ?? '';

  return (
    <div className={`ndb-bi-controls ${compact ? 'is-compact' : ''}`}>
      <label className="ndb-bi-ctrl">
        <span>{t('Chart')}</span>
        <select
          aria-label={t('Chart Type')}
          value={config.type}
          onChange={(e) => onChange({ type: e.currentTarget.value as BiChartType })}
        >
          {BI_CHART_TYPES.map((ct) => (
            <option key={ct} value={ct}>
              {t(CHART_TYPE_LABELS[ct])}
            </option>
          ))}
        </select>
      </label>

      <label className="ndb-bi-ctrl">
        <span>{t('X / Dim')}</span>
        <select
          aria-label={t('X Dimension')}
          value={config.xField}
          onChange={(e) => onChange({ xField: e.currentTarget.value })}
        >
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="ndb-bi-ctrl">
        <span>{t('Y / Metric')}</span>
        <select
          aria-label={t('Y Metric')}
          value={primaryY}
          onChange={(e) => {
            const val = e.currentTarget.value;
            if (!val) {
              onChange({ yFields: [], aggregation: 'count' });
            } else {
              const rest = config.yFields.slice(1).filter((f) => f !== val);
              onChange({ yFields: [val, ...rest] });
            }
          }}
        >
          <option value="">{t('(Row Count)')}</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {config.type === 'combo' && columns.length >= 2 && (
        <label className="ndb-bi-ctrl">
          <span>{t('Y2')}</span>
          <select
            aria-label={t('Secondary Metric')}
            value={secondaryY}
            onChange={(e) => {
              const val = e.currentTarget.value;
              const base = primaryY ? [primaryY] : [];
              onChange({ yFields: val ? [...base, val] : base });
            }}
          >
            <option value="">{t('None')}</option>
            {columns
              .filter((c) => c.name !== primaryY)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
      )}

      {config.type === 'stacked-bar' && columns.length >= 2 && (
        <label className="ndb-bi-ctrl">
          <span>{t('Group')}</span>
          <select
            aria-label={t('Group By')}
            value={config.groupByField ?? ''}
            onChange={(e) => onChange({ groupByField: e.currentTarget.value || undefined })}
          >
            <option value="">{t('None')}</option>
            {columns
              .filter((c) => c.name !== config.xField)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
      )}

      {config.type !== 'scatter' && (
        <label className="ndb-bi-ctrl">
          <span>{t('Agg')}</span>
          <select
            aria-label={t('Aggregation')}
            value={config.aggregation}
            onChange={(e) => onChange({ aggregation: e.currentTarget.value as BiAggregation })}
          >
            {BI_AGGREGATIONS.map((agg) => (
              <option key={agg} value={agg}>
                {agg.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      )}

      {!compact && config.type !== 'scatter' && (
        <>
          <label className="ndb-bi-ctrl">
            <span>{t('Sort')}</span>
            <select
              aria-label={t('Sort Order')}
              value={config.sort}
              onChange={(e) => onChange({ sort: e.currentTarget.value as BiSortOrder })}
            >
              <option value="value-desc">{t('Value ↓')}</option>
              <option value="value-asc">{t('Value ↑')}</option>
              <option value="label-asc">{t('Label A-Z')}</option>
              <option value="none">{t('Original')}</option>
            </select>
          </label>

          <label className="ndb-bi-ctrl">
            <span>{t('Top')}</span>
            <select
              aria-label={t('Top N')}
              value={String(config.topN)}
              onChange={(e) => onChange({ topN: Number(e.currentTarget.value) as BiTopN })}
            >
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="0">{t('All')}</option>
            </select>
          </label>

          <label className="ndb-bi-ctrl">
            <span>{t('Format')}</span>
            <select
              aria-label={t('Value Format')}
              value={config.valueFormat}
              onChange={(e) => onChange({ valueFormat: e.currentTarget.value as BiChartValueFormat })}
            >
              {BI_VALUE_FORMATS.map((fmt) => (
                <option key={fmt} value={fmt}>
                  {fmt}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
