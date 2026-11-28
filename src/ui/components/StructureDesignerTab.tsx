/**
 * Table Structure Designer Tab (v0.3.0):
 * Sub-tabs: Columns | Indexes | Foreign Keys | Checks | Triggers | DDL (Monaco read-only)
 * Supports Add/Rename/Alter/Drop Column (incl. Unique, AutoInc, Comment),
 * Add/Drop Index, Add/Drop Foreign Key, Add/Drop CHECK Constraint, and Rename Table
 * with live Preview ALTER DDL drawer + Apply (guarded in Read-Only mode).
 */

import React, { useState } from 'react';
import { PluginCodeEditor, type PluginWorkbenchShortcut } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { AddForeignKeySpec, CreateColumnSpec, TableStructureDiff } from '../../drivers/types';
import { engineToMonacoLanguage } from '../sessionManager';
import type { ActiveSession, StructureDesignerTabState } from '../types';

export interface StructureDesignerTabProps {
  tab: StructureDesignerTabState;
  session: ActiveSession;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<StructureDesignerTabState>) => void;
  onReload: () => void;
  onPreviewAlter: (diff: TableStructureDiff) => void;
  onApplyAlter: (diff: TableStructureDiff) => void;
  onOpenData: () => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

function hasDiffChanges(diff: TableStructureDiff): boolean {
  return Boolean(
    diff.renameTableTo ||
      diff.tableComment !== undefined ||
      diff.tableEngine ||
      diff.tableCharset ||
      diff.tableCollation ||
      diff.tableAutoIncrement !== undefined ||
      (diff.addColumns && diff.addColumns.length > 0) ||
      (diff.dropColumns && diff.dropColumns.length > 0) ||
      (diff.renameColumns && diff.renameColumns.length > 0) ||
      (diff.alterColumns && diff.alterColumns.length > 0) ||
      (diff.addIndexes && diff.addIndexes.length > 0) ||
      (diff.dropIndexes && diff.dropIndexes.length > 0) ||
      (diff.addForeignKeys && diff.addForeignKeys.length > 0) ||
      (diff.dropForeignKeys && diff.dropForeignKeys.length > 0) ||
      (diff.addCheckConstraints && diff.addCheckConstraints.length > 0) ||
      (diff.dropCheckConstraints && diff.dropCheckConstraints.length > 0),
  );
}

