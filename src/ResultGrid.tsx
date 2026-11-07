import React, { useState } from 'react';
import type { DatabaseQueryResult } from './databaseTypes';
import type { Translate } from './i18n';
import { resultRows } from './resultGridModel';
export function ResultGrid({ result, t, columnTypes }: { result: DatabaseQueryResult; t: Translate; columnTypes?: {name:string;type:string}[] }) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const [sort, setSort] = useState<number | null>(null);
  const [descending, setDescending] = useState(false);
  const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
  const rows = resultRows(result.rows, filter, sort, descending);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const colPage = Math.min(columnPage, Math.max(0, Math.ceil(result.columns.length / 8) - 1));
  const start = colPage * 8;
  const cell = selected ? result.rows[selected.row]?.[selected.column] : undefined;
  return <>
    <div className="result-filter"><label>{t('Filter returned rows')}<input aria-label={t('Filter returned rows')} maxLength={128} value={filter} onChange={e => { setFilter(e.currentTarget.value); setPage(0); }} /></label><span>{t('Returned rows only; not a database filter.')}</span></div>
    <div className="result-pagination"><button className="secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>{t('Previous rows')}</button><span>{t('Page {page} / {pages}', {page: current + 1, pages: Math.max(1, Math.ceil(rows.length / 20))})}</span><button className="secondary" disabled={(current + 1) * 20 >= rows.length} onClick={() => setPage(current + 1)}>{t('Next rows')}</button><button className="secondary" disabled={colPage === 0} onClick={() => setColumnPage(colPage - 1)}>{t('Previous columns')}</button><span>{start + 1}–{Math.min(start + 8, result.columns.length)} / {result.columns.length}</span><button className="secondary" disabled={start + 8 >= result.columns.length} onClick={() => setColumnPage(colPage + 1)}>{t('Next columns')}</button></div>
    <div className="table-scroll"><table><thead><tr><th>#</th>{result.columns.slice(start,start+8).map((name, offset) => <th key={offset}><button className="cell-value" onClick={() => { const col = start + offset; setDescending(sort === col ? !descending : false); setSort(col); setPage(0); }}>{name}{sort === start + offset ? descending ? ' ↓' : ' ↑' : ''}</button><small className="result-type">{columnTypes?.find(c=>c.name===name)?.type || '—'}</small></th>)}</tr></thead><tbody>{rows.slice(current*20,current*20+20).map(({row,index}) => <tr key={index}><td>{index+1}</td>{row.slice(start,start+8).map((value, offset) => <td key={offset} className={value===null || value==='' ? "null-cell" : typeof value==='number' ? "number-cell" : undefined}><button className="cell-value" aria-label={t('Inspect row {row}, column {column}',{row:index+1,column:start+offset+1})} onClick={() => setSelected({row:index,column:start+offset})}>{value === null ? 'NULL' : value === '' ? t('Empty string') : String(value).slice(0,256) + (String(value).length > 256 ? '…' : '')}</button></td>)}</tr>)}</tbody></table>{!rows.length && <p>{t('No rows returned. Try a different filter.')}</p>}</div>
    {selected && <section className="cell-inspector" aria-label={t('Cell inspector')}><div className="results-heading"><strong>{t('Cell inspector')} · {result.columns[selected.column]} · {cell === null ? 'NULL' : typeof cell}</strong><button onClick={() => setSelected(null)}>{t('Close')}</button></div><textarea aria-label={t('Full cell value')} readOnly value={cell === null ? 'NULL' : String(cell ?? '')} rows={6} /></section>}
  </>;
}
