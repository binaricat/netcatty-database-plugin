/**
 * Flagship DBX Table Data Tab:
 * - WHERE filter bar, ORDER BY pill, Page Size (50/100/500), Pagination + Total Rows
 * - Virtualized editable `PluginDataGrid` with inline double-click edit, amber dirty cells,
 *   green inserted rows, red deleted strikethrough rows, sort click, and right-click context menu
 * - Floating Pending Changes Bar with Preview SQL (Monaco diff), Commit (atomic tx), and Discard
 * - Import (CSV/JSON/SQL/XLSX) & Export dropdown
 */

import React, { useId, useMemo, useState } from 'react';
import {
  PluginDataGrid,
  PluginPopover,
  type PluginDataGridColumn,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { CellValue } from '../../drivers/types';
import { coerceCellInput, formatCellForClipboard } from '../sessionManager';
import type { ActiveSession, ContextMenuItem, TableDataTabState } from '../types';
import type { ExportFormat } from './SqlQueryTab';

export interface TableDataTabProps {
  tab: TableDataTabState;
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<TableDataTabState>) => void;
  onReload: (opts?: { page?: number; pageSize?: number; whereClause?: string; sort?: TableDataTabState['sort'] }) => void;
  onOpenStructure: () => void;
  onOpenImport: () => void;
  onExportData: (format: ExportFormat) => void;
  onPreviewChanges: () => void;
  onCommitChanges: () => void;
  onDiscardChanges: () => void;
  onInspectCell: (rowIndex: number, colName: string, value: CellValue, rowObj: Record<string, CellValue>) => void;
  onCopyText: (text: string, label: string) => void;
  onCopyRowAsSql: (rowObj: Record<string, CellValue>) => void;
  onSaveSqliteFile?: () => void;
  onOpenContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
}

