/**
 * Pure BI Dashboard Canvas Tab (`BiAnalyticsTab.tsx`).
 * Lazy-loaded via React.lazy in `DatabaseWorkbench.tsx` to keep initial `browser.js` lean (< 190 KB).
 *
 * All AI NL-to-SQL analysis lives natively in Catty Agent Chat; this tab is a calm,
 * focused multi-chart BI Dashboard for charts pinned from Catty Agent or SQL Query `Chart` tabs:
 * - Clean borderless header: BI Dashboard title, card count, Refresh All, Export MD, Export JSON, Ask Catty Agent
 * - Active cross-filter bar (clicking any bar/slice/point filters sibling cards & underlying DataGrid)
 * - 2-column responsive pinned-card grid with KPI strip, `<PluginBiChart />` (10 chart types),
 *   visual encoding controls, per-card Refresh, inline SQL Inspector / Open in SQL Editor, and Remove
 * - Calm empty state routing users to Ask Catty Agent or New SQL Query
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import {
  PluginCodeEditor,
  PluginDataGrid,
  PluginSplitPane,
  type PluginDataGridColumn,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { MongoDriver, QueryResultSet, RelationalDriver } from '../../drivers/types';
import {
  appendMongoSafeLimit,
  applyCrossFilter,
  buildBiChartProps,
  exportBiDashboardJson,
  exportBiReportMarkdown,
  flattenMongoDocsToResultSet,
  formatMongoBiQuery,
  parseMongoBiQuery,
  recommendChartConfig,
  validateBiReadOnlySql,
  type BiAnalysisCard,
  type BiChartConfig,
  type BiCrossFilter,
  type BiDatumClickDetail,
  type BiExportPngDetail,
  type BiExportSvgDetail,
} from '../../bi/index';
import {
  engineToMonacoLanguage,
  engineToSqlDialect,
  isMongoDriver,
  isRelationalDriver,
} from '../sessionManager';
import type { ActiveSession, BiAnalyticsTabState } from '../types';
import { BiChartControlsBar, BiChartView } from './BiChartView';

export interface BiAnalyticsTabProps {
  tab: BiAnalyticsTabState;
  session: ActiveSession;
  context: PluginContext;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<BiAnalyticsTabState>) => void;
  onPersistCards: (connectionId: string, cards: BiAnalysisCard[]) => void;
  onOpenSqlInQuery: (sql: string, title?: string) => void;
  onOpenAiSidebar?: (prompt?: string) => void;
  onNewSqlQuery?: () => void;
  onSaveExportFile: (opts: {
    title: string;
    defaultName: string;
    extension: string;
    filterName: string;
    data: string;
    encoding?: 'utf8' | 'base64';
  }) => Promise<void>;
  onNotify: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

export function BiAnalyticsTab({
  tab,
  session,
  context,
  t,
  onUpdateTab,
  onPersistCards,
  onOpenSqlInQuery,
  onOpenAiSidebar,
  onNewSqlQuery,
  onSaveExportFile,
  onNotify,
  onShortcut,
}: BiAnalyticsTabProps) {
  const isMongoSession = isMongoDriver(session.driver);
  const dialect = engineToSqlDialect(session.connection.engine);
  const monacoLanguage = isMongoSession ? 'json' : engineToMonacoLanguage(session.connection.engine);

  const [sqlInspectorCardId, setSqlInspectorCardId] = useState<string | null>(null);
  const cardsRef = useRef(tab.cards);
  cardsRef.current = tab.cards;

  const activeCard = useMemo(
    () => tab.cards.find((c) => c.id === tab.activeCardId) ?? tab.cards[0] ?? null,
    [tab.cards, tab.activeCardId],
  );

  const commitCards = useCallback(
    (nextCards: BiAnalysisCard[], extra?: Partial<BiAnalyticsTabState>) => {
      cardsRef.current = nextCards;
      onUpdateTab({ cards: nextCards, ...extra });
      onPersistCards(session.connectionId, nextCards);
    },
    [onPersistCards, onUpdateTab, session.connectionId],
  );

  // Execute any single card's SQL or MongoDB aggregation pipeline with strict read-only validation
  const executeCardSql = useCallback(
    async (cardId: string, sqlOverride?: string) => {
      const isRel = isRelationalDriver(session.driver);
      const isMongo = isMongoDriver(session.driver);
      if (!isRel && !isMongo) return;
      const target = cardsRef.current.find((c) => c.id === cardId);
      if (!target) return;
      const queryToRun = sqlOverride ?? target.sql;

      let safeQueryText = queryToRun;
      let parsedMongo: ReturnType<typeof parseMongoBiQuery> | null = null;

      if (isMongo) {
        try {
          parsedMongo = parseMongoBiQuery(queryToRun);
          safeQueryText = formatMongoBiQuery(parsedMongo);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          onUpdateTab({
            cards: cardsRef.current.map((c) =>
              c.id === cardId ? { ...c, loading: false, error: msg } : c,
            ),
          });
          return;
        }
      } else {
        const check = validateBiReadOnlySql(queryToRun, dialect);
        if (!check.ok) {
          const next = cardsRef.current.map((c) =>
            c.id === cardId ? { ...c, loading: false, error: check.reason } : c,
          );
          onUpdateTab({ cards: next });
          return;
        }
        safeQueryText = check.safeSql;
      }

      onUpdateTab({
        cards: cardsRef.current.map((c) =>
          c.id === cardId ? { ...c, loading: true, error: undefined, sql: safeQueryText } : c,
        ),
      });

      try {
        let result: QueryResultSet | undefined;
        if (isMongo && parsedMongo) {
          const started = performance.now();
          const targetDb = parsedMongo.database || tab.database || session.activeDatabase;
          const docs = await (session.driver as MongoDriver).aggregate(
            targetDb,
            parsedMongo.collection,
            appendMongoSafeLimit(parsedMongo.pipeline, 500),
          );
          result = flattenMongoDocsToResultSet(
            docs,
            Math.round(performance.now() - started),
            safeQueryText,
          );
        } else {
          const multi = await (session.driver as RelationalDriver).query(safeQueryText, { maxRows: 500 });
          result = multi.results[0];
        }
        if (!result) {
          throw new Error(t('Query returned 0 rows'));
        }
        const cur = cardsRef.current.find((c) => c.id === cardId) ?? target;
        const chartConfig =
          cur.chartConfig.xField && result.columns.some((col) => col.name === cur.chartConfig.xField)
            ? cur.chartConfig
            : recommendChartConfig(result);
        const built = buildBiChartProps(result, chartConfig, {
          title: cur.title,
          subtitle: cur.description,
        });

        const next = cardsRef.current.map((c) =>
          c.id === cardId
            ? {
                ...c,
                sql: safeQueryText,
                chartConfig,
                result,
                kpis: built.kpis,
                insights: c.insights.length > 0 ? c.insights : built.insights,
                loading: false,
                error: undefined,
                updatedAt: Date.now(),
              }
            : c,
        );
        commitCards(next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onUpdateTab({
          cards: cardsRef.current.map((c) =>
            c.id === cardId ? { ...c, loading: false, error: msg } : c,
          ),
        });
      }
    },
    [commitCards, dialect, onUpdateTab, session.activeDatabase, session.driver, t, tab.database],
  );

  // Hydrate persisted pinned cards that don't yet have runtime `result` loaded
  const hydratedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isRelationalDriver(session.driver) && !isMongoDriver(session.driver)) return;
    const pending = tab.cards.filter((c) => !c.result && !c.loading && !c.error && !hydratedRef.current.has(c.id));
    if (pending.length === 0) return;
    for (const card of pending) {
      hydratedRef.current.add(card.id);
      void executeCardSql(card.id);
    }
  }, [tab.cards, session.driver, executeCardSql]);

  const updateCardConfig = useCallback(
    (cardId: string, patch: Partial<BiChartConfig>) => {
      const next = cardsRef.current.map((card) => {
        if (card.id !== cardId) return card;
        const chartConfig = { ...card.chartConfig, ...patch };
        if (!card.result) return { ...card, chartConfig, updatedAt: Date.now() };
        const built = buildBiChartProps(card.result, chartConfig, {
          title: card.title,
          subtitle: card.description,
        });
        return {
          ...card,
          chartConfig,
          kpis: built.kpis,
          updatedAt: Date.now(),
        };
      });
      commitCards(next, { crossFilter: null });
    },
    [commitCards],
  );

  const toggleSpanCard = useCallback(
    (cardId: string) => {
      const next = cardsRef.current.map((c) =>
        c.id === cardId ? { ...c, span: c.span === 2 ? (1 as const) : (2 as const) } : c,
      );
      commitCards(next);
    },
    [commitCards],
  );

  const deleteCard = useCallback(
    (cardId: string) => {
      const next = cardsRef.current.filter((c) => c.id !== cardId);
      const nextActive = tab.activeCardId === cardId ? (next[0]?.id ?? null) : tab.activeCardId;
      const nextFilter = tab.crossFilter?.sourceCardId === cardId ? null : tab.crossFilter;
      commitCards(next, { activeCardId: nextActive, crossFilter: nextFilter });
    },
    [commitCards, tab.activeCardId, tab.crossFilter],
  );

  const handleDatumClick = useCallback(
    (card: BiAnalysisCard, detail: BiDatumClickDetail) => {
      const col = card.chartConfig.xField;
      if (!col || !detail.category) return;
      const isSame =
        tab.crossFilter &&
        tab.crossFilter.sourceCardId === card.id &&
        tab.crossFilter.column === col &&
        tab.crossFilter.value === detail.category;

      const nextFilter: BiCrossFilter | null = isSame
        ? null
        : {
            sourceCardId: card.id,
            column: col,
            value: detail.category,
            seriesIndex: detail.seriesIndex,
            datumIndex: detail.datumIndex,
          };
      onUpdateTab({ activeCardId: card.id, crossFilter: nextFilter });
    },
    [onUpdateTab, tab.crossFilter],
  );

  const handleChartExportSvg = useCallback(
    async (detail: BiExportSvgDetail) => {
      if (detail.downloadedByHost) {
        onNotify('success', `${t('Exported')} ${detail.suggestedName}`);
        return;
      }
      if (!detail.svg) return;
      await onSaveExportFile({
        title: t('Export SVG'),
        defaultName: detail.suggestedName || 'chart.svg',
        extension: 'svg',
        filterName: 'SVG Image',
        data: detail.svg,
        encoding: 'utf8',
      });
    },
    [onNotify, onSaveExportFile, t],
  );

  const handleChartExportPng = useCallback(
    async (detail: BiExportPngDetail) => {
      if (detail.downloadedByHost) {
        onNotify('success', `${t('Exported')} ${detail.suggestedName}`);
        return;
      }
      if (!detail.dataUrl) return;
      const base64 = detail.dataUrl.replace(/^data:image\/png;base64,/, '');
      await onSaveExportFile({
        title: t('Export PNG'),
        defaultName: detail.suggestedName || 'chart.png',
        extension: 'png',
        filterName: 'PNG Image',
        data: base64,
        encoding: 'base64',
      });
    },
    [onNotify, onSaveExportFile, t],
  );

  const handleExportReport = useCallback(
    async (format: 'markdown' | 'json') => {
      if (tab.cards.length === 0) {
        onNotify('warning', t('No charts to export yet.'));
        return;
      }
      const slug = (session.connection.name || 'bi-dashboard').replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase();
      if (format === 'markdown') {
        const md = exportBiReportMarkdown({
          connectionName: session.connection.name,
          database: tab.database || session.activeDatabase,
          cards: tab.cards,
          locale: context.environment.locale,
        });
        await onSaveExportFile({
          title: t('Export BI Report (Markdown)'),
          defaultName: `${slug}_bi_report.md`,
          extension: 'md',
          filterName: 'Markdown Report',
          data: md,
          encoding: 'utf8',
        });
      } else {
        const json = exportBiDashboardJson({
          connectionName: session.connection.name,
          database: tab.database || session.activeDatabase,
          cards: tab.cards,
        });
        await onSaveExportFile({
          title: t('Export BI Dashboard (JSON)'),
          defaultName: `${slug}_bi_dashboard.json`,
          extension: 'json',
          filterName: 'JSON File',
          data: json,
          encoding: 'utf8',
        });
      }
    },
    [context.environment.locale, onNotify, onSaveExportFile, session.activeDatabase, session.connection.name, t, tab.cards, tab.database],
  );

  const handleRefreshAll = useCallback(() => {
    for (const c of cardsRef.current) {
      void executeCardSql(c.id);
    }
  }, [executeCardSql]);

  // Underlying Data Grid for active card (with live cross-filter applied whenever column matches)
  const filteredResult: QueryResultSet | null = useMemo(() => {
    if (!activeCard?.result) return null;
    const activeFilter =
      tab.crossFilter &&
      activeCard.result.columns.some((c) => c.name === tab.crossFilter?.column)
        ? tab.crossFilter
        : null;
    return applyCrossFilter(activeCard.result, activeFilter);
  }, [activeCard, tab.crossFilter]);

  const gridColumns: PluginDataGridColumn[] = useMemo(() => {
    if (!filteredResult) return [];
    return filteredResult.columns.map((c) => ({
      name: c.name,
      type: c.dataType,
      primaryKey: c.isPrimaryKey,
      nullable: c.nullable,
      sortable: true,
    }));
  }, [filteredResult]);

  const anyLoading = tab.cards.some((c) => c.loading);

  const renderCard = (card: BiAnalysisCard) => {
    const isSourceOfFilter = Boolean(tab.crossFilter && tab.crossFilter.sourceCardId === card.id);
    const siblingMatchesFilter = Boolean(
      tab.crossFilter &&
        !isSourceOfFilter &&
        card.result?.columns.some((col) => col.name === tab.crossFilter?.column),
    );
    const effectiveResult =
      card.result && siblingMatchesFilter && tab.crossFilter
        ? applyCrossFilter(card.result, tab.crossFilter)
        : card.result;

    const cardFilter = isSourceOfFilter && tab.crossFilter
      ? {
          seriesIndex: tab.crossFilter.seriesIndex,
          datumIndex: tab.crossFilter.datumIndex,
          category: tab.crossFilter.value,
        }
      : null;

    const built = effectiveResult
      ? buildBiChartProps(effectiveResult, card.chartConfig, {
          height: tab.cards.length === 1 || card.span === 2 ? 300 : 250,
          activeFilter: cardFilter,
          emptyText: t('Query returned 0 rows'),
        })
      : null;

    const inspectingSql = sqlInspectorCardId === card.id;
    const cardKpis = built?.kpis ?? card.kpis;

    return (
      <article
        key={card.id}
        className={`ndb-bi-card ${card.span === 2 || tab.cards.length === 1 ? 'is-span-2' : ''} ${
          activeCard?.id === card.id ? 'is-selected' : ''
        }`}
        onClick={() => {
          if (tab.activeCardId !== card.id) {
            onUpdateTab({ activeCardId: card.id });
          }
        }}
      >
        <header className="ndb-bi-card-head">
          <div className="ndb-bi-card-title-group">
            <h3 className="ndb-truncate">{card.title}</h3>
            {card.description && <p className="ndb-muted ndb-truncate">{card.description}</p>}
          </div>
          <div className="ndb-bi-card-actions">
            {siblingMatchesFilter && <span className="ndb-tag">{t('Filtered')}</span>}
            {tab.cards.length > 1 && (
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-mono"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSpanCard(card.id);
                }}
                title={t('Toggle card width')}
              >
                {card.span === 2 ? '2×' : '1×'}
              </button>
            )}
            <button
              type="button"
              className={`ndb-btn ndb-btn-xs ${inspectingSql ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
              onClick={(e) => {
                e.stopPropagation();
                setSqlInspectorCardId(inspectingSql ? null : card.id);
              }}
            >
              {isMongoSession ? t('Pipeline') : 'SQL'}
            </button>
            <button
              type="button"
              className="ndb-icon-btn"
              aria-label={t('Refresh')}
              title={t('Refresh')}
              disabled={card.loading}
              onClick={(e) => {
                e.stopPropagation();
                void executeCardSql(card.id);
              }}
            >
              <Icon name={card.loading ? 'loader' : 'refresh'} />
            </button>
            <button
              type="button"
              className="ndb-icon-btn"
              aria-label={t('Remove')}
              title={t('Unpin from Dashboard')}
              onClick={(e) => {
                e.stopPropagation();
                deleteCard(card.id);
              }}
            >
              <Icon name="x" />
            </button>
          </div>
        </header>

        {cardKpis.length > 0 && (
          <div className="ndb-bi-card-kpis" aria-label={t('Key Metrics')}>
            {cardKpis.slice(0, 4).map((kpi) => (
              <div key={kpi.id} className="ndb-bi-kpi-card">
                <span className="ndb-bi-kpi-label ndb-truncate">{kpi.label}</span>
                <strong className="ndb-bi-kpi-value ndb-mono">{kpi.formattedValue}</strong>
                {kpi.subtext && (
                  <span
                    className={`ndb-bi-kpi-sub ${
                      kpi.tone === 'positive'
                        ? 'is-positive'
                        : kpi.tone === 'negative'
                          ? 'is-negative'
                          : ''
                    }`}
                  >
                    {kpi.subtext}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {card.result && card.result.columns.length > 0 && (
          <BiChartControlsBar
            config={card.chartConfig}
            columns={card.result.columns}
            compact
            t={t}
            onChange={(patch) => updateCardConfig(card.id, patch)}
          />
        )}

        {inspectingSql && (
          <div className="ndb-bi-sql-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="ndb-bi-sql-editor-box">
              <PluginCodeEditor
                value={card.sql}
                language={monacoLanguage}
                height={110}
                lineNumbers="off"
                wordWrap="on"
                onChange={({ value }) => {
                  const next = cardsRef.current.map((c) => (c.id === card.id ? { ...c, sql: value } : c));
                  onUpdateTab({ cards: next });
                }}
                onExecute={({ value }) => void executeCardSql(card.id, value)}
                onShortcut={onShortcut}
              />
            </div>
            <div className="ndb-bi-sql-actions">
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-xs"
                disabled={card.loading}
                onClick={() => void executeCardSql(card.id)}
              >
                <Icon name="play" />
                {isMongoSession ? t('Re-run Pipeline') : t('Re-run SQL')}
              </button>
              {!isMongoSession && (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                  onClick={() => onOpenSqlInQuery(card.sql, card.title)}
                >
                  <Icon name="file-code" />
                  {t('Open in SQL Editor')}
                </button>
              )}
            </div>
          </div>
        )}

        {card.error ? (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{card.error}</span>
          </div>
        ) : card.loading ? (
          <div className="ndb-bi-chart-loading">
            <Icon name="loader" />
            <span>{t('Executing query...')}</span>
          </div>
        ) : built ? (
          <div className="ndb-bi-chart-surface">
            <BiChartView
              {...built.props}
              ariaLabel={card.title}
              onDatumClick={(detail) => handleDatumClick(card, detail)}
              onExportSvg={(detail) => void handleChartExportSvg(detail)}
              onExportPng={(detail) => void handleChartExportPng(detail)}
              onShortcut={onShortcut}
            />
          </div>
        ) : (
          <div className="ndb-bi-chart-loading">
            <span className="ndb-muted">{t('No results')}</span>
          </div>
        )}

        {card.insights.length > 0 && (
          <div className="ndb-bi-insights">
            <div className="ndb-bi-section-label">{t('Executive Insights')}</div>
            <ul className="ndb-bi-insight-list">
              {card.insights.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="ndb-tab-pane ndb-bi-studio">
      {/* Minimal Borderless BI Dashboard Header */}
      <header className="ndb-bi-header">
        <div className="ndb-bi-dash-head">
          <div className="ndb-toolbar-group ndb-toolbar-nowrap">
            <Icon name="bar-chart-2" />
            <h2 className="ndb-bi-dash-title">{t('BI Dashboard')}</h2>
            <span className="ndb-count-pill ndb-mono">{tab.cards.length}</span>
            {tab.crossFilter && (
              <button
                type="button"
                className="ndb-bi-filter-chip"
                onClick={() => onUpdateTab({ crossFilter: null })}
                title={t('Click to clear cross-filter')}
              >
                <span className="ndb-mono">{`${t('Filtered')}: ${tab.crossFilter.column} = "${tab.crossFilter.value}"`}</span>
                <Icon name="x" />
              </button>
            )}
          </div>

          <div className="ndb-spacer" />

          <div className="ndb-toolbar-group ndb-toolbar-nowrap">
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              disabled={tab.cards.length === 0 || anyLoading}
              onClick={handleRefreshAll}
            >
              <Icon name={anyLoading ? 'loader' : 'refresh'} />
              {t('Refresh All')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              disabled={tab.cards.length === 0}
              onClick={() => void handleExportReport('markdown')}
            >
              {t('Export MD')}
            </button>
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              disabled={tab.cards.length === 0}
              onClick={() => void handleExportReport('json')}
            >
              {t('Export JSON')}
            </button>
            {onOpenAiSidebar && (
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                onClick={() => onOpenAiSidebar()}
              >
                <Icon name="sparkles" />
                {t('Ask Catty Agent')}
              </button>
            )}
          </div>
        </div>

        {tab.pipelineError && (
          <div className="ndb-banner ndb-banner-error" role="alert">
            <Icon name="alert-circle" />
            <span>{tab.pipelineError}</span>
          </div>
        )}
      </header>

      {/* Empty State OR 2-Column Pinned Dashboard + Cross-Filtered DataGrid */}
      {tab.cards.length === 0 ? (
        <div className="ndb-bi-canvas">
          <div className="ndb-bi-empty">
            <h3>{t('BI Dashboard')}</h3>
            <p className="ndb-muted">
              {t('Pin any chart from Catty Agent Chat or the SQL Query Chart tab to build a live, cross-filterable dashboard.')}
            </p>
            <div className="ndb-bi-empty-actions">
              {onOpenAiSidebar && (
                <button
                  type="button"
                  className="ndb-btn ndb-btn-primary ndb-btn-sm"
                  onClick={() => onOpenAiSidebar()}
                >
                  <Icon name="sparkles" />
                  {t('Ask Catty Agent')}
                </button>
              )}
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                onClick={() => (onNewSqlQuery ? onNewSqlQuery() : onOpenSqlInQuery(''))}
              >
                <Icon name="file-code" />
                {t('New SQL Query')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="ndb-split-host">
          <PluginSplitPane direction="vertical" initialSize={440} minSize={200} maxSize={780}>
            <div className="ndb-bi-top-pane">
              <div className="ndb-bi-canvas">
                <div className="ndb-bi-grid">
                  {tab.cards.map((card) => renderCard(card))}
                </div>
              </div>
            </div>

            {/* Bottom Pane: Selected Card Underlying Data + Live Cross-Filter Chip */}
            <div className="ndb-results-pane">
              <div className="ndb-subtab-bar">
                <span className="ndb-subtab is-active">
                  <Icon name="table" />
                  <span>{activeCard ? `${t('Data')}: ${activeCard.title}` : t('Underlying Data')}</span>
                  {filteredResult && (
                    <span className="ndb-count-pill ndb-mono">
                      {tab.crossFilter && activeCard?.result
                        ? `${filteredResult.rowCount}/${activeCard.result.rowCount}`
                        : filteredResult.rowCount}
                    </span>
                  )}
                </span>

                {tab.crossFilter && (
                  <button
                    type="button"
                    className="ndb-bi-filter-chip"
                    onClick={() => onUpdateTab({ crossFilter: null })}
                    title={t('Click to clear cross-filter')}
                  >
                    <span className="ndb-mono">{`${t('Filtered')}: ${tab.crossFilter.column} = "${tab.crossFilter.value}"`}</span>
                    <Icon name="x" />
                  </button>
                )}

                <div className="ndb-spacer" />

                {activeCard && !isMongoSession && (
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                    onClick={() => onOpenSqlInQuery(activeCard.sql, activeCard.title)}
                  >
                    <Icon name="file-code" />
                    {t('Open in SQL Editor')}
                  </button>
                )}
              </div>

              <div className="ndb-results-body">
                {filteredResult && filteredResult.columns.length > 0 ? (
                  <PluginDataGrid
                    columns={gridColumns}
                    rows={filteredResult.rows}
                    editable={false}
                    loading={Boolean(activeCard?.loading)}
                    emptyMessage={t('No matching rows')}
                    onShortcut={onShortcut}
                  />
                ) : (
                  <div className="ndb-empty-center">
                    <span className="ndb-muted">
                      {t('Click any bar, slice, or point in a chart to cross-filter the underlying rows.')}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </PluginSplitPane>
        </div>
      )}
    </div>
  );
}
