/**
 * Flagship Database Table Data Tab (v0.3.0):
 * - WHERE filter bar + toggleable Visual Filter Builder (`buildWhereFromRules`)
 * - Column Visibility Picker (`hiddenColumns` via `PluginPopover`)
 * - Foreign Key inline jump (`foreignKey` + `onFkJump`)
 * - Virtualized editable `PluginDataGrid` with multi-step Undo/Redo (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`),
 *   inline double-click edit, amber dirty cells, green inserted rows, red deleted rows,
 *   Cmd+C cell copy feedback, sort click, and right-click context menu
 * - Read-Only Safe Mode enforcement
 * - Floating Pending Changes Bar with Undo/Redo, Preview SQL (Monaco diff), Commit (atomic tx), and Discard
 */

import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  PluginDataGrid,
  PluginPopover,
  type PluginDataGridColumn,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { CellValue } from '../../drivers/types';
import { buildWhereFromRules, exportSqlInList, type FilterOperator, type FilterRule } from '../../sql/index';
import { hasPendingGridEdits, pushGridUndo, redoGridEdit, undoGridEdit } from '../gridHistory';
import { coerceCellInput, engineToSqlDialect, formatCellForClipboard } from '../sessionManager';
import type { ActiveSession, ContextMenuItem, TableDataTabState } from '../types';
import type { ExportFormat } from './SqlQueryTab';

const FILTER_OPERATORS: FilterOperator[] = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'NOT LIKE',
  'ILIKE',
  'IN',
  'NOT IN',
  'IS NULL',
  'IS NOT NULL',
];

export interface TableDataTabProps {
  tab: TableDataTabState;
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<TableDataTabState>) => void;
  onReload: (opts?: { page?: number; pageSize?: number; whereClause?: string; sort?: TableDataTabState['sort'] }) => void;
  onOpenStructure: () => void;
  onAnalyzeInBi?: () => void;
  onOpenImport: () => void;
  onExportData: (format: ExportFormat) => void;
  onPreviewChanges: () => void;
  onCommitChanges: () => void;
  onDiscardChanges: () => void;
  onInspectCell: (rowIndex: number, colName: string, value: CellValue, rowObj: Record<string, CellValue>) => void;
  onCopyText: (text: string, label: string) => void;
  onCopyRowAsSql: (rowObj: Record<string, CellValue>) => void;
  onFkJump?: (detail: { table: string; column: string; schema?: string; value: unknown }) => void;
  onSaveSqliteFile?: () => void;
  onOpenContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