export function TableDataTab({
  tab,
  session,
  t,
  onUpdateTab,
  onReload,
  onOpenStructure,
  onOpenImport,
  onExportData,
  onPreviewChanges,
  onCommitChanges,
  onDiscardChanges,
  onInspectCell,
  onCopyText,
  onCopyRowAsSql,
  onSaveSqliteFile,
  onOpenContextMenu,
}: TableDataTabProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const exportAnchorId = useId().replace(/[^a-zA-Z0-9_-]/g, '_');

  const structColMap = useMemo(() => {
    const map = new Map<string, NonNullable<TableDataTabState['structure']>['columns'][number]>();
    for (const c of tab.structure?.columns ?? []) map.set(c.name, c);
    return map;
  }, [tab.structure]);

  const gridColumns: PluginDataGridColumn[] = useMemo(() => {
    const cols = tab.columns.length > 0
      ? tab.columns
      : (tab.structure?.columns ?? []).map((c) => ({
          name: c.name,
          dataType: c.dataType,
          nullable: c.nullable,
          isPrimaryKey: c.isPrimaryKey,
        }));
    return cols.map((c) => {
      const sc = structColMap.get(c.name);
      return {
        name: c.name,
        type: sc?.dataType || c.dataType,
        primaryKey: sc?.isPrimaryKey ?? c.isPrimaryKey,
        nullable: sc?.nullable ?? c.nullable,
        sortable: true,
      };
    });
  }, [tab.columns, tab.structure, structColMap]);

  const totalPages = Math.max(1, Math.ceil(tab.totalRows / Math.max(1, tab.pageSize)));
  const dirtyCount = Object.keys(tab.dirtyCells).length;
  const insertCount = tab.insertedRows.length;
  const deleteCount = tab.deletedRowIndices.length;
  const hasPending = dirtyCount > 0 || insertCount > 0 || deleteCount > 0;
  const isEditable = session.family !== 'clickhouse';

  const getRowObject = (rowIndex: number): Record<string, CellValue> => {
    const obj: Record<string, CellValue> = {};
    if (rowIndex < tab.rows.length) {
      const raw = tab.rows[rowIndex] ?? [];
      gridColumns.forEach((col, i) => {
        const key = `${rowIndex}:${col.name}`;
        obj[col.name] = Object.prototype.hasOwnProperty.call(tab.dirtyCells, key)
          ? tab.dirtyCells[key]
          : (raw[i] ?? null);
      });
    } else {
      const ins = tab.insertedRows[rowIndex - tab.rows.length] ?? {};
      for (const col of gridColumns) {
        const key = `${rowIndex}:${col.name}`;
        obj[col.name] = Object.prototype.hasOwnProperty.call(tab.dirtyCells, key)
          ? tab.dirtyCells[key]
          : (ins[col.name] ?? null);
      }
    }
    return obj;
  };

  const handleCellEdit = (rowIndex: number, colName: string, rawValue: unknown, isNull: boolean) => {
    const colStruct = structColMap.get(colName);
    const coerced = coerceCellInput(rawValue, isNull, colStruct);

    if (rowIndex >= tab.rows.length) {
      const insIdx = rowIndex - tab.rows.length;
      const nextInserted = tab.insertedRows.map((r, i) => (i === insIdx ? { ...r, [colName]: coerced } : r));
      onUpdateTab({ insertedRows: nextInserted, dirty: true });
      return;
    }

    const colIdx = gridColumns.findIndex((c) => c.name === colName);
    const origVal = colIdx >= 0 ? tab.rows[rowIndex]?.[colIdx] : undefined;
    const key = `${rowIndex}:${colName}`;
    const nextDirty = { ...tab.dirtyCells };
    if (origVal === coerced) {
      delete nextDirty[key];
    } else {
      nextDirty[key] = coerced;
    }
    onUpdateTab({ dirtyCells: nextDirty, dirty: Object.keys(nextDirty).length > 0 || tab.insertedRows.length > 0 || tab.deletedRowIndices.length > 0 });
  };

  const handleAddRow = () => {
    const blank: Record<string, CellValue> = {};
    for (const col of gridColumns) {
      blank[col.name] = null;
    }
    onUpdateTab({ insertedRows: [...tab.insertedRows, blank], dirty: true });
  };

  const handleDeleteSelected = () => {
    if (tab.selectedRowIndices.length === 0) return;
    const existingDeletes = new Set(tab.deletedRowIndices);
    const insertedToDrop = new Set<number>();
    for (const idx of tab.selectedRowIndices) {
      if (idx < tab.rows.length) {
        if (existingDeletes.has(idx)) existingDeletes.delete(idx);
        else existingDeletes.add(idx);
      } else {
        insertedToDrop.add(idx - tab.rows.length);
      }
    }
    const nextInserted = tab.insertedRows.filter((_, i) => !insertedToDrop.has(i));
    const nextDeleted = Array.from(existingDeletes).sort((a, b) => a - b);
    onUpdateTab({
      deletedRowIndices: nextDeleted,
      insertedRows: nextInserted,
      selectedRowIndices: [],
      dirty: Object.keys(tab.dirtyCells).length > 0 || nextInserted.length > 0 || nextDeleted.length > 0,
    });
  };

  const handleCellContextMenu = (detail: { rowIndex: number; colName: string; x: number; y: number }) => {
    const rowObj = getRowObject(detail.rowIndex);
    const cellVal = rowObj[detail.colName] ?? null;
    const isDeleted = tab.deletedRowIndices.includes(detail.rowIndex);

    const items: ContextMenuItem[] = [
      {
        id: 'inspect',
        label: t('Inspect / Edit Cell'),
        onSelect: () => onInspectCell(detail.rowIndex, detail.colName, cellVal, rowObj),
      },
      {
        id: 'copy-val',
        label: t('Copy Value'),
        onSelect: () => onCopyText(formatCellForClipboard(cellVal), detail.colName),
      },
      {
        id: 'copy-json',
        label: t('Copy Row as JSON'),
        onSelect: () => onCopyText(JSON.stringify(rowObj, null, 2), 'Row JSON'),
      },
      {
        id: 'copy-sql',
        label: t('Copy Row as SQL INSERT'),
        onSelect: () => onCopyRowAsSql(rowObj),
      },
      ...(isEditable
        ? [
            {
              id: 'set-null',
              label: t('Set NULL'),
              dividerBefore: true,
              disabled: isDeleted,
              onSelect: () => handleCellEdit(detail.rowIndex, detail.colName, null, true),
            },
            {
              id: 'dup-row',
              label: t('Duplicate Row'),
              onSelect: () => {
                const clone: Record<string, CellValue> = { ...rowObj };
                for (const c of tab.structure?.columns ?? []) {
                  if (c.isAutoIncrement) clone[c.name] = null;
                }
                onUpdateTab({ insertedRows: [...tab.insertedRows, clone], dirty: true });
              },
            },
            {
              id: 'del-row',
              label: isDeleted ? 'Undo Delete Row' : t('Delete Row'),
              danger: !isDeleted,
              dividerBefore: true,
              onSelect: () => {
                if (detail.rowIndex >= tab.rows.length) {
                  const insIdx = detail.rowIndex - tab.rows.length;
                  onUpdateTab({ insertedRows: tab.insertedRows.filter((_, i) => i !== insIdx) });
                } else {
                  const next = isDeleted
                    ? tab.deletedRowIndices.filter((i) => i !== detail.rowIndex)
                    : [...tab.deletedRowIndices, detail.rowIndex].sort((a, b) => a - b);
                  onUpdateTab({ deletedRowIndices: next, dirty: true });
                }
              },
            },
          ]
        : []),
    ];
    onOpenContextMenu(detail.x, detail.y, items);
  };

  return (
    <div className="dbx-tab-pane">
      {/* Top Bar: WHERE filter + Pagination + Actions */}
      <div className="dbx-toolbar dbx-toolbar-wrap">
        <form
          className="dbx-where-form"
          onSubmit={(e) => {
            e.preventDefault();
            onReload({ page: 1, whereClause: tab.whereClause });
          }}
        >
          <span className="dbx-where-prefix dbx-mono">WHERE</span>
          <input
            type="text"
            className="dbx-mono dbx-where-input"
            placeholder={t('Filter WHERE clause...')}
            value={tab.whereClause}
            onChange={(e) => onUpdateTab({ whereClause: e.currentTarget.value })}
          />
          <button type="submit" className="dbx-btn dbx-btn-secondary dbx-btn-sm" disabled={tab.loading}>
            {t('Apply')}
          </button>
          {tab.appliedWhere && (
            <button
              type="button"
              className="dbx-btn dbx-btn-ghost dbx-btn-sm"
              onClick={() => {
                onUpdateTab({ whereClause: '', appliedWhere: '' });
                onReload({ page: 1, whereClause: '' });
              }}
            >
              {t('Clear')}
            </button>
          )}
        </form>

        {tab.sort && (
          <button
            type="button"
            className="dbx-tag dbx-mono dbx-tag-clickable"
            title="Click to clear ORDER BY"
            onClick={() => onReload({ page: 1, sort: null })}
          >
            {`ORDER BY ${tab.sort.column} ${tab.sort.direction.toUpperCase()} ×`}
          </button>
        )}

        <div className="dbx-spacer" />

        <div className="dbx-toolbar-group">
          {isEditable && (
            <>
              <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={handleAddRow}>
                <Icon name="plus" />
                {t('Add Row')}
              </button>
              <button
                type="button"
                className="dbx-btn dbx-btn-ghost dbx-btn-sm"
                disabled={tab.selectedRowIndices.length === 0}
                onClick={handleDeleteSelected}
              >
                {t('Delete Selected')}
                {tab.selectedRowIndices.length > 0 ? ` (${tab.selectedRowIndices.length})` : ''}
              </button>
            </>
          )}

          <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={onOpenImport}>
            {t('Import')}
          </button>

          <button
            id={exportAnchorId}
            type="button"
            className="dbx-btn dbx-btn-ghost dbx-btn-sm"
            onClick={() => setExportOpen((v) => !v)}
          >
            {t('Export')}
            <Icon name="chevron-down" />
          </button>
          <PluginPopover anchor={exportAnchorId} open={exportOpen} width={210} onClose={() => setExportOpen(false)}>
            <div className="dbx-menu-list">
              {(
                [
                  ['csv', t('Export CSV')],
                  ['json', t('Export JSON')],
                  ['markdown', t('Export Markdown')],
                  ['sql', t('Export SQL INSERT')],
                  ['xlsx', t('Export XLSX')],
                  ['copy-csv', t('Copy CSV to Clipboard')],
                  ['copy-json', t('Copy JSON to Clipboard')],
                ] as Array<[ExportFormat, string]>
              ).map(([fmt, label]) => (
                <button
                  key={fmt}
                  type="button"
                  className="dbx-menu-item"
                  onClick={() => {
                    setExportOpen(false);
                    onExportData(fmt);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </PluginPopover>

          <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={onOpenStructure}>
            {t('Design Structure')}
          </button>

          {session.family === 'sqlite' && onSaveSqliteFile && (
            <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={onSaveSqliteFile}>
              {t('Save .sqlite')}
            </button>
          )}

          <button
            type="button"
            className="dbx-icon-btn"
            title={t('Refresh')}
            aria-label={t('Refresh')}
            disabled={tab.loading}
            onClick={() => onReload()}
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

      {/* Main Editable Virtualized DataGrid */}
      <div className="dbx-grid-host">
        <PluginDataGrid
          columns={gridColumns}
          rows={tab.rows}
          dirtyCells={tab.dirtyCells}
          deletedRowIndices={tab.deletedRowIndices}
          insertedRows={tab.insertedRows}
          selectedRowIndices={tab.selectedRowIndices}
          sort={tab.sort}
          editable={isEditable}
          loading={tab.loading}
          emptyMessage="Table has no matching rows"
          onCellEdit={({ rowIndex, colName, value, isNull }) =>
            handleCellEdit(rowIndex, colName, value, isNull)
          }
          onCellContextMenu={handleCellContextMenu}
          onSortChange={(nextSort) => onReload({ page: 1, sort: nextSort })}
          onRowSelect={({ selectedRowIndices }) => onUpdateTab({ selectedRowIndices })}
        />

        {/* Floating Pending Changes Bar */}
        {hasPending && (
          <div className="dbx-pending-bar" role="region" aria-label={t('Pending changes')}>
            <div className="dbx-pending-summary">
              <span className="dbx-pending-dot" />
              <strong>{t('Pending changes')}</strong>
              {insertCount > 0 && <span className="dbx-tag dbx-tag-ok dbx-mono">{`+${insertCount} insert`}</span>}
              {dirtyCount > 0 && <span className="dbx-tag dbx-tag-warn dbx-mono">{`~${dirtyCount} cell`}</span>}
              {deleteCount > 0 && <span className="dbx-tag dbx-tag-danger dbx-mono">{`-${deleteCount} delete`}</span>}
            </div>
            <div className="dbx-pending-actions">
              <button type="button" className="dbx-btn dbx-btn-secondary dbx-btn-sm" onClick={onPreviewChanges}>
                <Icon name="file-code" />
                {t('Preview SQL')}
              </button>
              <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={onDiscardChanges}>
                {t('Discard')}
              </button>
              <button type="button" className="dbx-btn dbx-btn-primary dbx-btn-sm" onClick={onCommitChanges}>
                <Icon name="check" />
                {t('Commit')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pagination & Metrics Footer */}
      <div className="dbx-result-strip dbx-mono">
        <div className="dbx-pager">
          <button
            type="button"
            className="dbx-btn dbx-btn-ghost dbx-btn-xs"
            disabled={tab.loading || tab.page <= 1}
            onClick={() => onReload({ page: tab.page - 1 })}
          >
            Prev
          </button>
          <span>{`Page ${tab.page} / ${totalPages}`}</span>
          <button
            type="button"
            className="dbx-btn dbx-btn-ghost dbx-btn-xs"
            disabled={tab.loading || tab.page >= totalPages}
            onClick={() => onReload({ page: tab.page + 1 })}
          >
            Next
          </button>
          <select
            aria-label="Page size"
            className="dbx-pagesize-select"
            value={tab.pageSize}
            onChange={(e) => onReload({ page: 1, pageSize: Number(e.currentTarget.value) })}
          >
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
            <option value={500}>500 / page</option>
          </select>
        </div>

        <span>{`${tab.totalEstimated ? '~' : ''}${tab.totalRows.toLocaleString()} total rows`}</span>
        <span>{`${tab.executionMs} ms`}</span>
        <span className="dbx-spacer" />
        <span className="dbx-muted dbx-truncate">Double-click cell to edit · Right-click for actions</span>
      </div>
    </div>
  );
}
