import type {Database} from 'sql.js';
export type ExplainScalar=string|number|boolean|null;
export interface SqliteExplainDraft{table:string;columns:string[];where?:Array<{column:string;operator:'='|'<'|'>'|'IS';value:ExplainScalar}>;orderBy?:Array<{column:string;direction:'ASC'|'DESC'}>;limit?:number}
export interface SqlitePlanNode{id:number;parent:number;auxiliary:number;detail:string}
export class SqliteExplainError extends Error{constructor(readonly code:'input'|'table'|'column'|'protection'|'budget'|'plan'|'engine'){super(`SQLite estimated plan ${code}`);}}
const fail=(code:SqliteExplainError['code']):never=>{throw new SqliteExplainError(code);};
const bytes=(s:string)=>new TextEncoder().encode(s).length;
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!v.includes('\0')&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const object=(v:unknown,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
function scalar(v:unknown):v is ExplainScalar{return v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v))||typeof v==='string'&&(v===''||text(v,2048));}
/** Structured source only: raw SQL/WITH/expressions are not accepted. */
export function buildSqliteExplainSource(input:SqliteExplainDraft){
 if(!object(input,['table','columns','where','orderBy','limit'])||!text(input.table,128)||/^sqlite_/i.test(input.table))fail('input');
 if(!Array.isArray(input.columns)||!input.columns.length||input.columns.length>32||input.columns.some(c=>!text(c,128))||new Set(input.columns).size!==input.columns.length)fail('column');
 const where=input.where??[],order=input.orderBy??[],limit=input.limit??100;
 if(!Array.isArray(where)||where.length>8||!Array.isArray(order)||order.length>2||!Number.isInteger(limit)||limit<1||limit>100)fail('input');
 for(const w of where)if(!object(w,['column','operator','value'])||!text(w.column,128)||!['=','<','>','IS'].includes(w.operator)||!scalar(w.value))fail('input');
 for(const o of order)if(!object(o,['column','direction'])||!text(o.column,128)||!['ASC','DESC'].includes(o.direction))fail('input');
 const draft:SqliteExplainDraft={table:input.table,columns:[...input.columns],where:where.map(w=>({...w})),orderBy:order.map(o=>({...o})),limit};
 const sourceSql=`SELECT ${draft.columns.map(q).join(', ')} FROM "main".${q(draft.table)}${where.length?' WHERE '+where.map(w=>`${q(w.column)} ${w.operator} ?`).join(' AND '):''}${order.length?' ORDER BY '+order.map(o=>`${q(o.column)} ${o.direction}`).join(', '):''} LIMIT ${limit};`;
 if(bytes(sourceSql)>8192)fail('budget');return {draft,sourceSql,parameters:where.map(w=>w.value)};
}
/** Structural parser only. Plan details are opaque engine descriptions, not SQL
 * instructions or measured cost. Reject broken/cyclic/missing-parent trees. */
export function parseSqliteExplainNodes(rows:readonly (readonly unknown[])[]):SqlitePlanNode[]{
 if(!Array.isArray(rows)||rows.length<1||rows.length>128)fail('budget');let total=0;const ids=new Set<number>();
 const nodes=rows.map(r=>{if(!Array.isArray(r)||r.length!==4)fail('plan');const [id,parent,unused,detail]=r;
  if(typeof id!=='number'||!Number.isSafeInteger(id)||id<=0||typeof parent!=='number'||!Number.isSafeInteger(parent)||parent<0||typeof unused!=='number'||!Number.isSafeInteger(unused)||unused<0||!text(detail,2048)||ids.has(id))fail('plan');ids.add(id as number);total+=bytes(detail as string);if(total>32768)fail('budget');return {id:id as number,parent:parent as number,auxiliary:unused as number,detail:detail as string};});
 const map=new Map(nodes.map(n=>[n.id,n]));for(const node of nodes){let cursor=node,depth=0;const seen=new Set<number>();while(cursor.parent!==0){if(seen.has(cursor.id)||++depth>16)fail('plan');seen.add(cursor.id);const parent=map.get(cursor.parent);if(!parent)fail('plan');cursor=parent!;}}
 return nodes;
}
/** Stock plugin-owned SQL.js only; no user-defined functions/extensions. Caller
 * supplies its exclusive live connection. This function never executes sourceSql
 * or changes PRAGMAs, transactions, storage, rows, indexes or schema. */
export function explainSqliteProjection(db:Database,input:SqliteExplainDraft){
 const source=buildSqliteExplainSource(input);
 const query=(sql:string,parameters:string[]=[],max=128)=>{const statement=db.prepare(sql);const rows:unknown[][]=[];try{statement.bind(parameters);while(statement.step()){if(rows.length>=max)fail('budget');rows.push(statement.get());}return rows;}finally{statement.free();}};
 try{
  for(const [pragma,value] of [['query_only',1],['foreign_keys',1],['trusted_schema',0]] as const)if(query(`PRAGMA ${pragma}`)[0]?.[0]!==value)fail('protection');
  if(query('SELECT name FROM temp.sqlite_schema',[],1).length)fail('table');
  const tables=query("SELECT type FROM pragma_table_list WHERE schema='main' AND name=? COLLATE BINARY",[source.draft.table],1);if(tables.length!==1||tables[0][0]!=='table')fail('table');
  const columns=query("SELECT name,hidden FROM pragma_table_xinfo(?, 'main')",[source.draft.table],64);if(!columns.length||columns.some(c=>c[1]!==0))fail('table');const names=new Set(columns.map(c=>c[0]));
  for(const n of [...source.draft.columns,...source.draft.where!.map(w=>w.column),...source.draft.orderBy!.map(o=>o.column)])if(!names.has(n))fail('column');
  const revision=query('PRAGMA main.schema_version')[0]?.[0];if(typeof revision!=='number'||!Number.isSafeInteger(revision))fail('engine');
  const statement=db.prepare('EXPLAIN QUERY PLAN '+source.sourceSql);let nodes:SqlitePlanNode[];try{statement.bind(source.parameters.map(v=>typeof v==='boolean'?Number(v):v));if(JSON.stringify(statement.getColumnNames())!==JSON.stringify(['id','parent','notused','detail']))fail('plan');const rows:unknown[][]=[];while(statement.step()){if(rows.length>=128)fail('budget');rows.push(statement.get());}nodes=parseSqliteExplainNodes(rows);}finally{statement.free();}
  return {sourceSql:source.sourceSql,parameters:[...source.parameters],schemaRevision:revision,nodes,estimatedOnly:true as const,scope:'structured-single-table-projection' as const};
 }catch(error){if(error instanceof SqliteExplainError)throw error;throw new SqliteExplainError('engine');}
}