export function TableDataTab({
  tab,
  session,
  t,
  onUpdateTab,
  onReload,
  onOpenStructure,
  onAnalyzeInBi,
  onOpenImport,
  onExportData,
  onPreviewChanges,
  onCommitChanges,
  onDiscardChanges,
  onInspectCell,
  onCopyText,
  onCopyRowAsSql,
  onFkJump,
  onSaveSqliteFile,
  onOpenContextMenu,
  onShortcut,
}: TableDataTabProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [distinctOpen, setDistinctOpen] = useState(false);
  const [distinctCol, setDistinctCol] = useState('');
  const [autoRefreshSec, setAutoRefreshSec] = useState(0);
  const [bulkCol, setBulkCol] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkNull, setBulkNull] = useState(false);
  const exportAnchorId = useId().replace(/[^a-zA-Z0-9_-]/g, '_');
  const colsAnchorId = useId().replace(/[^a-zA-Z0-9_-]/g, '_');
  const distinctAnchorId = useId().replace(/[^a-zA-Z0-9_-]/g, '_');

  useEffect(() => {
    if (autoRefreshSec <= 0) return;
    const timer = setInterval(() => {
      onReload();
    }, autoRefreshSec * 1000);
    return () => clearInterval(timer);
  }, [autoRefreshSec, onReload]);

  const readOnly = Boolean(session.connection.readOnly);
  const isEditable = !readOnly && session.family !== 'clickhouse';
  const dialect = engineToSqlDialect(session.connection.engine);

  const distinctValues = useMemo(() => {
    const colName = distinctCol || tab.columns[0]?.name || '';
    const idx = tab.columns.findIndex((c) => c.name === colName);
    if (idx < 0) return [] as Array<{ value: CellValue; label: string; count: number }>;
    const counts = new Map<string, { value: CellValue; label: string; count: number }>();
    for (const row of tab.rows) {
      const val = row[idx];
      const label = val === null || val === undefined ? 'NULL' : String(val);
      const existing = counts.get(label);
      if (existing) existing.count++;
      else counts.set(label, { value: val, label, count: 1 });
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, 40);
  }, [distinctCol, tab.columns, tab.rows]);

  const handleApplyBulkEdit = () => {
    if (!isEditable || tab.selectedRowIndices.length === 0) return;
    const targetCol = bulkCol || tab.columns[0]?.name;
    if (!targetCol) return;
    const colStruct = tab.structure?.columns.find((c) => c.name === targetCol);
    const nextVal = coerceCellInput(bulkValue, bulkNull, colStruct);
    const nextDirty = { ...tab.dirtyCells };
    for (const rowIndex of tab.selectedRowIndices) {
      if (rowIndex >= 0 && rowIndex < tab.rows.length) {
        nextDirty[`${rowIndex}:${targetCol}`] = nextVal;
      }
    }
    const nextState = pushGridUndo(
      {
        dirtyCells: tab.dirtyCells,
        insertedRows: tab.insertedRows,
        deletedRowIndices: tab.deletedRowIndices,
      },
      {
        dirtyCells: nextDirty,
        insertedRows: tab.insertedRows,
        deletedRowIndices: tab.deletedRowIndices,
      },
      tab.undoStack ?? [],
    );
    onUpdateTab({
      ...nextState.current,
      undoStack: nextState.undoStack,
      redoStack: nextState.redoStack,
      dirty: nextState.dirty,
    });
  };

  const structColMap = useMemo(() => {
    const map = new Map<string, NonNullable<TableDataTabState['structure']>['columns'][number]>();
    for (const c of tab.structure?.columns ?? []) map.set(c.name, c);
    return map;
  }, [tab.structure]);

  const fkColMap = useMemo(() => {
    const map = new Map<string, { table: string; column: string; schema?: string }>();
    for (const fk of tab.structure?.foreignKeys ?? []) {
      fk.columns.forEach((col, i) => {
        const refCol = fk.referencedColumns[i] ?? fk.referencedColumns[0] ?? 'id';
        map.set(col, {
          table: fk.referencedTable,
          column: refCol,
          schema: fk.referencedSchema || undefined,
        });
      });
    }
    return map;
  }, [tab.structure]);

  const gridColumns: PluginDataGridColumn[] = useMemo(() => {
    const cols =
      tab.columns.length > 0
        ? tab.columns
        : (tab.structure?.columns ?? []).map((c) => ({
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
            isPrimaryKey: c.isPrimaryKey,
          }));
    return cols.map((c) => {
      const sc = structColMap.get(c.name);
      const fk = fkColMap.get(c.name);
      return {
        name: c.name,
        type: sc?.dataType || c.dataType,
        primaryKey: sc?.isPrimaryKey ?? c.isPrimaryKey,
        nullable: sc?.nullable ?? c.nullable,
        sortable: true,
        foreignKey: fk,
      };
    });
  }, [tab.columns, tab.structure, structColMap, fkColMap]);

  const totalPages = Math.max(1, Math.ceil(tab.totalRows / Math.max(1, tab.pageSize)));
  const dirtyCount = Object.keys(tab.dirtyCells).length;
  const insertCount = tab.insertedRows.length;
  const deleteCount = tab.deletedRowIndices.length;
  const hasPending = hasPendingGridEdits(tab);
  const canUndo = (tab.undoStack?.length ?? 0) > 0;
  const canRedo = (tab.redoStack?.length ?? 0) > 0;
  const hiddenSet = useMemo(() => new Set(tab.hiddenColumns ?? []), [tab.hiddenColumns]);

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

  const applyEditMutation = (next: {
    dirtyCells?: Record<string, CellValue>;
    insertedRows?: Record<string, CellValue>[];
    deletedRowIndices?: number[];
    selectedRowIndices?: number[];
  }) => {
    const currentSnap = {
      dirtyCells: tab.dirtyCells,
      insertedRows: tab.insertedRows,
      deletedRowIndices: tab.deletedRowIndices,
    };
    const nextSnap = {
      dirtyCells: next.dirtyCells ?? tab.dirtyCells,
      insertedRows: next.insertedRows ?? tab.insertedRows,
      deletedRowIndices: next.deletedRowIndices ?? tab.deletedRowIndices,
    };
    const res = pushGridUndo(currentSnap, nextSnap, tab.undoStack ?? []);
    onUpdateTab({
      ...res.current,
      undoStack: res.undoStack,
      redoStack: res.redoStack,
      dirty: res.dirty,
      ...(next.selectedRowIndices !== undefined ? { selectedRowIndices: next.selectedRowIndices } : {}),
    });
  };

  const handleUndo = () => {
    const res = undoGridEdit(
      { dirtyCells: tab.dirtyCells, insertedRows: tab.insertedRows, deletedRowIndices: tab.deletedRowIndices },
      tab.undoStack ?? [],
      tab.redoStack ?? [],
    );
    if (res) {
      onUpdateTab({ ...res.current, undoStack: res.undoStack, redoStack: res.redoStack, dirty: res.dirty });
    }
  };

  const handleRedo = () => {
    const res = redoGridEdit(
      { dirtyCells: tab.dirtyCells, insertedRows: tab.insertedRows, deletedRowIndices: tab.deletedRowIndices },
      tab.undoStack ?? [],
      tab.redoStack ?? [],
    );
    if (res) {
      onUpdateTab({ ...res.current, undoStack: res.undoStack, redoStack: res.redoStack, dirty: res.dirty });
    }
  };

  const handleGridShortcut = (detail: { shortcut: PluginWorkbenchShortcut }) => {
    if (detail.shortcut === 'mod+z' && canUndo) {
      handleUndo();
      return;
    }
    if (detail.shortcut === 'mod+shift+z' && canRedo) {
      handleRedo();
      return;
    }
    onShortcut?.(detail);
  };

  const handleCellEdit = (rowIndex: number, colName: string, rawValue: unknown, isNull: boolean) => {
    if (!isEditable) return;
    const colStruct = structColMap.get(colName);
    const coerced = coerceCellInput(rawValue, isNull, colStruct);

    if (rowIndex >= tab.rows.length) {
      const insIdx = rowIndex - tab.rows.length;
      const nextInserted = tab.insertedRows.map((r, i) => (i === insIdx ? { ...r, [colName]: coerced } : r));
      applyEditMutation({ insertedRows: nextInserted });
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
    applyEditMutation({ dirtyCells: nextDirty });
  };

  const handleAddRow = () => {
    if (!isEditable) return;
    const blank: Record<string, CellValue> = {};
    for (const col of gridColumns) {
      blank[col.name] = null;
    }
    applyEditMutation({ insertedRows: [...tab.insertedRows, blank] });
  };

  const handleDeleteSelected = () => {
    if (!isEditable || tab.selectedRowIndices.length === 0) return;
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
    applyEditMutation({
      deletedRowIndices: nextDeleted,
      insertedRows: nextInserted,
      selectedRowIndices: [],
    });
  };

  const handleCellContextMenu = (detail: { rowIndex: number; colName: string; x: number; y: number }) => {
    const rowObj = getRowObject(detail.rowIndex);
    const cellVal = rowObj[detail.colName] ?? null;
    const isDeleted = tab.deletedRowIndices.includes(detail.rowIndex);
    const fk = fkColMap.get(detail.colName);

    const items: ContextMenuItem[] = [
      {
        id: 'inspect',
        label: t('Inspect / Edit Cell'),
        onSelect: () => onInspectCell(detail.rowIndex, detail.colName, cellVal, rowObj),
      },
      ...(fk && cellVal !== null && onFkJump
        ? [
            {
              id: 'fk-jump',
              label: `${t('Jump to FK')} → ${fk.table}.${fk.column}`,
              onSelect: () => onFkJump({ table: fk.table, column: fk.column, schema: fk.schema, value: cellVal }),
            },
          ]
        : []),
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
                applyEditMutation({ insertedRows: [...tab.insertedRows, clone] });
              },
            },
            {
              id: 'del-row',
              label: isDeleted ? t('Undo') : t('Delete Row'),
              danger: !isDeleted,
              dividerBefore: true,
              onSelect: () => {
                if (detail.rowIndex >= tab.rows.length) {
                  const insIdx = detail.rowIndex - tab.rows.length;
                  applyEditMutation({ insertedRows: tab.insertedRows.filter((_, i) => i !== insIdx) });
                } else {
                  const next = isDeleted
                    ? tab.deletedRowIndices.filter((i) => i !== detail.rowIndex)
                    : [...tab.deletedRowIndices, detail.rowIndex].sort((a, b) => a - b);
                  applyEditMutation({ deletedRowIndices: next });
                }
              },
            },
          ]
        : []),
    ];
    onOpenContextMenu(detail.x, detail.y, items);
  };

  // Visual Filter Builder helpers
  const rules = tab.filterRules ?? [];
  const updateRule = (idx: number, patch: Partial<FilterRule>) => {
    const next = rules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onUpdateTab({ filterRules: next });
  };
  const addRule = () => {
    const defaultCol = gridColumns[0]?.name ?? '';
    const next: FilterRule[] = [
      ...rules,
      {
        id: `r-${Date.now()}-${rules.length}`,
        column: defaultCol,
        operator: '=',
        value: '',
        combinator: 'AND',
        enabled: true,
      },
    ];
    onUpdateTab({ filterRules: next, showFilterBuilder: true });
  };
  const applyFilterRules = () => {
    const compiled = buildWhereFromRules(rules, dialect);
    onUpdateTab({ whereClause: compiled });
    onReload({ page: 1, whereClause: compiled });
  };

  const toggleColumnHidden = (colName: string) => {
    const next = new Set(tab.hiddenColumns ?? []);
    if (next.has(colName)) next.delete(colName);
    else next.add(colName);
    onUpdateTab({ hiddenColumns: Array.from(next) });
  };

  return (
    <div className="ndb-tab-pane">
      {/* Top Bar: WHERE filter + Builder + Column Picker + Actions */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <form
          className="ndb-where-form"
          onSubmit={(e) => {
            e.preventDefault();
            onReload({ page: 1, whereClause: tab.whereClause });
          }}
        >
          <span className="ndb-where-prefix ndb-mono">WHERE</span>
          <input
            type="text"
            className="ndb-mono ndb-where-input"
            placeholder={t('Filter WHERE clause...')}
            value={tab.whereClause}
            onChange={(e) => onUpdateTab({ whereClause: e.currentTarget.value })}
          />
          <button type="submit" className="ndb-btn ndb-btn-secondary ndb-btn-sm" disabled={tab.loading}>
            {t('Apply')}
          </button>
          {tab.appliedWhere && (
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              onClick={() => {
                onUpdateTab({ whereClause: '', appliedWhere: '', filterRules: [] });
                onReload({ page: 1, whereClause: '' });
              }}
            >
              {t('Clear')}
            </button>
          )}
        </form>

        <button
          type="button"
          className={`ndb-btn ndb-btn-sm ${tab.showFilterBuilder ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
          onClick={() => {
            if (!tab.showFilterBuilder && rules.length === 0) {
              addRule();
            } else {
              onUpdateTab({ showFilterBuilder: !tab.showFilterBuilder });
            }
          }}
        >
          {t('Filter Builder')}
          {rules.length > 0 && <span className="ndb-count-pill ndb-mono">{rules.length}</span>}
        </button>

        {tab.sort && (
          <button
            type="button"
            className="ndb-tag ndb-mono ndb-tag-clickable"
            title="Click to clear ORDER BY"
            onClick={() => onReload({ page: 1, sort: null })}
          >
            {`ORDER BY ${tab.sort.column} ${tab.sort.direction.toUpperCase()} ×`}
          </button>
        )}

        <div className="ndb-spacer" />

        <div className="ndb-toolbar-group">
          {readOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}

          {isEditable && (
            <>
              <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={handleAddRow}>
                <Icon name="plus" />
                {t('Add Row')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                disabled={tab.selectedRowIndices.length === 0}
                onClick={handleDeleteSelected}
              >
                {t('Delete Selected')}
                {tab.selectedRowIndices.length > 0 ? ` (${tab.selectedRowIndices.length})` : ''}
              </button>
            </>
          )}

          {/* Column Visibility Picker */}
          <button
            id={colsAnchorId}
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-sm"
            onClick={() => setColsOpen((v) => !v)}
          >
            {t('Columns')}
            {hiddenSet.size > 0 && (
              <span className="ndb-count-pill ndb-mono">{`${gridColumns.length - hiddenSet.size}/${gridColumns.length}`}</span>
            )}
            <Icon name="chevron-down" />
          </button>
          <PluginPopover anchor={colsAnchorId} open={colsOpen} width={230} maxHeight={320} onClose={() => setColsOpen(false)}>
            <div className="ndb-col-picker">
              <div className="ndb-col-picker-head">
                <strong>{t('Visible Columns')}</strong>
                {hiddenSet.size > 0 && (
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                    onClick={() => onUpdateTab({ hiddenColumns: [] })}
                  >
                    {t('Show All')}
                  </button>
                )}
              </div>
              <div className="ndb-col-picker-list">
                {gridColumns.map((col) => (
                  <label key={col.name} className="ndb-checkbox-row ndb-col-picker-item">
                    <input
                      type="checkbox"
                      checked={!hiddenSet.has(col.name)}
                      onChange={() => toggleColumnHidden(col.name)}
                    />
                    <span className="ndb-mono ndb-truncate">{col.name}</span>
                    {col.primaryKey && <span className="ndb-badge-pk">PK</span>}
                  </label>
                ))}
              </div>
            </div>
          </PluginPopover>

          {!readOnly && (
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={onOpenImport}>
              {t('Import')}
            </button>
          )}

          {onAnalyzeInBi && (
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-sm"
              onClick={onAnalyzeInBi}
              title={t('Analyze in BI Dashboard')}
            >
              <Icon name="bar-chart-2" />
              {t('BI Analyze')}
            </button>
          )}

          <button
            id={exportAnchorId}
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-sm"
            onClick={() => setExportOpen((v) => !v)}
          >
            {t('Export')}
            <Icon name="chevron-down" />
          </button>
          <PluginPopover anchor={exportAnchorId} open={exportOpen} width={210} onClose={() => setExportOpen(false)}>
            <div className="ndb-menu-list">
              {(
                [
                  ['csv', t('Export CSV')],
                  ['tsv', t('Export TSV')],
                  ['json', t('Export JSON')],
                  ['markdown', t('Export Markdown')],
                  ['sql', t('Export SQL INSERT')],
                  ['xlsx', t('Export XLSX')],
                  ['copy-csv', t('Copy CSV to Clipboard')],
                  ['copy-tsv', t('Copy TSV (Spreadsheet)')],
                  ['copy-json', t('Copy JSON to Clipboard')],
                ] as Array<[ExportFormat, string]>
              ).map(([fmt, label]) => (
                <button
                  key={fmt}
                  type="button"
                  className="ndb-menu-item"
                  onClick={() => {
                    setExportOpen(false);
                    onExportData(fmt);
                  }}
                >
                  {label}
                </button>
              ))}
              {tab.columns.length > 0 && tab.rows.length > 0 && (
                <button
                  type="button"
                  className="ndb-menu-item"
                  onClick={() => {
                    setExportOpen(false);
                    const colIdx = Math.max(0, tab.columns.findIndex((c) => c.name === (distinctCol || tab.columns[0]?.name)));
                    const colName = tab.columns[colIdx]?.name;
                    const sourceRows =
                      tab.selectedRowIndices.length > 0
                        ? tab.selectedRowIndices.map((idx) => tab.rows[idx]).filter(Boolean)
                        : tab.rows;
                    const inSql = exportSqlInList(
                      sourceRows.map((r) => r[colIdx]),
                      dialect,
                      colName,
                    );
                    onCopyText(inSql, 'SQL IN (...)');
                  }}
                >
                  {t('Copy as SQL IN (...)')}
                </button>
              )}
            </div>
          </PluginPopover>

          {/* Column Distinct-Value Quick Filter Popover */}
          {tab.columns.length > 0 && (
            <>
              <button
                id={distinctAnchorId}
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                onClick={() => setDistinctOpen((v) => !v)}
                title={t('Distinct Values Filter')}
              >
                {t('Distinct')}
                <Icon name="chevron-down" />
              </button>
              <PluginPopover
                anchor={distinctAnchorId}
                open={distinctOpen}
                width={250}
                maxHeight={340}
                onClose={() => setDistinctOpen(false)}
              >
                <div className="ndb-col-picker">
                  <div className="ndb-col-picker-head">
                    <select
                      className="ndb-mono ndb-select-sm"
                      value={distinctCol || tab.columns[0]?.name || ''}
                      onChange={(e) => setDistinctCol(e.currentTarget.value)}
                    >
                      {tab.columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="ndb-menu-list">
                    {distinctValues.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="ndb-menu-item"
                        onClick={() => {
                          const col = distinctCol || tab.columns[0]?.name || '';
                          const where =
                            item.value === null || item.value === undefined
                              ? `${col} IS NULL`
                              : typeof item.value === 'number'
                                ? `${col} = ${item.value}`
                                : `${col} = '${String(item.value).replaceAll("'", "''")}'`;
                          setDistinctOpen(false);
                          onUpdateTab({ whereClause: where, appliedWhere: where });
                          onReload({ page: 1, whereClause: where });
                        }}
                      >
                        <span className="ndb-truncate ndb-mono">{item.label}</span>
                        <span className="ndb-spacer" />
                        <span className="ndb-count-pill ndb-mono">{item.count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </PluginPopover>
            </>
          )}

          {/* Auto-Refresh Timer (full workbench parity) */}
          <select
            aria-label={t('Auto Refresh')}
            className="ndb-mono ndb-select-sm"
            value={autoRefreshSec}
            onChange={(e) => setAutoRefreshSec(Number(e.currentTarget.value) || 0)}
            title={t('Auto Refresh')}
          >
            <option value={0}>{t('Auto: Off')}</option>
            <option value={2}>2s</option>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={30}>30s</option>
          </select>

          <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={onOpenStructure}>
            {t('Design Structure')}
          </button>

          {session.family === 'sqlite' && onSaveSqliteFile && (
            <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={onSaveSqliteFile}>
              {t('Save .sqlite')}
            </button>
          )}

          <button
            type="button"
            className="ndb-icon-btn"
            title={t('Refresh')}
            aria-label={t('Refresh')}
            disabled={tab.loading}
            onClick={() => onReload()}
          >
            <Icon name={tab.loading ? 'loader' : 'refresh'} />
          </button>
        </div>
      </div>

      {/* Bulk Edit Selected Rows Bar (full workbench parity) */}
      {isEditable && tab.selectedRowIndices.length > 0 && tab.columns.length > 0 && (
        <div className="ndb-inline-card">
          <span className="ndb-field-label">{`${t('Bulk Edit')} (${tab.selectedRowIndices.length})`}</span>
          <select
            className="ndb-mono ndb-select-sm"
            value={bulkCol || tab.columns[0]?.name || ''}
            onChange={(e) => setBulkCol(e.currentTarget.value)}
          >
            {tab.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            className="ndb-mono ndb-input-compact"
            disabled={bulkNull}
            placeholder={bulkNull ? 'NULL' : t('New value...')}
            value={bulkValue}
            onChange={(e) => setBulkValue(e.currentTarget.value)}
          />
          <label className="ndb-checkbox-row">
            <input type="checkbox" checked={bulkNull} onChange={(e) => setBulkNull(e.currentTarget.checked)} />
            <span>NULL</span>
          </label>
          <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={handleApplyBulkEdit}>
            {t('Apply')}
          </button>
        </div>
      )}

      {/* Visual WHERE Filter Builder Panel */}
      {tab.showFilterBuilder && (
        <div className="ndb-filter-builder">
          <div className="ndb-filter-rows">
            {rules.map((rule, idx) => {
              const noValueOp = rule.operator === 'IS NULL' || rule.operator === 'IS NOT NULL';
              return (
                <div key={rule.id || idx} className="ndb-filter-row">
                  {idx > 0 ? (
                    <select
                      className="ndb-mono ndb-select-sm ndb-filter-comb"
                      value={rule.combinator || 'AND'}
                      onChange={(e) => updateRule(idx, { combinator: e.currentTarget.value as 'AND' | 'OR' })}
                    >
                      <option value="AND">AND</option>
                      <option value="OR">OR</option>
                    </select>
                  ) : (
                    <span className="ndb-filter-comb-label ndb-mono">WHERE</span>
                  )}
                  <select
                    className="ndb-mono ndb-select-sm"
                    value={rule.column}
                    onChange={(e) => updateRule(idx, { column: e.currentTarget.value })}
                  >
                    {gridColumns.map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="ndb-mono ndb-select-sm"
                    value={rule.operator}
                    onChange={(e) => updateRule(idx, { operator: e.currentTarget.value as FilterOperator })}
                  >
                    {FILTER_OPERATORS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                  {!noValueOp && (
                    <input
                      type="text"
                      className="ndb-mono ndb-input-compact ndb-flex-1"
                      placeholder={rule.operator === 'IN' || rule.operator === 'NOT IN' ? '1, 2, 3' : 'value...'}
                      value={rule.value ?? ''}
                      onChange={(e) => updateRule(idx, { value: e.currentTarget.value })}
                    />
                  )}
                  <button
                    type="button"
                    className="ndb-icon-btn"
                    aria-label="Remove rule"
                    onClick={() => onUpdateTab({ filterRules: rules.filter((_, i) => i !== idx) })}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="ndb-filter-actions">
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={addRule}>
              <Icon name="plus" />
              {t('Add Rule')}
            </button>
            <div className="ndb-spacer" />
            <button
              type="button"
              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
              onClick={() => {
                onUpdateTab({ filterRules: [], whereClause: '', appliedWhere: '', showFilterBuilder: false });
                onReload({ page: 1, whereClause: '' });
              }}
            >
              {t('Clear')}
            </button>
            <button type="button" className="ndb-btn ndb-btn-primary ndb-btn-xs" onClick={applyFilterRules}>
              {t('Apply Rules')}
            </button>
          </div>
        </div>
      )}

      {tab.error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      {/* Main Editable Virtualized DataGrid */}
      <div className="ndb-grid-host">
        <PluginDataGrid
          columns={gridColumns}
          rows={tab.rows}
          dirtyCells={tab.dirtyCells}
          deletedRowIndices={tab.deletedRowIndices}
          insertedRows={tab.insertedRows}
          selectedRowIndices={tab.selectedRowIndices}
          hiddenColumns={tab.hiddenColumns ?? []}
          sort={tab.sort}
          editable={isEditable}
          loading={tab.loading}
          emptyMessage={t('Table has no matching rows')}
          onCellEdit={({ rowIndex, colName, value, isNull }) =>
            handleCellEdit(rowIndex, colName, value, isNull)
          }
          onCellContextMenu={handleCellContextMenu}
          onCellCopy={({ text }) => onCopyText(text, 'Cell')}
          onFkJump={
            onFkJump
              ? ({ targetTable, targetColumn, targetSchema, value }) =>
                  onFkJump({ table: targetTable, column: targetColumn, schema: targetSchema, value })
              : undefined
          }
          onSortChange={(nextSort) => onReload({ page: 1, sort: nextSort })}
          onRowSelect={({ selectedRowIndices }) => onUpdateTab({ selectedRowIndices })}
          onShortcut={handleGridShortcut}
        />

        {/* Floating Pending Changes Bar */}
        {hasPending && !readOnly && (
          <div className="ndb-pending-bar" role="region" aria-label={t('Pending changes')}>
            <div className="ndb-pending-summary">
              <span className="ndb-pending-dot" />
              <strong>{t('Pending changes')}</strong>
              {insertCount > 0 && <span className="ndb-tag ndb-tag-ok ndb-mono">{`+${insertCount} insert`}</span>}
              {dirtyCount > 0 && <span className="ndb-tag ndb-tag-warn ndb-mono">{`~${dirtyCount} cell`}</span>}
              {deleteCount > 0 && <span className="ndb-tag ndb-tag-danger ndb-mono">{`-${deleteCount} delete`}</span>}
            </div>
            <div className="ndb-pending-actions">
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                disabled={!canUndo}
                title={`${t('Undo')} (Cmd/Ctrl+Z)`}
                onClick={handleUndo}
              >
                {t('Undo')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                disabled={!canRedo}
                title={`${t('Redo')} (Cmd/Ctrl+Shift+Z)`}
                onClick={handleRedo}
              >
                {t('Redo')}
              </button>
              <span className="ndb-divider-v" />
              <button type="button" className="ndb-btn ndb-btn-secondary ndb-btn-sm" onClick={onPreviewChanges}>
                <Icon name="file-code" />
                {t('Preview SQL')}
              </button>
              <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={onDiscardChanges}>
                {t('Discard')}
              </button>
              <button type="button" className="ndb-btn ndb-btn-primary ndb-btn-sm" onClick={onCommitChanges}>
                <Icon name="check" />
                {t('Commit')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pagination & Metrics Footer */}
      <div className="ndb-result-strip ndb-mono">
        <div className="ndb-pager">
          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
            disabled={tab.loading || tab.page <= 1}
            onClick={() => onReload({ page: tab.page - 1 })}
          >
            {t('Prev')}
          </button>
          <span>{`${t('Page')} ${tab.page} / ${totalPages}`}</span>
          <button
            type="button"
            className="ndb-btn ndb-btn-ghost ndb-btn-xs"
            disabled={tab.loading || tab.page >= totalPages}
            onClick={() => onReload({ page: tab.page + 1 })}
          >
            {t('Next')}
          </button>
          <select
            aria-label="Page size"
            className="ndb-pagesize-select"
            value={tab.pageSize}
            onChange={(e) => onReload({ page: 1, pageSize: Number(e.currentTarget.value) })}
          >
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
            <option value={500}>500 / page</option>
          </select>
        </div>

        <span>{`${tab.totalEstimated ? '~' : ''}${tab.totalRows.toLocaleString()} ${t('total rows')}`}</span>
        <span>{`${tab.executionMs} ms`}</span>
        <span className="ndb-spacer" />
        <span className="ndb-muted ndb-truncate">
          {readOnly ? t('Read-Only Mode') : t('Double-click cell to edit · Right-click for actions')}
        </span>
      </div>
    </div>
  );
}
