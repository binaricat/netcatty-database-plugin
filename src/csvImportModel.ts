import {sqliteSchemaTokens,schemaTokenSequence} from './sqliteSchemaKeywords';
import type {DatabaseScalar,DatabaseSchemaResult} from './databaseTypes';

export interface CsvImportDraft {table:string;csv:string;nullMode:'backslash-N'}
export interface CsvImportPlan {table:string;columns:string[];sql:string;rows:DatabaseScalar[][];rowCount:number;nullRule:'unquoted-backslash-N-only'}
export class CsvImportError extends Error {
  constructor(readonly code:'input'|'csv'|'table'|'columns'|'value'|'budget'){super(`CSV import ${code}`);}
}
type Cell={text:string;quoted:boolean};
const fold=(value:string)=>value.replace(/[A-Z]/g,c=>c.toLowerCase());
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const validName=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!value.includes('\0')&&!/^sqlite_/i.test(value);
/** RFC4180 quote grammar, accepting LF as well as CRLF record separators.
 * Bare CR separators, BOM, trailing junk after quotes and unclosed quotes reject.
 */
function parse(csv:string):Cell[][] {
  const records:Cell[][]=[];let row:Cell[]=[],i=0;
  while(i<csv.length){
    let text='',quoted=false;
    if(csv[i]==='"'){
      quoted=true;i++;let closed=false;
      while(i<csv.length){
        if(csv[i]==='"'){if(csv[i+1]==='"'){text+='"';i+=2;}else{i++;closed=true;break;}}
        else{text+=csv[i++];}
        if(text.length>2048)throw new CsvImportError('budget');
      }
      if(!closed)throw new CsvImportError('csv');
      if(i<csv.length&&!['\r','\n',','].includes(csv[i]))throw new CsvImportError('csv');
    }else{
      while(i<csv.length&&!['\r','\n',','].includes(csv[i])){
        if(csv[i]==='"')throw new CsvImportError('csv');text+=csv[i++];
        if(text.length>2048)throw new CsvImportError('budget');
      }
    }
    row.push({text,quoted});if(row.length>16)throw new CsvImportError('budget');
    if(csv[i]===','){i++;if(i===csv.length){row.push({text:'',quoted:false});if(row.length>16)throw new CsvImportError('budget');}else continue;}
    if(csv[i]==='\r'){if(csv[i+1]!=='\n')throw new CsvImportError('csv');i+=2;}
    else if(csv[i]==='\n')i++;
    records.push(row);row=[];if(records.length>101)throw new CsvImportError('budget');
  }
  return records;
}
/** Pure bounded plan; never executes or interprets cell text as SQL. Headers must
 * cover every actual column, so omitted columns cannot invoke SQL defaults or
 * default expressions. The applying adapter must revalidate schema, review and
 * triggers/constraints, and commit all rows atomically or roll back all of them.
 */
export function previewCsvImport(input:unknown,schema:DatabaseSchemaResult):CsvImportPlan {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new CsvImportError('input');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['table','csv','nullMode'].includes(key))||!validName(value.table)||typeof value.csv!=='string'||value.nullMode!=='backslash-N')throw new CsvImportError('input');
  const csv=value.csv;if(new TextEncoder().encode(csv).length>65536)throw new CsvImportError('budget');
  if(!csv||csv.includes('\0')||csv.charCodeAt(0)===0xfeff)throw new CsvImportError('csv');
  if(!schema||!Array.isArray(schema.tables)||schema.tables.length>32)throw new CsvImportError('table');
  const matches=schema.tables.filter(table=>typeof table?.name==='string'&&fold(table.name)===fold(value.table as string));
  if(matches.length!==1||matches[0].kind!=='table')throw new CsvImportError('table');
  const table=matches[0];
  if(typeof table.definition!=='string'||!table.definition.trim())throw new CsvImportError('table');
  let schemaTokens:string[];try{schemaTokens=sqliteSchemaTokens(table.definition);}catch{throw new CsvImportError('table');}
  if(schemaTokens[0]!=='CREATE'||schemaTokens[1]!=='TABLE'||schemaTokens.length<5||!schemaTokens.includes('(')||!schemaTokens.includes(')'))throw new CsvImportError('table');
  let depth=0;for(const token of schemaTokens){if(token==='(')depth++;else if(token===')'&&--depth<0)throw new CsvImportError('table');}
  if(depth!==0||schemaTokens[schemaTokens.indexOf('(')+1]===')')throw new CsvImportError('table');
  if(!Array.isArray(table.triggers)||table.triggers.length||(schemaTokenSequence(schemaTokens,'CREATE','VIRTUAL','TABLE')||schemaTokens.includes('DEFAULT')||schemaTokens.includes('GENERATED')||schemaTokenSequence(schemaTokens,'ON','CONFLICT')))throw new CsvImportError('table');
  if(!validName(table.name)||!Array.isArray(table.columns)||!table.columns.length||table.columns.length>16)throw new CsvImportError('columns');
  const seen=new Set<string>();
  for(const column of table.columns){
    if(!column||!validName(column.name)||seen.has(fold(column.name))||typeof column.type!=='string'||!['INTEGER','REAL','TEXT','NUMERIC'].includes(column.type.trim().toUpperCase())||typeof column.nullable!=='boolean'||typeof column.primaryKey!=='boolean')throw new CsvImportError('columns');
    seen.add(fold(column.name));
  }
  const records=parse(csv);if(records.length<2)throw new CsvImportError('csv');
  const header=records[0];if(header.length!==table.columns.length)throw new CsvImportError('columns');
  const positions=new Map<string,number>();
  header.forEach((cell,index)=>{const key=fold(cell.text);if(!validName(cell.text)||!seen.has(key)||positions.has(key))throw new CsvImportError('columns');positions.set(key,index);});
  const rows=records.slice(1).map(record=>{
    if(record.length!==header.length)throw new CsvImportError('columns');
    return table.columns.map(column=>{
      const cell=record[positions.get(fold(column.name))!],text=cell.text;
      if(!cell.quoted&&text==='\\N'){if(!column.nullable||column.primaryKey)throw new CsvImportError('value');return null;}
      if(/^<BLOB\s+\d+\s+bytes>$/i.test(text))throw new CsvImportError('value');
      const type=column.type.trim().toUpperCase();if(type==='TEXT')return text;
      if(type==='INTEGER'?!/^[+-]?\d+$/.test(text):!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new CsvImportError('value');
      const number=Number(text);if(!Number.isFinite(number)||(Number.isInteger(number)&&!Number.isSafeInteger(number))||(number===0&&/[1-9]/.test(text.split(/[eE]/)[0])))throw new CsvImportError('value');
      return number;
    });
  });
  const columns=table.columns.map(column=>column.name);
  const sql=`INSERT INTO ${quote(table.name)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(()=>'?').join(', ')});`;
  if(new TextEncoder().encode(sql).length>8192)throw new CsvImportError('budget');
  return {table:table.name,columns,sql,rows,rowCount:rows.length,nullRule:'unquoted-backslash-N-only'};
}
