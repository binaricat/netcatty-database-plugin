import type {Statement} from 'sql.js';import type {DatabaseScalar} from './databaseTypes';
export const SQLITE_RESULT_TEXT_BYTES=96*1024;
/** Compatibility seam for pinned sql.js 1.14.1, not a stable upstream API.
 * useBigInt is documented but absent from installed types; named getBlob is
 * upstream-internal and capability-checked. Never inspect minified fields/ABI.
 * Caller must have stepped to a row and must not step/reset/free during this call.
 * Safe integers remain numbers, wide integers become exact decimal text. BLOBs
 * remain disclosed placeholders, not lossless binary/typed SQL exports.
 */
export function readSqliteResultRow(statement:Statement):DatabaseScalar[]{
 const compat=statement as unknown as {get(params?:undefined,options?:{useBigInt:true}):unknown[];getBlob?:(index:number)=>unknown};
 const values=compat.get(undefined,{useBigInt:true});let textBytes=0;
 return values.map((value,index)=>{
  if(typeof value==='bigint')return value<=BigInt(Number.MAX_SAFE_INTEGER)&&value>=BigInt(Number.MIN_SAFE_INTEGER)?Number(value):value.toString();
  if(value instanceof Uint8Array)return `<BLOB ${value.length} bytes>`;
  if(typeof value==='string'){
   if(typeof compat.getBlob!=='function')throw new Error('SQLite exact text decoding is unavailable.');
   let bytes:unknown;
   try{
    // get() already classified this cell as TEXT. Retrieve bytes in this same
    // live row, never re-execute SQL or use a converted column type afterwards.
    bytes=compat.getBlob(index);
    if(!(bytes instanceof Uint8Array))throw new Error('SQLite exact text decoding failed.');
    // This is a returned-text budget, NOT a pre-allocation memory limit:
    // getBlob has already allocated/copied the entire cell at this point.
    textBytes+=bytes.byteLength;if(textBytes>SQLITE_RESULT_TEXT_BYTES)throw new Error('SQLite result text exceeds the 96 KiB row budget.');
    try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
    catch{throw new Error('SQLite result contains invalid UTF-8 text.');}
   }catch(error){
    if(error instanceof Error&&['SQLite exact text decoding failed.','SQLite result text exceeds the 96 KiB row budget.','SQLite result contains invalid UTF-8 text.'].includes(error.message))throw error;
    throw new Error('SQLite exact text decoding failed.');
   }finally{if(bytes instanceof Uint8Array)bytes.fill(0);}
  }
  if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('SQLite result contains a non-finite number.');return value;}
  if(value===null)return value;
  throw new Error('Unsupported SQLite result value.');
 });
}
