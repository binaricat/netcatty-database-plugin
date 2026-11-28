/**
 * Pure multi-step Undo / Redo history stack for TableDataTab pending grid edits (P0-4).
 */

import type { GridEditSnapshot } from './types';

const MAX_HISTORY_DEPTH = 50;

export function cloneGridSnapshot(snap: GridEditSnapshot): GridEditSnapshot {
  return {
    dirtyCells: { ...snap.dirtyCells },
    insertedRows: snap.insertedRows.map((row) => ({ ...row })),
    deletedRowIndices: [...snap.deletedRowIndices],
  };
}

export function hasPendingGridEdits(snap: GridEditSnapshot): boolean {
  return (
    Object.keys(snap.dirtyCells).length > 0 ||
    snap.insertedRows.length > 0 ||
    snap.deletedRowIndices.length > 0
  );
}

export function pushGridUndo(
  current: GridEditSnapshot,
  next: GridEditSnapshot,
  undoStack: readonly GridEditSnapshot[],
): {
  current: GridEditSnapshot;
  undoStack: GridEditSnapshot[];
  redoStack: GridEditSnapshot[];
  dirty: boolean;
} {
  const nextUndo = [...undoStack.slice(-(MAX_HISTORY_DEPTH - 1)), cloneGridSnapshot(current)];
  const clonedNext = cloneGridSnapshot(next);
  return {
    current: clonedNext,
    undoStack: nextUndo,
    redoStack: [],
    dirty: hasPendingGridEdits(clonedNext),
  };
}

export function undoGridEdit(
  current: GridEditSnapshot,
  undoStack: readonly GridEditSnapshot[],
  redoStack: readonly GridEditSnapshot[],
): {
  current: GridEditSnapshot;
  undoStack: GridEditSnapshot[];
  redoStack: GridEditSnapshot[];
  dirty: boolean;
} | null {
  if (undoStack.length === 0) return null;
  const previous = cloneGridSnapshot(undoStack[undoStack.length - 1]);
  const nextUndo = undoStack.slice(0, -1);
  const nextRedo = [...redoStack.slice(-(MAX_HISTORY_DEPTH - 1)), cloneGridSnapshot(current)];
  return {
    current: previous,
    undoStack: nextUndo,
    redoStack: nextRedo,
    dirty: hasPendingGridEdits(previous),
  };
}

export function redoGridEdit(
  current: GridEditSnapshot,
  undoStack: readonly GridEditSnapshot[],
  redoStack: readonly GridEditSnapshot[],
): {
  current: GridEditSnapshot;
  undoStack: GridEditSnapshot[];
  redoStack: GridEditSnapshot[];
  dirty: boolean;
} | null {
  if (redoStack.length === 0) return null;
  const next = cloneGridSnapshot(redoStack[redoStack.length - 1]);
  const nextRedo = redoStack.slice(0, -1);
  const nextUndo = [...undoStack.slice(-(MAX_HISTORY_DEPTH - 1)), cloneGridSnapshot(current)];
  return {
    current: next,
    undoStack: nextUndo,
    redoStack: nextRedo,
    dirty: hasPendingGridEdits(next),
  };
}
