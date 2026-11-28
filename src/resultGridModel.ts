import type { DatabaseScalar } from './databaseTypes';
/** Sort/filter only the bounded returned dataset; original row identity is retained. */
export function resultRows(rows: DatabaseScalar[][], filter: string, column: number | null, descending = false) {
  const needle = filter.toLocaleLowerCase();
  const selected = rows.map((row,index) => ({row,index})).filter(({row}) => !needle || row.some(value => (value === null ? 'NULL' : String(value)).toLocaleLowerCase().includes(needle)));
  if (column === null) return selected;
  return selected.sort((a,b) => {
    const x=a.row[column], y=b.row[column];
    const order = x === y ? 0 : x == null ? -1 : y == null ? 1 : typeof x === 'number' && typeof y === 'number' ? x-y : String(x).localeCompare(String(y));
    return (descending ? -order : order) || a.index-b.index;
  });
}
