/**
 * Table Structure Designer Tab:
 * Sub-tabs: Columns | Indexes | Foreign Keys | Triggers | DDL (Monaco read-only)
 * Supports Add Column, Rename / Alter Column, Drop Column, Add / Drop Index, Rename Table
 * with live Preview ALTER DDL drawer + Apply!
 */

import React, { useState } from 'react';
import { PluginCodeEditor } from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type { CreateColumnSpec, TableStructureDiff } from '../../drivers/types';
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
}

function hasDiffChanges(diff: TableStructureDiff): boolean {
  return Boolean(
    diff.renameTableTo ||
      (diff.addColumns && diff.addColumns.length > 0) ||
      (diff.dropColumns && diff.dropColumns.length > 0) ||
      (diff.renameColumns && diff.renameColumns.length > 0) ||
      (diff.alterColumns && diff.alterColumns.length > 0) ||
      (diff.addIndexes && diff.addIndexes.length > 0) ||
      (diff.dropIndexes && diff.dropIndexes.length > 0),
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
}: StructureDesignerTabProps) {
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState(session.family === 'sqlite' ? 'TEXT' : 'VARCHAR(255)');
  const [newColNullable, setNewColNullable] = useState(true);
  const [newColDefault, setNewColDefault] = useState('');

  const [newIdxName, setNewIdxName] = useState('');
  const [newIdxCols, setNewIdxCols] = useState('');
  const [newIdxUnique, setNewIdxUnique] = useState(false);

  const [editingCol, setEditingCol] = useState<string | null>(null);
  const [editRename, setEditRename] = useState('');
  const [editType, setEditType] = useState('');
  const [editNullable, setEditNullable] = useState(true);
  const [editDefault, setEditDefault] = useState('');

  const [renameTableInput, setRenameTableInput] = useState('');

  const structure = tab.structure;
  const diff = tab.pendingDiff;
  const pending = hasDiffChanges(diff);

  const updateDiff = (next: TableStructureDiff) => {
    onUpdateTab({ pendingDiff: next, dirty: hasDiffChanges(next) });
  };

  const handleStageAddColumn = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newColName.trim() || !newColType.trim()) return;
    const spec: CreateColumnSpec = {
      name: newColName.trim(),
      dataType: newColType.trim(),
      nullable: newColNullable,
      defaultValue: newColDefault.trim() ? newColDefault.trim() : null,
    };
    updateDiff({
      ...diff,
      addColumns: [...(diff.addColumns ?? []), spec],
    });
    setNewColName('');
    setNewColDefault('');
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
        (orig.defaultValue ?? null) !== nextDef)
    ) {
      nextAlters.push({
        name: editRename.trim() || origName,
        dataType: editType.trim(),
        nullable: editNullable,
        defaultValue: nextDef,
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
    const cols = newIdxCols
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!newIdxName.trim() || cols.length === 0) return;
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

  return (
    <div className="dbx-tab-pane">
      {/* Header Toolbar */}
      <div className="dbx-toolbar">
        <div className="dbx-subtab-inline">
          {(
            [
              ['columns', `${t('Columns')} (${structure?.columns.length ?? 0})`],
              ['indexes', `${t('Indexes')} (${structure?.indexes.length ?? 0})`],
              ['fks', `${t('Foreign Keys')} (${structure?.foreignKeys.length ?? 0})`],
              ['triggers', `${t('Triggers')} (${tab.triggers.length})`],
              ['ddl', 'DDL'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`dbx-pill-tab ${tab.activeSubTab === id ? 'is-active' : ''}`}
              onClick={() => onUpdateTab({ activeSubTab: id })}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="dbx-spacer" />

        <div className="dbx-toolbar-group">
          <button type="button" className="dbx-btn dbx-btn-ghost dbx-btn-sm" onClick={onOpenData}>
            <Icon name="table" />
            {t('Open Data')}
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

      {/* Body */}
      <div className="dbx-structure-body">
        {!structure ? (
          <div className="dbx-empty-center">
            <Icon name={tab.loading ? 'loader' : 'table'} />
            <p>{tab.loading ? t('Loading...') : 'Structure unavailable'}</p>
          </div>
        ) : tab.activeSubTab === 'columns' ? (
          <div className="dbx-structure-scroll">
            {/* Rename Table Bar */}
            <div className="dbx-inline-card">
              <span className="dbx-field-label">{t('Rename Table')}</span>
              <input
                type="text"
                className="dbx-mono dbx-input-compact"
                placeholder={tab.table}
                value={renameTableInput}
                onChange={(e) => setRenameTableInput(e.currentTarget.value)}
              />
              <button
                type="button"
                className="dbx-btn dbx-btn-secondary dbx-btn-sm"
                disabled={!renameTableInput.trim() || renameTableInput.trim() === tab.table}
                onClick={() => updateDiff({ ...diff, renameTableTo: renameTableInput.trim() })}
              >
                Stage Rename
              </button>
              {diff.renameTableTo && (
                <span className="dbx-tag dbx-tag-warn dbx-mono">{`→ ${diff.renameTableTo}`}</span>
              )}
            </div>

            {/* Columns Table */}
            <table className="dbx-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>Default</th>
                  <th>Key</th>
                  <th>Actions</th>
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
                      <td className="dbx-mono dbx-muted">{idx + 1}</td>
                      <td className="dbx-mono">
                        {isEditing ? (
                          <input
                            type="text"
                            className="dbx-mono dbx-input-xs"
                            value={editRename}
                            onChange={(e) => setEditRename(e.currentTarget.value)}
                          />
                        ) : renamed ? (
                          <span>
                            <s className="dbx-muted">{col.name}</s> → <strong>{renamed.to}</strong>
                          </span>
                        ) : (
                          <strong>{col.name}</strong>
                        )}
                      </td>
                      <td className="dbx-mono">
                        {isEditing ? (
                          <input
                            type="text"
                            className="dbx-mono dbx-input-xs"
                            value={editType}
                            onChange={(e) => setEditType(e.currentTarget.value)}
                          />
                        ) : (
                          <span className="dbx-type-chip">{altered?.dataType ?? col.dataType}</span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            type="checkbox"
                            checked={editNullable}
                            onChange={(e) => setEditNullable(e.currentTarget.checked)}
                          />
                        ) : (altered?.nullable ?? col.nullable) ? (
                          'NULL'
                        ) : (
                          'NOT NULL'
                        )}
                      </td>
                      <td className="dbx-mono dbx-muted">
                        {isEditing ? (
                          <input
                            type="text"
                            className="dbx-mono dbx-input-xs"
                            value={editDefault}
                            placeholder="NULL"
                            onChange={(e) => setEditDefault(e.currentTarget.value)}
                          />
                        ) : (
                          (altered !== undefined ? altered.defaultValue : col.defaultValue) ?? '—'
                        )}
                      </td>
                      <td>
                        {col.isPrimaryKey && <span className="dbx-badge-pk">PK</span>}
                        {col.isAutoIncrement && <span className="dbx-tag dbx-mono">AUTO</span>}
                      </td>
                      <td className="dbx-cell-actions">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              className="dbx-btn dbx-btn-primary dbx-btn-xs"
                              onClick={() => handleSaveColumnEdit(col.name)}
                            >
                              {t('Save')}
                            </button>
                            <button
                              type="button"
                              className="dbx-btn dbx-btn-ghost dbx-btn-xs"
                              onClick={() => setEditingCol(null)}
                            >
                              {t('Cancel')}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="dbx-btn dbx-btn-ghost dbx-btn-xs"
                              disabled={dropped}
                              onClick={() => {
                                setEditingCol(col.name);
                                setEditRename(renamed?.to ?? col.name);
                                setEditType(altered?.dataType ?? col.dataType);
                                setEditNullable(altered?.nullable ?? col.nullable);
                                setEditDefault((altered !== undefined ? altered.defaultValue : col.defaultValue) ?? '');
                              }}
                            >
                              {t('Edit')}
                            </button>
                            <button
                              type="button"
                              className={`dbx-btn dbx-btn-xs ${dropped ? 'dbx-btn-secondary' : 'dbx-btn-ghost dbx-text-danger'}`}
                              onClick={() => handleToggleDropColumn(col.name)}
                            >
                              {dropped ? 'Undo' : 'Drop'}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {/* Staged Added Columns */}
                {(diff.addColumns ?? []).map((col, idx) => (
                  <tr key={`add-${idx}`} className="is-added-row">
                    <td className="dbx-mono">+</td>
                    <td className="dbx-mono">
                      <strong>{col.name}</strong>
                    </td>
                    <td className="dbx-mono">
                      <span className="dbx-type-chip">{col.dataType}</span>
                    </td>
                    <td>{col.nullable === false ? 'NOT NULL' : 'NULL'}</td>
                    <td className="dbx-mono">{col.defaultValue ?? '—'}</td>
                    <td>
                      <span className="dbx-tag dbx-tag-ok">NEW</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="dbx-btn dbx-btn-ghost dbx-btn-xs"
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
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Add Column Form */}
            <form className="dbx-add-row-form" onSubmit={handleStageAddColumn}>
              <strong>{t('Add Column')}</strong>
              <div className="dbx-add-row-inputs">
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder="column_name"
                  value={newColName}
                  onChange={(e) => setNewColName(e.currentTarget.value)}
                />
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder="TEXT / INTEGER / VARCHAR(255)"
                  value={newColType}
                  onChange={(e) => setNewColType(e.currentTarget.value)}
                />
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder="Default (optional)"
                  value={newColDefault}
                  onChange={(e) => setNewColDefault(e.currentTarget.value)}
                />
                <label className="dbx-checkbox-row">
                  <input
                    type="checkbox"
                    checked={newColNullable}
                    onChange={(e) => setNewColNullable(e.currentTarget.checked)}
                  />
                  <span>Nullable</span>
                </label>
                <button
                  type="submit"
                  className="dbx-btn dbx-btn-secondary dbx-btn-sm"
                  disabled={!newColName.trim() || !newColType.trim()}
                >
                  <Icon name="plus" />
                  Stage
                </button>
              </div>
            </form>
          </div>
        ) : tab.activeSubTab === 'indexes' ? (
          <div className="dbx-structure-scroll">
            <table className="dbx-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Columns</th>
                  <th>Type</th>
                  <th>Unique</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {structure.indexes.map((idx) => {
                  const dropped = (diff.dropIndexes ?? []).includes(idx.name);
                  return (
                    <tr key={idx.name} className={dropped ? 'is-dropped-row' : ''}>
                      <td className="dbx-mono">
                        <strong>{idx.name}</strong>
                        {idx.primary && <span className="dbx-badge-pk">PK</span>}
                      </td>
                      <td className="dbx-mono">{idx.columns.join(', ')}</td>
                      <td className="dbx-mono dbx-muted">{idx.type || 'BTREE'}</td>
                      <td>{idx.unique ? 'UNIQUE' : 'No'}</td>
                      <td>
                        {!idx.primary && (
                          <button
                            type="button"
                            className="dbx-btn dbx-btn-ghost dbx-btn-xs dbx-text-danger"
                            onClick={() => handleToggleDropIndex(idx.name)}
                          >
                            {dropped ? 'Undo' : 'Drop'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {(diff.addIndexes ?? []).map((idx, i) => (
                  <tr key={`new-idx-${i}`} className="is-added-row">
                    <td className="dbx-mono">
                      <strong>{idx.name}</strong> <span className="dbx-tag dbx-tag-ok">NEW</span>
                    </td>
                    <td className="dbx-mono">{idx.columns.join(', ')}</td>
                    <td className="dbx-mono">INDEX</td>
                    <td>{idx.unique ? 'UNIQUE' : 'No'}</td>
                    <td>
                      <button
                        type="button"
                        className="dbx-btn dbx-btn-ghost dbx-btn-xs"
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
                  </tr>
                ))}
              </tbody>
            </table>

            <form className="dbx-add-row-form" onSubmit={handleStageAddIndex}>
              <strong>{t('Add Index')}</strong>
              <div className="dbx-add-row-inputs">
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder={`idx_${tab.table}_col`}
                  value={newIdxName}
                  onChange={(e) => setNewIdxName(e.currentTarget.value)}
                />
                <input
                  type="text"
                  className="dbx-mono"
                  placeholder="col1, col2"
                  value={newIdxCols}
                  onChange={(e) => setNewIdxCols(e.currentTarget.value)}
                />
                <label className="dbx-checkbox-row">
                  <input
                    type="checkbox"
                    checked={newIdxUnique}
                    onChange={(e) => setNewIdxUnique(e.currentTarget.checked)}
                  />
                  <span>Unique</span>
                </label>
                <button
                  type="submit"
                  className="dbx-btn dbx-btn-secondary dbx-btn-sm"
                  disabled={!newIdxName.trim() || !newIdxCols.trim()}
                >
                  <Icon name="plus" />
                  Stage
                </button>
              </div>
            </form>
          </div>
        ) : tab.activeSubTab === 'fks' ? (
          <div className="dbx-structure-scroll">
            <table className="dbx-table">
              <thead>
                <tr>
                  <th>Constraint</th>
                  <th>Columns</th>
                  <th>References</th>
                  <th>ON UPDATE</th>
                  <th>ON DELETE</th>
                </tr>
              </thead>
              <tbody>
                {structure.foreignKeys.map((fk) => (
                  <tr key={fk.name}>
                    <td className="dbx-mono">
                      <strong>{fk.name}</strong>
                    </td>
                    <td className="dbx-mono">{fk.columns.join(', ')}</td>
                    <td className="dbx-mono">{`${fk.referencedTable}(${fk.referencedColumns.join(', ')})`}</td>
                    <td className="dbx-mono dbx-muted">{fk.onUpdate || 'NO ACTION'}</td>
                    <td className="dbx-mono dbx-muted">{fk.onDelete || 'NO ACTION'}</td>
                  </tr>
                ))}
                {structure.foreignKeys.length === 0 && (
                  <tr>
                    <td colSpan={5} className="dbx-table-empty">
                      No foreign keys defined on this table.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : tab.activeSubTab === 'triggers' ? (
          <div className="dbx-structure-scroll">
            <table className="dbx-table">
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
                    <td className="dbx-mono">
                      <strong>{tr.name}</strong>
                    </td>
                    <td className="dbx-mono">{tr.timing || '—'}</td>
                    <td className="dbx-mono">{tr.event || '—'}</td>
                    <td className="dbx-mono dbx-muted">{tr.definition || '—'}</td>
                  </tr>
                ))}
                {tab.triggers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dbx-table-empty">
                      No triggers on this table.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dbx-editor-host">
            <PluginCodeEditor
              value={structure.createDdl || '-- DDL not available'}
              language={engineToMonacoLanguage(session.connection.engine)}
              readOnly
              wordWrap="on"
            />
          </div>
        )}

        {/* Pending ALTER DDL Bar */}
        {pending && (
          <div className="dbx-pending-bar">
            <div className="dbx-pending-summary">
              <span className="dbx-pending-dot" />
              <strong>Staged ALTER changes</strong>
            </div>
            <div className="dbx-pending-actions">
              <button
                type="button"
                className="dbx-btn dbx-btn-secondary dbx-btn-sm"
                onClick={() => onPreviewAlter(diff)}
              >
                <Icon name="file-code" />
                {t('Preview ALTER DDL')}
              </button>
              <button
                type="button"
                className="dbx-btn dbx-btn-ghost dbx-btn-sm"
                onClick={() => updateDiff({})}
              >
                {t('Discard')}
              </button>
              <button
                type="button"
                className="dbx-btn dbx-btn-primary dbx-btn-sm"
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