export function StructureDesignerTab({
  tab,
  session,
  t,
  onUpdateTab,
  onReload,
  onPreviewAlter,
  onApplyAlter,
  onOpenData,
  onShortcut,
}: StructureDesignerTabProps) {
  const readOnly = Boolean(session.connection.readOnly);

  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState(session.family === 'sqlite' ? 'TEXT' : 'VARCHAR(255)');
  const [newColNullable, setNewColNullable] = useState(true);
  const [newColUnique, setNewColUnique] = useState(false);
  const [newColAutoInc, setNewColAutoInc] = useState(false);
  const [newColDefault, setNewColDefault] = useState('');
  const [newColComment, setNewColComment] = useState('');

  const [newIdxName, setNewIdxName] = useState('');
  const [newIdxCols, setNewIdxCols] = useState('');
  const [newIdxUnique, setNewIdxUnique] = useState(false);

  const [newFkName, setNewFkName] = useState('');
  const [newFkCols, setNewFkCols] = useState('');
  const [newFkRefTable, setNewFkRefTable] = useState('');
  const [newFkRefCols, setNewFkRefCols] = useState('id');
  const [newFkOnDelete, setNewFkOnDelete] = useState('NO ACTION');
  const [newFkOnUpdate, setNewFkOnUpdate] = useState('NO ACTION');

  const [newCheckName, setNewCheckName] = useState('');
  const [newCheckExpr, setNewCheckExpr] = useState('');

  const [editingCol, setEditingCol] = useState<string | null>(null);
  const [editRename, setEditRename] = useState('');
  const [editType, setEditType] = useState('');
  const [editNullable, setEditNullable] = useState(true);
  const [editUnique, setEditUnique] = useState(false);
  const [editDefault, setEditDefault] = useState('');
  const [editComment, setEditComment] = useState('');

  const [renameTableInput, setRenameTableInput] = useState('');
  const [tableCommentInput, setTableCommentInput] = useState(tab.structure?.comment ?? '');
  const [tableEngineInput, setTableEngineInput] = useState(tab.structure?.engine ?? '');
  const [tableCharsetInput, setTableCharsetInput] = useState(tab.structure?.charset ?? '');
  const [tableCollationInput, setTableCollationInput] = useState(tab.structure?.collation ?? '');
  const [tableAutoIncInput, setTableAutoIncInput] = useState(
    tab.structure?.autoIncrement != null ? String(tab.structure.autoIncrement) : '',
  );

  const structure = tab.structure;
  const partitions = tab.partitions ?? structure?.partitions ?? [];
  const diff = tab.pendingDiff;
  const pending = hasDiffChanges(diff);

  const updateDiff = (next: TableStructureDiff) => {
    if (readOnly) return;
    onUpdateTab({ pendingDiff: next, dirty: hasDiffChanges(next) });
  };

  const handleStageAddColumn = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || !newColName.trim() || !newColType.trim()) return;
    const spec: CreateColumnSpec = {
      name: newColName.trim(),
      dataType: newColType.trim(),
      nullable: newColNullable,
      unique: newColUnique || undefined,
      isAutoIncrement: newColAutoInc || undefined,
      defaultValue: newColDefault.trim() ? newColDefault.trim() : null,
      comment: newColComment.trim() || undefined,
    };
    updateDiff({
      ...diff,
      addColumns: [...(diff.addColumns ?? []), spec],
    });
    setNewColName('');
    setNewColDefault('');
    setNewColComment('');
    setNewColUnique(false);
    setNewColAutoInc(false);
  };

  const handleToggleDropColumn = (colName: string) => {
    const existing = new Set(diff.dropColumns ?? []);
    if (existing.has(colName)) existing.delete(colName);
    else existing.add(colName);
    updateDiff({ ...diff, dropColumns: Array.from(existing) });
  };

  const handleSaveColumnEdit = (origName: string) => {
    const nextRenames = (diff.renameColumns ?? []).filter((r) => r.from !== origName);
    if (editRename.trim() && editRename.trim() !== origName) {
      nextRenames.push({ from: origName, to: editRename.trim() });
    }
    const nextAlters = (diff.alterColumns ?? []).filter((a) => a.name !== origName);
    const orig = structure?.columns.find((c) => c.name === origName);
    const nextDef = editDefault.trim() ? editDefault.trim() : null;
    if (
      orig &&
      (editType.trim() !== orig.dataType ||
        editNullable !== orig.nullable ||
        editUnique !== Boolean(orig.unique) ||
        (orig.defaultValue ?? null) !== nextDef ||
        (orig.comment ?? '') !== editComment.trim())
    ) {
      nextAlters.push({
        name: editRename.trim() || origName,
        dataType: editType.trim(),
        nullable: editNullable,
        unique: editUnique || undefined,
        defaultValue: nextDef,
        comment: editComment.trim() || undefined,
      });
    }
    updateDiff({
      ...diff,
      renameColumns: nextRenames,
      alterColumns: nextAlters,
    });
    setEditingCol(null);
  };

  const handleStageAddIndex = (e: React.FormEvent) => {
    e.preventDefault();
    const cols = newIdxCols.split(',').map((s) => s.trim()).filter(Boolean);
    if (readOnly || !newIdxName.trim() || cols.length === 0) return;
    updateDiff({
      ...diff,
      addIndexes: [
        ...(diff.addIndexes ?? []),
        { name: newIdxName.trim(), columns: cols, unique: newIdxUnique },
      ],
    });
    setNewIdxName('');
    setNewIdxCols('');
    setNewIdxUnique(false);
  };

  const handleToggleDropIndex = (idxName: string) => {
    const existing = new Set(diff.dropIndexes ?? []);
    if (existing.has(idxName)) existing.delete(idxName);
    else existing.add(idxName);
    updateDiff({ ...diff, dropIndexes: Array.from(existing) });
  };

  const handleStageAddFk = (e: React.FormEvent) => {
    e.preventDefault();
    const cols = newFkCols.split(',').map((s) => s.trim()).filter(Boolean);
    const refCols = newFkRefCols.split(',').map((s) => s.trim()).filter(Boolean);
    if (readOnly || cols.length === 0 || !newFkRefTable.trim() || refCols.length === 0) return;
    const spec: AddForeignKeySpec = {
      name: newFkName.trim() || `fk_${tab.table}_${cols[0]}`,
      columns: cols,
      referencedTable: newFkRefTable.trim(),
      referencedColumns: refCols,
      onDelete: newFkOnDelete,
      onUpdate: newFkOnUpdate,
    };
    updateDiff({
      ...diff,
      addForeignKeys: [...(diff.addForeignKeys ?? []), spec],
    });
    setNewFkName('');
    setNewFkCols('');
    setNewFkRefTable('');
  };

  const handleToggleDropFk = (fkName: string) => {
    const existing = new Set(diff.dropForeignKeys ?? []);
    if (existing.has(fkName)) existing.delete(fkName);
    else existing.add(fkName);
    updateDiff({ ...diff, dropForeignKeys: Array.from(existing) });
  };

  const handleStageAddCheck = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || !newCheckExpr.trim()) return;
    updateDiff({
      ...diff,
      addCheckConstraints: [
        ...(diff.addCheckConstraints ?? []),
        { name: newCheckName.trim() || undefined, expression: newCheckExpr.trim() },
      ],
    });
    setNewCheckName('');
    setNewCheckExpr('');
  };

  const handleToggleDropCheck = (checkName: string) => {
    const existing = new Set(diff.dropCheckConstraints ?? []);
    if (existing.has(checkName)) existing.delete(checkName);
    else existing.add(checkName);
    updateDiff({ ...diff, dropCheckConstraints: Array.from(existing) });
  };

  return (
    <div className="ndb-tab-pane">
      {/* Header Toolbar */}
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <div className="ndb-subtab-inline">
          {(
            [
              ['columns', `${t('Columns')} (${structure?.columns.length ?? 0})`],
              ['indexes', `${t('Indexes')} (${structure?.indexes.length ?? 0})`],
              ['fks', `${t('Foreign Keys')} (${structure?.foreignKeys.length ?? 0})`],
              ['checks', `${t('Checks')} (${structure?.checkConstraints?.length ?? 0})`],
              ['triggers', `${t('Triggers')} (${tab.triggers.length})`],
              ['partitions', `${t('Partitions')} (${partitions.length})`],
              ['ddl', 'DDL'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`ndb-pill-tab ${tab.activeSubTab === id ? 'is-active' : ''}`}
              onClick={() => onUpdateTab({ activeSubTab: id })}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ndb-spacer" />

        <div className="ndb-toolbar-group">
          {readOnly && <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>}
          <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-sm" onClick={onOpenData}>
            <Icon name="table" />
            {t('Open Data')}
          </button>
          <button
            type="button"
            className="ndb-icon-btn"
            title={t('Refresh')}
            disabled={tab.loading}
            onClick={onReload}
          >
            <Icon name={tab.loading ? 'loader' : 'refresh'} />
          </button>
        </div>
      </div>

      {tab.error && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{tab.error}</span>
        </div>
      )}

      {/* Body */}
      <div className="ndb-structure-body">
        {!structure ? (
          <div className="ndb-empty-center">
            <Icon name={tab.loading ? 'loader' : 'table'} />
            <p>{tab.loading ? t('Loading...') : 'Structure unavailable'}</p>
          </div>
        ) : tab.activeSubTab === 'columns' ? (
          <div className="ndb-structure-scroll">
            {/* Object Statistics Header (full workbench parity) */}
            {(structure.engine || structure.rowCountEstimate !== undefined || structure.comment) && (
              <div className="ndb-inline-card">
                {structure.engine && <span className="ndb-tag ndb-mono">{`ENGINE: ${structure.engine}`}</span>}
                {structure.rowCountEstimate !== undefined && (
                  <span className="ndb-tag ndb-mono">{`~${structure.rowCountEstimate} rows`}</span>
                )}
                {structure.collation && <span className="ndb-tag ndb-mono">{structure.collation}</span>}
                {structure.comment && <span className="ndb-muted">{structure.comment}</span>}
              </div>
            )}

            {/* Rename Table & Physical Options Bar */}
            {!readOnly && (
              <div className="ndb-inline-card ndb-toolbar-wrap">
                <span className="ndb-field-label">{t('Rename Table')}</span>
                <input
                  type="text"
                  className="ndb-mono ndb-input-compact"
                  placeholder={tab.table}
                  value={renameTableInput}
                  onChange={(e) => setRenameTableInput(e.currentTarget.value)}
                />
                <span className="ndb-field-label">{t('Comment')}</span>
                <input
                  type="text"
                  className="ndb-input-compact"
                  placeholder={structure.comment ?? t('Table comment...')}
                  value={tableCommentInput}
                  onChange={(e) => setTableCommentInput(e.currentTarget.value)}
                />
                {session.family === 'mysql' && (
                  <>
                    <input
                      type="text"
                      className="ndb-mono ndb-input-compact"
                      placeholder={structure.engine ?? 'InnoDB'}
                      value={tableEngineInput}
                      onChange={(e) => setTableEngineInput(e.currentTarget.value)}
                    />
                    <input
                      type="text"
                      className="ndb-mono ndb-input-compact"
                      placeholder={structure.charset ?? 'utf8mb4'}
                      value={tableCharsetInput}
                      onChange={(e) => setTableCharsetInput(e.currentTarget.value)}
                    />
                    <input
                      type="text"
                      className="ndb-mono ndb-input-compact"
                      placeholder={structure.collation ?? 'utf8mb4_unicode_ci'}
                      value={tableCollationInput}
                      onChange={(e) => setTableCollationInput(e.currentTarget.value)}
                    />
                    <input
                      type="text"
                      className="ndb-mono ndb-input-compact"
                      placeholder="AUTO_INCREMENT"
                      value={tableAutoIncInput}
                      onChange={(e) => setTableAutoIncInput(e.currentTarget.value)}
                    />
                  </>
                )}
                <button
                  type="button"
                  className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                  onClick={() => {
                    const nextDiff: TableStructureDiff = { ...diff };
                    if (tableCommentInput !== (structure.comment ?? '')) nextDiff.tableComment = tableCommentInput;
                    if (tableEngineInput.trim() && tableEngineInput.trim() !== (structure.engine ?? '')) {
                      nextDiff.tableEngine = tableEngineInput.trim();
                    }
                    if (tableCharsetInput.trim()) nextDiff.tableCharset = tableCharsetInput.trim();
                    if (tableCollationInput.trim()) nextDiff.tableCollation = tableCollationInput.trim();
                    const parsedAi = Number(tableAutoIncInput);
                    if (tableAutoIncInput.trim() && Number.isFinite(parsedAi) && parsedAi > 0) {
                      nextDiff.tableAutoIncrement = Math.floor(parsedAi);
                    }
                    updateDiff(nextDiff);
                  }}
                >
                  {t('Stage Options')}
                </button>
                <button
                  type="button"
                  className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                  disabled={!renameTableInput.trim() || renameTableInput.trim() === tab.table}
                  onClick={() => updateDiff({ ...diff, renameTableTo: renameTableInput.trim() })}
                >
                  {t('Stage Rename')}
                </button>
                {diff.renameTableTo && (
                  <span className="ndb-tag ndb-tag-warn ndb-mono">{`→ ${diff.renameTableTo}`}</span>
                )}
              </div>
            )}

            {/* Columns Table */}
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('Name')}</th>
                  <th>{t('Type')}</th>
                  <th>{t('Nullable')}</th>
                  <th>{t('Default')}</th>
                  <th>{t('Comment')}</th>
                  <th>Key</th>
                  {!readOnly && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {structure.columns.map((col, idx) => {
                  const dropped = (diff.dropColumns ?? []).includes(col.name);
                  const renamed = (diff.renameColumns ?? []).find((r) => r.from === col.name);
                  const altered = (diff.alterColumns ?? []).find(
                    (a) => a.name === col.name || (renamed && a.name === renamed.to),
                  );
                  const isEditing = editingCol === col.name;

                  return (
                    <tr
                      key={col.name}
                      className={dropped ? 'is-dropped-row' : renamed || altered ? 'is-dirty-row' : ''}
                    >
                      <td className="ndb-mono ndb-muted">{idx + 1}</td>
                      <td className="ndb-mono">
                        {isEditing ? (
                          <input
                            type="text"
                            className="ndb-mono ndb-input-xs"
                            value={editRename}
                            onChange={(e) => setEditRename(e.currentTarget.value)}
                          />
                        ) : renamed ? (
                          <span>
                            <s className="ndb-muted">{col.name}</s> → <strong>{renamed.to}</strong>
                          </span>
                        ) : (
                          <strong>{col.name}</strong>
                        )}
                      </td>
                      <td className="ndb-mono">
                        {isEditing ? (
                          <input
                            type="text"
                            className="ndb-mono ndb-input-xs"
                            value={editType}
                            onChange={(e) => setEditType(e.currentTarget.value)}
                          />
                        ) : (
                          <span className="ndb-type-chip">{altered?.dataType ?? col.dataType}</span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <label className="ndb-checkbox-row">
                            <input
                              type="checkbox"
                              checked={editNullable}
                              onChange={(e) => setEditNullable(e.currentTarget.checked)}
                            />
                            <span>NULL</span>
                          </label>
                        ) : (altered?.nullable ?? col.nullable) ? (
                          'NULL'
                        ) : (
                          'NOT NULL'
                        )}
                      </td>
                      <td className="ndb-mono ndb-muted">
                        {isEditing ? (
                          <input
                            type="text"
                            className="ndb-mono ndb-input-xs"
                            value={editDefault}
                            placeholder="NULL"
                            onChange={(e) => setEditDefault(e.currentTarget.value)}
                          />
                        ) : (
                          (altered !== undefined ? altered.defaultValue : col.defaultValue) ?? '—'
                        )}
                      </td>
                      <td className="ndb-muted">
                        {isEditing ? (
                          <input
                            type="text"
                            className="ndb-input-xs"
                            value={editComment}
                            placeholder={t('Comment')}
                            onChange={(e) => setEditComment(e.currentTarget.value)}
                          />
                        ) : (
                          (altered?.comment ?? col.comment) || '—'
                        )}
                      </td>
                      <td>
                        {col.isPrimaryKey && <span className="ndb-badge-pk">PK</span>}
                        {col.isAutoIncrement && <span className="ndb-tag ndb-mono">AUTO</span>}
                        {(altered?.unique ?? col.unique) && <span className="ndb-tag ndb-mono">UQ</span>}
                        {isEditing && (
                          <label className="ndb-checkbox-row">
                            <input
                              type="checkbox"
                              checked={editUnique}
                              onChange={(e) => setEditUnique(e.currentTarget.checked)}
                            />
                            <span>UQ</span>
                          </label>
                        )}
                      </td>
                      {!readOnly && (
                        <td className="ndb-cell-actions">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                className="ndb-btn ndb-btn-primary ndb-btn-xs"
                                onClick={() => handleSaveColumnEdit(col.name)}
                              >
                                {t('Save')}
                              </button>
                              <button
                                type="button"
                                className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                onClick={() => setEditingCol(null)}
                              >
                                {t('Cancel')}
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                                disabled={dropped}
                                onClick={() => {
                                  setEditingCol(col.name);
                                  setEditRename(renamed?.to ?? col.name);
                                  setEditType(altered?.dataType ?? col.dataType);
                                  setEditNullable(altered?.nullable ?? col.nullable);
                                  setEditUnique(Boolean(altered?.unique ?? col.unique));
                                  setEditDefault((altered !== undefined ? altered.defaultValue : col.defaultValue) ?? '');
                                  setEditComment(altered?.comment ?? col.comment ?? '');
                                }}
                              >
                                {t('Edit')}
                              </button>
                              <button
                                type="button"
                                className={`ndb-btn ndb-btn-xs ${dropped ? 'ndb-btn-secondary' : 'ndb-btn-ghost ndb-text-danger'}`}
                                onClick={() => handleToggleDropColumn(col.name)}
                              >
                                {dropped ? t('Undo') : 'Drop'}
                              </button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}

                {/* Staged Added Columns */}
                {(diff.addColumns ?? []).map((col, idx) => (
                  <tr key={`add-${idx}`} className="is-added-row">
                    <td className="ndb-mono">+</td>
                    <td className="ndb-mono">
                      <strong>{col.name}</strong>
                    </td>
                    <td className="ndb-mono">
                      <span className="ndb-type-chip">{col.dataType}</span>
                    </td>
                    <td>{col.nullable === false ? 'NOT NULL' : 'NULL'}</td>
                    <td className="ndb-mono">{col.defaultValue ?? '—'}</td>
                    <td className="ndb-muted">{col.comment || '—'}</td>
                    <td>
                      <span className="ndb-tag ndb-tag-ok">NEW</span>
                      {col.unique && <span className="ndb-tag ndb-mono">UQ</span>}
                      {col.isAutoIncrement && <span className="ndb-tag ndb-mono">AUTO</span>}
                    </td>
                    {!readOnly && (
                      <td>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() =>
                            updateDiff({
                              ...diff,
                              addColumns: (diff.addColumns ?? []).filter((_, i) => i !== idx),
                            })
                          }
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Add Column Form */}
            {!readOnly && (
              <form className="ndb-add-row-form" onSubmit={handleStageAddColumn}>
                <strong>{t('Add Column')}</strong>
                <div className="ndb-add-row-inputs">
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder="column_name"
                    value={newColName}
                    onChange={(e) => setNewColName(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder="TEXT / INTEGER / VARCHAR(255)"
                    value={newColType}
                    onChange={(e) => setNewColType(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder={`${t('Default')} (optional)`}
                    value={newColDefault}
                    onChange={(e) => setNewColDefault(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    placeholder={t('Comment')}
                    value={newColComment}
                    onChange={(e) => setNewColComment(e.currentTarget.value)}
                  />
                  <label className="ndb-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newColNullable}
                      onChange={(e) => setNewColNullable(e.currentTarget.checked)}
                    />
                    <span>{t('Nullable')}</span>
                  </label>
                  <label className="ndb-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newColUnique}
                      onChange={(e) => setNewColUnique(e.currentTarget.checked)}
                    />
                    <span>{t('Unique')}</span>
                  </label>
                  <label className="ndb-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newColAutoInc}
                      onChange={(e) => setNewColAutoInc(e.currentTarget.checked)}
                    />
                    <span>{t('Auto Inc')}</span>
                  </label>
                  <button
                    type="submit"
                    className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                    disabled={!newColName.trim() || !newColType.trim()}
                  >
                    <Icon name="plus" />
                    Stage
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : tab.activeSubTab === 'indexes' ? (
          <div className="ndb-structure-scroll">
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Columns')}</th>
                  <th>{t('Type')}</th>
                  <th>{t('Unique')}</th>
                  {!readOnly && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {structure.indexes.map((idx) => {
                  const dropped = (diff.dropIndexes ?? []).includes(idx.name);
                  return (
                    <tr key={idx.name} className={dropped ? 'is-dropped-row' : ''}>
                      <td className="ndb-mono">
                        <strong>{idx.name}</strong>
                        {idx.primary && <span className="ndb-badge-pk">PK</span>}
                      </td>
                      <td className="ndb-mono">{idx.columns.join(', ')}</td>
                      <td className="ndb-mono ndb-muted">{idx.type || 'BTREE'}</td>
                      <td>{idx.unique ? 'UNIQUE' : 'No'}</td>
                      {!readOnly && (
                        <td>
                          {!idx.primary && (
                            <button
                              type="button"
                              className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                              onClick={() => handleToggleDropIndex(idx.name)}
                            >
                              {dropped ? t('Undo') : 'Drop'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {(diff.addIndexes ?? []).map((idx, i) => (
                  <tr key={`new-idx-${i}`} className="is-added-row">
                    <td className="ndb-mono">
                      <strong>{idx.name}</strong> <span className="ndb-tag ndb-tag-ok">NEW</span>
                    </td>
                    <td className="ndb-mono">{idx.columns.join(', ')}</td>
                    <td className="ndb-mono">INDEX</td>
                    <td>{idx.unique ? 'UNIQUE' : 'No'}</td>
                    {!readOnly && (
                      <td>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() =>
                            updateDiff({
                              ...diff,
                              addIndexes: (diff.addIndexes ?? []).filter((_, j) => j !== i),
                            })
                          }
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {!readOnly && (
              <form className="ndb-add-row-form" onSubmit={handleStageAddIndex}>
                <strong>{t('Add Index')}</strong>
                <div className="ndb-add-row-inputs">
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder={`idx_${tab.table}_col`}
                    value={newIdxName}
                    onChange={(e) => setNewIdxName(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder="col1, col2"
                    value={newIdxCols}
                    onChange={(e) => setNewIdxCols(e.currentTarget.value)}
                  />
                  <label className="ndb-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newIdxUnique}
                      onChange={(e) => setNewIdxUnique(e.currentTarget.checked)}
                    />
                    <span>{t('Unique')}</span>
                  </label>
                  <button
                    type="submit"
                    className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                    disabled={!newIdxName.trim() || !newIdxCols.trim()}
                  >
                    <Icon name="plus" />
                    Stage
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : tab.activeSubTab === 'fks' ? (
          <div className="ndb-structure-scroll">
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>Constraint</th>
                  <th>{t('Columns')}</th>
                  <th>References</th>
                  <th>ON UPDATE</th>
                  <th>ON DELETE</th>
                  {!readOnly && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {structure.foreignKeys.map((fk) => {
                  const dropped = (diff.dropForeignKeys ?? []).includes(fk.name);
                  return (
                    <tr key={fk.name} className={dropped ? 'is-dropped-row' : ''}>
                      <td className="ndb-mono">
                        <strong>{fk.name}</strong>
                      </td>
                      <td className="ndb-mono">{fk.columns.join(', ')}</td>
                      <td className="ndb-mono">{`${fk.referencedTable}(${fk.referencedColumns.join(', ')})`}</td>
                      <td className="ndb-mono ndb-muted">{fk.onUpdate || 'NO ACTION'}</td>
                      <td className="ndb-mono ndb-muted">{fk.onDelete || 'NO ACTION'}</td>
                      {!readOnly && (
                        <td>
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                            onClick={() => handleToggleDropFk(fk.name)}
                          >
                            {dropped ? t('Undo') : 'Drop'}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {(diff.addForeignKeys ?? []).map((fk, i) => (
                  <tr key={`new-fk-${i}`} className="is-added-row">
                    <td className="ndb-mono">
                      <strong>{fk.name || `fk_${i + 1}`}</strong> <span className="ndb-tag ndb-tag-ok">NEW</span>
                    </td>
                    <td className="ndb-mono">{fk.columns.join(', ')}</td>
                    <td className="ndb-mono">{`${fk.referencedTable}(${fk.referencedColumns.join(', ')})`}</td>
                    <td className="ndb-mono">{fk.onUpdate || 'NO ACTION'}</td>
                    <td className="ndb-mono">{fk.onDelete || 'NO ACTION'}</td>
                    {!readOnly && (
                      <td>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() =>
                            updateDiff({
                              ...diff,
                              addForeignKeys: (diff.addForeignKeys ?? []).filter((_, j) => j !== i),
                            })
                          }
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {structure.foreignKeys.length === 0 && (diff.addForeignKeys ?? []).length === 0 && (
                  <tr>
                    <td colSpan={readOnly ? 5 : 6} className="ndb-table-empty">
                      No foreign keys defined on this table.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {!readOnly && (
              <form className="ndb-add-row-form" onSubmit={handleStageAddFk}>
                <strong>{t('Add Foreign Key')}</strong>
                <div className="ndb-add-row-inputs">
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder={`fk_${tab.table}_ref`}
                    value={newFkName}
                    onChange={(e) => setNewFkName(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder="column (e.g. user_id)"
                    value={newFkCols}
                    onChange={(e) => setNewFkCols(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder="ref_table"
                    value={newFkRefTable}
                    onChange={(e) => setNewFkRefTable(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    className="ndb-mono ndb-input-xs"
                    placeholder="ref_col"
                    value={newFkRefCols}
                    onChange={(e) => setNewFkRefCols(e.currentTarget.value)}
                  />
                  <select
                    className="ndb-mono ndb-select-sm"
                    value={newFkOnDelete}
                    title="ON DELETE"
                    onChange={(e) => setNewFkOnDelete(e.currentTarget.value)}
                  >
                    {FK_ACTIONS.map((a) => (
                      <option key={a} value={a}>{`DEL: ${a}`}</option>
                    ))}
                  </select>
                  <select
                    className="ndb-mono ndb-select-sm"
                    value={newFkOnUpdate}
                    title="ON UPDATE"
                    onChange={(e) => setNewFkOnUpdate(e.currentTarget.value)}
                  >
                    {FK_ACTIONS.map((a) => (
                      <option key={a} value={a}>{`UPD: ${a}`}</option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                    disabled={!newFkCols.trim() || !newFkRefTable.trim() || !newFkRefCols.trim()}
                  >
                    <Icon name="plus" />
                    Stage
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : tab.activeSubTab === 'checks' ? (
          <div className="ndb-structure-scroll">
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Expression')}</th>
                  {!readOnly && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {(structure.checkConstraints ?? []).map((chk) => {
                  const dropped = (diff.dropCheckConstraints ?? []).includes(chk.name);
                  return (
                    <tr key={chk.name} className={dropped ? 'is-dropped-row' : ''}>
                      <td className="ndb-mono"><strong>{chk.name}</strong></td>
                      <td className="ndb-mono">{chk.expression}</td>
                      {!readOnly && (
                        <td>
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                            onClick={() => handleToggleDropCheck(chk.name)}
                          >
                            {dropped ? t('Undo') : 'Drop'}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {(diff.addCheckConstraints ?? []).map((chk, i) => (
                  <tr key={`new-chk-${i}`} className="is-added-row">
                    <td className="ndb-mono">
                      <strong>{chk.name || `chk_${i + 1}`}</strong> <span className="ndb-tag ndb-tag-ok">NEW</span>
                    </td>
                    <td className="ndb-mono">{chk.expression}</td>
                    {!readOnly && (
                      <td>
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() =>
                            updateDiff({
                              ...diff,
                              addCheckConstraints: (diff.addCheckConstraints ?? []).filter((_, j) => j !== i),
                            })
                          }
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {(structure.checkConstraints ?? []).length === 0 && (diff.addCheckConstraints ?? []).length === 0 && (
                  <tr>
                    <td colSpan={readOnly ? 2 : 3} className="ndb-table-empty">
                      No CHECK constraints defined on this table.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {!readOnly && (
              <form className="ndb-add-row-form" onSubmit={handleStageAddCheck}>
                <strong>{t('Add Check')}</strong>
                <div className="ndb-add-row-inputs">
                  <input
                    type="text"
                    className="ndb-mono"
                    placeholder={`chk_${tab.table}_rule`}
                    value={newCheckName}
                    onChange={(e) => setNewCheckName(e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    className="ndb-mono ndb-flex-1"
                    placeholder="amount >= 0"
                    value={newCheckExpr}
                    onChange={(e) => setNewCheckExpr(e.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                    disabled={!newCheckExpr.trim()}
                  >
                    <Icon name="plus" />
                    Stage
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : tab.activeSubTab === 'triggers' ? (
          <div className="ndb-structure-scroll">
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>Trigger</th>
                  <th>Timing</th>
                  <th>Event</th>
                  <th>Definition</th>
                </tr>
              </thead>
              <tbody>
                {tab.triggers.map((tr) => (
                  <tr key={tr.name}>
                    <td className="ndb-mono">
                      <strong>{tr.name}</strong>
                    </td>
                    <td className="ndb-mono">{tr.timing || '—'}</td>
                    <td className="ndb-mono">{tr.event || '—'}</td>
                    <td className="ndb-mono ndb-muted">{tr.definition || '—'}</td>
                  </tr>
                ))}
                {tab.triggers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="ndb-table-empty">
                      No triggers on this table.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : tab.activeSubTab === 'partitions' ? (
          <div className="ndb-structure-scroll">
            <table className="ndb-table">
              <thead>
                <tr>
                  <th>{t('Partition')}</th>
                  <th>{t('Method')}</th>
                  <th>{t('Expression / Bound')}</th>
                  <th>{t('Rows')}</th>
                  <th>{t('Size')}</th>
                </tr>
              </thead>
              <tbody>
                {partitions.map((p) => (
                  <tr key={`${p.name}:${p.subpartitionName ?? ''}`}>
                    <td className="ndb-mono">
                      <strong>{p.name}</strong>
                      {p.subpartitionName ? ` / ${p.subpartitionName}` : ''}
                    </td>
                    <td className="ndb-mono">{p.method || '—'}</td>
                    <td className="ndb-mono ndb-muted">{p.bound || p.expression || '—'}</td>
                    <td className="ndb-mono">{p.rowCountEstimate ?? '—'}</td>
                    <td className="ndb-mono">{p.sizeBytes != null ? `${Math.round(p.sizeBytes / 1024)} KB` : '—'}</td>
                  </tr>
                ))}
                {partitions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="ndb-table-empty">
                      {t('No partitions defined on this table.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="ndb-editor-host">
            <PluginCodeEditor
              value={structure.createDdl || '-- DDL not available'}
              language={engineToMonacoLanguage(session.connection.engine)}
              readOnly
              wordWrap="on"
              onShortcut={onShortcut}
            />
          </div>
        )}

        {/* Pending ALTER DDL Bar */}
        {pending && !readOnly && (
          <div className="ndb-pending-bar">
            <div className="ndb-pending-summary">
              <span className="ndb-pending-dot" />
              <strong>{t('Staged ALTER changes')}</strong>
            </div>
            <div className="ndb-pending-actions">
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-sm"
                onClick={() => onPreviewAlter(diff)}
              >
                <Icon name="file-code" />
                {t('Preview ALTER DDL')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-sm"
                onClick={() => updateDiff({})}
              >
                {t('Discard')}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-primary ndb-btn-sm"
                disabled={tab.applying}
                onClick={() => onApplyAlter(diff)}
              >
                <Icon name={tab.applying ? 'loader' : 'check'} />
                {t('Apply Changes')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
