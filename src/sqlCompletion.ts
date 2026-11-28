import type { DatabaseSchemaResult } from './databaseTypes';
export interface SqlCompletion { kind: 'keyword' | 'table' | 'column'; label: string; insertText: string; from: number; to: number; detail?: string; }
export const SQL_COMPLETION_LIMIT = 12;
const keywords = ['SELECT','FROM','WHERE','JOIN','LEFT JOIN','INNER JOIN','ON','GROUP BY','ORDER BY','HAVING','LIMIT','DISTINCT','AS','AND','OR','IS NULL','INSERT INTO','UPDATE','DELETE FROM','VALUES','SET'];
export function quoteCompletionIdentifier(name: string): string { return '"' + name.replaceAll('"','""') + '"'; }
interface Token { value: string; start: number; end: number; identifier: boolean; }
/** Shallow lexical scan, never runs SQL. A caret in a comment/string/quoted name is suppressed. */
function scan(sql: string): { tokens: Token[]; blocked: boolean } {
  const tokens: Token[]=[]; let i=0;
  while(i<sql.length) {
    if (/\s/.test(sql[i])) {i++;continue;}
    if(sql.startsWith('--',i)) {const end=sql.indexOf('\n',i+2);if(end<0)return {tokens,blocked:true};i=end+1;continue;}
    if(sql.startsWith('/*',i)) {const end=sql.indexOf('*/',i+2);if(end<0)return {tokens,blocked:true};i=end+2;continue;}
    const start=i; const char=sql[i];
    if (char==="'" || char==='"' || char==='`' || char==='[') {
      const close=char==='['?']':char; let value=''; let finished=false; i++;
      while(i<sql.length) { if(sql[i]===close) {if(char!=='['&&sql[i+1]===close){value+=close;i+=2;continue;}i++;finished=true;break;}value+=sql[i++]; }
      if(!finished)return {tokens,blocked:true};
      // String literals are opaque tokens so aliases cannot be inferred across them.
      tokens.push({value:char==="'"?'':value,start,end:i,identifier:char!=="'"});continue;
    }
    const match=/^[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9$\u0080-\uFFFF]*/.exec(sql.slice(i));
    if(match){i+=match[0].length;tokens.push({value:match[0],start,end:i,identifier:true});}
    else {i++;tokens.push({value:char,start,end:i,identifier:false});}
  }
  return {tokens,blocked:false};
}
const reserved = new Set(['WHERE','JOIN','LEFT','RIGHT','FULL','INNER','OUTER','CROSS','ON','USING','GROUP','ORDER','HAVING','LIMIT','OFFSET','UNION','INTERSECT','EXCEPT','SET','VALUES','RETURNING','AS']);
/** Suggestions only. Supports one shallow statement, FROM/JOIN table aliases and alias.column.
 * Not a SQL parser: CTEs, nested queries, alias shadowing and attached-schema resolution
 * intentionally return no suggestions rather than inventing scope. Replacement offsets
 * cover the complete unquoted identifier under the caret, never punctuation or SQL.
 */
export function completeSql(sql: string, caret: number, schema: DatabaseSchemaResult): SqlCompletion[] {
  if(sql.length>8192||!Number.isInteger(caret)||caret<0||caret>sql.length||schema.tables.length>32)return [];
  const {tokens,blocked}=scan(sql.slice(0,caret));if(blocked)return [];
  const boundary=tokens.map(t=>t.value).lastIndexOf(';');const current=tokens.slice(boundary+1);
  // Unsupported scopes are suppressed, including a second SELECT in a subquery.
  if(current.some(t=>t.value==='('||t.value.toUpperCase()==='WITH') || current.filter(t=>t.identifier&&t.value.toUpperCase()==='SELECT').length>1)return [];
  const last=current.at(-1);
  const isPrefix=Boolean(last?.identifier&&last.end===caret&& !['"','`','['].includes(sql[last.start]));
  const prefix=isPrefix?last!.value:'';const from=isPrefix?last!.start:caret;
  const suffix=/^[A-Za-z_0-9$\u0080-\uFFFF]*/.exec(sql.slice(caret))![0];const to=caret+suffix.length;
  const before=isPrefix?current.slice(0,-1):current;
  const aliases=new Map<string, DatabaseSchemaResult['tables'][number]>();const referenced:DatabaseSchemaResult['tables']=[];
  for(let i=0;i<before.length;i++) {
    if(!['FROM','JOIN','UPDATE','INTO'].includes(before[i].value.toUpperCase()))continue;
    const tableToken=before[i+1];if(!tableToken?.identifier)continue;
    // Qualified table names require schema resolution that this model does not attempt.
    if(before[i+2]?.value==='.')return [];
    const table=schema.tables.find(t=>t.name.toLowerCase()===tableToken.value.toLowerCase());if(!table)continue;
    if (aliases.has(table.name.toLowerCase()) && aliases.get(table.name.toLowerCase()) !== table) return [];
    aliases.set(table.name.toLowerCase(),table);if(!referenced.includes(table))referenced.push(table);
    let alias=before[i+2];if(alias?.value.toUpperCase()==='AS')alias=before[i+3];
    if(alias?.identifier&&!reserved.has(alias.value.toUpperCase())) {
      const key=alias.value.toLowerCase();if(aliases.has(key)&&aliases.get(key)!==table)return [];aliases.set(key,table);
    }
  }
  const results: SqlCompletion[]=[];const seen=new Set<string>();
  const add=(kind:SqlCompletion['kind'],name:string,detail?:string)=>{
    if(results.length>=SQL_COMPLETION_LIMIT||name.length>256||!name.toLowerCase().startsWith(prefix.toLowerCase()))return;
    const key=`${kind}:${name}:${detail??''}`;if(seen.has(key))return;seen.add(key);
    results.push({kind,label:name,insertText:kind==='keyword'?name:quoteCompletionIdentifier(name),from,to,...(detail?{detail}:{})});
  };
  if(before.at(-1)?.value==='.') {
    const qualifier=before.at(-2);if(!qualifier?.identifier)return [];
    const table=aliases.get(qualifier.value.toLowerCase());if(!table)return [];
    for(const column of table.columns.slice(0,64))add('column',column.name,table.name);return results;
  }
  const tableContext=['FROM','JOIN','UPDATE','INTO'].includes(before.at(-1)?.value.toUpperCase()??'');
  if(tableContext){for(const table of schema.tables)add('table',table.name);return results;}
  // Prefer columns from referenced tables; no claim that SELECT-before-FROM is resolved.
  for(const table of referenced)for(const column of table.columns.slice(0,64))add('column',column.name,table.name);
  for(const keyword of keywords)add('keyword',keyword);
  if(prefix)for(const table of schema.tables)add('table',table.name);
  return results;
}
