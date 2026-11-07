import React,{useMemo} from 'react';
import {tokenizeSql} from './sqlDisplay';
/** Read-only SQL, React text nodes only. Never HTML, editable overlay or execution. */
export function SqlPreview({sql,label}:{sql:string;label:string}){
 const tokens=useMemo(()=>tokenizeSql(sql,128),[sql]);
 return <pre className="sql-preview" aria-label={label} tabIndex={0}><code key={sql}>{tokens.map((token,i)=><span key={i} className={token.kind==='plain'?undefined:`sql-${token.kind}`}>{token.text}</span>)}</code></pre>;
}
