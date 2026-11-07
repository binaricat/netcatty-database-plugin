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
  const [cellPage, setCellPage] = useState(0);
  const rows = resultRows(result.rows, filter, sort, descending);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const colPage = Math.min(columnPage, Math.max(0, Math.ceil(result.columns.length / 8) - 1));
  const start = colPage * 8;
  const cell = selected ? result.rows[selected.row]?.[selected.column] : undefined;
  const cellText = (cell === null ? 'NULL' : String(cell ?? '')).replaceAll('\0', '\\0');
  const cellOffset = Math.min(cellPage, Math.max(0, Math.ceil(cellText.length / 4000)-1)) * 4000;
  return <>
    <div className="result-controls">
      <input aria-label={t('Filter returned rows')} placeholder={t('Filter returned rows')} title={t('Returned rows only; not a database filter.')} maxLength={128} value={filter} onChange={e => { setFilter(e.currentTarget.value); setPage(0); }} />
      <span className="result-controls-spacer" />
      <div className="result-page-group"><button className="toolbar-button" aria-label={t('Previous rows')} title={t('Previous rows')} disabled={current === 0} onClick={() => setPage(current - 1)}>‹</button><span>{t('Page {page} / {pages}', {page: current + 1, pages: Math.max(1, Math.ceil(rows.length / 20))})}</span><button className="toolbar-button" aria-label={t('Next rows')} title={t('Next rows')} disabled={(current + 1) * 20 >= rows.length} onClick={() => setPage(current + 1)}>›</button></div>
      {result.columns.length > 8 && <div className="result-page-group"><button className="toolbar-button" aria-label={t('Previous columns')} title={t('Previous columns')} disabled={colPage === 0} onClick={() => setColumnPage(colPage - 1)}>‹</button><span>{t('Columns')} {start + 1}–{Math.min(start + 8, result.columns.length)} / {result.columns.length}</span><button className="toolbar-button" aria-label={t('Next columns')} title={t('Next columns')} disabled={start + 8 >= result.columns.length} onClick={() => setColumnPage(colPage + 1)}>›</button></div>}
    </div>
    <div className="table-scroll"><table><thead><tr><th>#</th>{result.columns.slice(start,start+8).map((name, offset) => <th key={offset}><button className="cell-value" onClick={() => { const col = start + offset; setDescending(sort === col ? !descending : false); setSort(col); setPage(0); }}>{name}{sort === start + offset ? descending ? ' ↓' : ' ↑' : ''}</button>{columnTypes?.find(c=>c.name===name)?.type && <small className="result-type">{columnTypes.find(c=>c.name===name)!.type}</small>}</th>)}</tr></thead><tbody>{rows.slice(current*20,current*20+20).map(({row,index}) => <tr key={index}><td>{index+1}</td>{row.slice(start,start+8).map((value, offset) => <td key={offset} className={value===null || value==='' ? "null-cell" : typeof value==='number' ? "number-cell" : undefined}><button className="cell-value" aria-label={t('Inspect row {row}, column {column}',{row:index+1,column:start+offset+1})} onClick={() => {setSelected({row:index,column:start+offset});setCellPage(0);}}>{value === null ? 'NULL' : value === '' ? t('Empty string') : String(value).slice(0,256) + (String(value).length > 256 ? '…' : '')}</button></td>)}</tr>)}</tbody></table>{!rows.length && <p>{t('No rows returned. Try a different filter.')}</p>}</div>
    {selected && <section className="cell-inspector" aria-label={t('Cell inspector')}><div className="results-heading"><strong>{t('Cell inspector')} · {result.columns[selected.column]} · {cell === null ? 'NULL' : typeof cell}</strong><button onClick={() => setSelected(null)}>{t('Close')}</button></div><textarea aria-label={t('Full cell value')} readOnly value={cellText.slice(cellOffset,cellOffset+4000)} rows={6} />{cellText.length>4000 && <div className="result-page-group"><button className="toolbar-button" disabled={cellOffset===0} onClick={()=>setCellPage(cellPage-1)}>{t("Previous")}</button><span>{cellOffset+1}–{Math.min(cellOffset+4000,cellText.length)} / {cellText.length}</span><button className="toolbar-button" disabled={cellOffset+4000>=cellText.length} onClick={()=>setCellPage(cellPage+1)}>{t("Next")}</button></div>}</section>}
  </>;
}
