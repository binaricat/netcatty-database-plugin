/**
 * Interactive ER Diagram Tab powered by host-rendered `PluginErCanvas`.
 */

import React, { useMemo } from 'react';
import {
  PluginErCanvas,
  type PluginErRelation,
  type PluginErTable,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { ErDiagramTabState } from '../types';

export interface ErDiagramTabProps {
  tab: ErDiagramTabState;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<ErDiagramTabState>) => void;
  onReload: () => void;
  onDumpSql: () => void;
  onOpenSchemaDiff: () => void;
  onOpenTableData: (table: string, schema?: string) => void;
  onOpenTableStructure: (table: string, schema?: string) => void;
}

export function ErDiagramTab({
  tab,
  t,
  onUpdateTab,
  onReload,
  onDumpSql,
  onOpenSchemaDiff,
  onOpenTableData,
  onOpenTableStructure,
}: ErDiagramTabProps) {
  const { erTables, erRelations } = useMemo(() => {
    if (!tab.graph) return { erTables: [] as PluginErTable[], erRelations: [] as PluginErRelation[] };
    const q = tab.filter.trim().toLowerCase();
    const fkColsByTable = new Map<string, Set<string>>();
    for (const edge of tab.graph.edges) {
      const set = fkColsByTable.get(edge.sourceTable) ?? new Set<string>();
      for (const col of edge.sourceColumns) set.add(col);
      fkColsByTable.set(edge.sourceTable, set);
    }

    const filteredTables = tab.graph.tables.filter((tbl) => !q || tbl.name.toLowerCase().includes(q));
    const visibleNames = new Set(filteredTables.map((tbl) => tbl.name));

    const tables: PluginErTable[] = filteredTables.map((tbl) => {
      const fkSet = fkColsByTable.get(tbl.name) ?? new Set<string>();
      return {
        name: tbl.name,
        schema: tbl.schema,
        columns: tbl.columns.map((c) => ({
          name: c.name,
          type: c.dataType,
          isPk: c.isPrimaryKey,
          isFk: fkSet.has(c.name),
          nullable: c.nullable,
        })),
      };
    });

    const relations: PluginErRelation[] = [];
    for (const edge of tab.graph.edges) {
      if (!visibleNames.has(edge.sourceTable) || !visibleNames.has(edge.targetTable)) continue;
      relations.push({
        fromTable: edge.sourceTable,
        fromColumn: edge.sourceColumns[0] ?? '',
        toTable: edge.targetTable,
        toColumn: edge.targetColumns[0] ?? '',
        name: edge.name,
      });
    }

    return { erTables: tables, erRelations: relations };
  }, [tab.graph, tab.filter]);

  return (
    <div className="dbx-tab-pane">
      <div className="dbx-toolbar">
        <div className="dbx-toolbar-group">
          <span className="dbx-context-chip dbx-mono">
            {`${tab.database}${tab.schema ? ` / ${tab.schema}` : ''}`}
          </span>
          <div className="dbx-compact-search">
            <Icon name="search" />
            <input
              type="text"
              placeholder={t('Filter tables...')}
              value={tab.filter}
              onChange={(e) => onUpdateTab({ filter: e.currentTarget.value })}
            />
          </div>
          {tab.selectedTable && (
            <div className="dbx-er-selection">
              <span className="dbx-tag dbx-mono">{tab.selectedTable}</span>
              <button
                type="button"
                className="dbx-btn dbx-btn-secondary dbx-btn-xs"
                onClick={() => onOpenTableData(tab.selectedTable!, tab.schema)}
              >
                {t('Open Data')}
              </button>
              <button
                type="button"
                className="dbx-btn dbx-btn-ghost dbx-btn-xs"
                onClick={() => onOpenTableStructure(tab.selectedTable!, tab.schema)}
              >
                {t('Design Structure')}
              </button>
            </div>
          )}
        </div>

        <div className="dbx-spacer" />

        <div className="dbx-toolbar-group">
          <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={onDumpSql}>
            <Icon name="file-code" />
            {t('Dump SQL')}
          </button>
          <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={onOpenSchemaDiff}>
            {t('Schema Diff')}
          </button>
          <button
            type="button"
            className="dbx-icon-btn"
            title={t('Refresh')}
            disabled={tab.loading}
            onClick={onReload}
          >
            <Icon name={tab.loading ? 'loader' : 'refresh'} />
          </button>
        </div>
      </div>

      {tab.error && (
        <div className="dbx-banner dbx-banner-error dbx-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      <div className="dbx-er-host">
        {tab.loading && !tab.graph ? (
          <div className="dbx-empty-center">
            <Icon name="loader" />
            <p>{t('Loading...')}</p>
          </div>
        ) : (
          <PluginErCanvas
            tables={erTables}
            relations={erRelations}
            onTableClick={({ table }) => onUpdateTab({ selectedTable: table })}
          />
        )}
      </div>

      <div className="dbx-result-strip dbx-mono">
        <span>{`${erTables.length} tables`}</span>
        <span>{`${erRelations.length} foreign keys`}</span>
        <span className="dbx-spacer" />
        <span className="dbx-muted">Drag cards to arrange · Scroll to zoom · Click a table to open data or structure</span>
      </div>
    </div>
  );
}
