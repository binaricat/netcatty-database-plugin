import React, { useMemo, useRef, useState } from 'react';
import type { WorkbenchContext } from './databaseClient';
import type { DatabaseQueryResult } from './databaseTypes';
import type { Translate, Message } from './i18n';
import { exportQueryResult, type ResultExportFormat } from './resultExportModel';
export const EXPORT_CLIPBOARD_BYTES = 4096;
/** Pages are display fragments, never separate exports. Do not split UTF-16 pairs. */
export function exportPreviewPages(text: string): string[] {
  text = text.replaceAll('\0', '\\0');
  const pages: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length,start+4000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
    pages.push(text.slice(start,end));start=end;
  }
  return pages.length ? pages : [''];
}
export function ResultExport({result,context,t}:{result:DatabaseQueryResult;context:WorkbenchContext;t:Translate}) {
  const [format,setFormat] = useState<ResultExportFormat>('csv');
  const [tableName,setTableName] = useState('');
  const [page,setPage] = useState(0);
  const [busy,setBusy] = useState(false);
  const [feedback,setFeedback] = useState<{text:string;source:string}|null>(null);
  const locked = useRef(false);
  const output = useMemo(()=>{
    try { return {value:exportQueryResult(result,{format,...(format==='sql'?{tableName}: {})}),error:''}; }
    catch(e) { return {value:null,error:e instanceof Error?e.message:String(e)}; }
  },[result,format,tableName]);
  const text=output.value?.text??'';
  const size=new TextEncoder().encode(text).length;
  const containsNul=text.includes('\0');
  const pages=useMemo(()=>exportPreviewPages(text),[text]);
  const current=Math.min(page,pages.length-1);
  const copy=async()=>{
    if(locked.current||!output.value||containsNul||size>EXPORT_CLIPBOARD_BYTES)return;
    locked.current=true;setBusy(true);setFeedback(null);
    const source=text;
    try {
      const copied=await context.clipboard.writeText(source,t('Copy returned result'));
      setFeedback({source,text:t(copied?'Export copied.':'Copy cancelled. No clipboard change was confirmed.')});
    } catch(e) {
      setFeedback({source,text:t('Copy failed: {message}',{message:(e instanceof Error?e.message:String(e)).slice(0,512)})});
    } finally {locked.current=false;setBusy(false);}
  };
  return <details className="result-export"><summary>{t('Export returned result')}</summary>
    <p className="hint">{t('Only returned rows are exported, not the whole table.')}</p>
    {result.truncated&&<p role="status">{t('The query result was truncated upstream; omitted data is not included.')}</p>}
    <label>{t('Export format')}<select aria-label={t('Export format')} value={format} disabled={busy} onChange={e=>{setFormat(e.currentTarget.value as ResultExportFormat);setPage(0);setFeedback(null);}}><option value="csv">CSV</option><option value="json">JSON</option><option value="markdown">Markdown</option><option value="sql">SQL INSERT</option></select></label>
    {format==='sql'&&<label>{t('Destination table name')}<input aria-label={t('Destination table name')} value={tableName} maxLength={256} disabled={busy} onChange={e=>{setTableName(e.currentTarget.value);setPage(0);setFeedback(null);}} /></label>}
    {output.error&&<p role="alert">{output.error}</p>}
    {output.value&&<div key={format} className="export-output">
      <button className="secondary toolbar-button" disabled={busy||containsNul||size>EXPORT_CLIPBOARD_BYTES} onClick={()=>void copy()}>{t('Copy complete returned result')}</button>

      {output.value.notes.filter(note=>note!=='Only returned rows are exported, not the whole table.'&&note!=='The query result was truncated upstream; omitted data is not included.').map(note=><p className="hint" key={note}>{t(note as Message)}</p>)}
      {containsNul&&<p className="hint">{t('NUL characters are displayed as \\0 in this preview only. Original export is unchanged; choose JSON to copy safely.')}</p>}
      <p>{t('Preview part {page} of {pages}; each part is not a complete export.',{page:current+1,pages:pages.length})}</p>
      <textarea aria-label={t('Export preview part')} readOnly rows={6} value={pages[current]} />
      <div className="results-heading"><button className="secondary" disabled={current===0} onClick={()=>setPage(current-1)}>{t('Previous')}</button><span>{t('{rows} returned rows · {bytes} UTF-8 bytes',{rows:output.value.rowCount,bytes:size})}</span><button className="secondary" disabled={current+1===pages.length} onClick={()=>setPage(current+1)}>{t('Next')}</button></div>
      {size>EXPORT_CLIPBOARD_BYTES&&<p className="hint">{t('Copy exceeds the 4096-byte host limit. Select preview text manually; multiple parts must be combined in order. Nothing is silently truncated.')}</p>}
    </div>}
    {feedback?.source===text&&<p role="status">{feedback.text}</p>}
  </details>;
}
