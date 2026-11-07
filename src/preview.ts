import type { DatabaseQueryResult } from '@netcatty/plugin-sdk';
export function previewSummary(result: Pick<DatabaseQueryResult, 'columns' | 'rows' | 'truncated'>) {
  return {
    shownRows: Math.min(result.rows.length, 20), totalRows: result.rows.length,
    shownColumns: Math.min(result.columns.length, 8), totalColumns: result.columns.length,
    clippedCells: result.rows.slice(0, 20).reduce((count, row) => count + row.slice(0, 8).filter(cell => cell !== null && String(cell).length > 256).length, 0),
    hostTruncated: result.truncated,
  };
}
