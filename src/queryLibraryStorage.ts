import type {PluginKeyValueStore} from '@netcatty/plugin-sdk';
import {emptyQueryLibrary,saveQuery,serializeQueryLibrary,type SavedQuery,type SavedQueryInput} from './queryLibrary';
export const STORED_QUERY_LIMITS=Object.freeze({connections:8,entries:30,textBytes:8192,libraryBytes:96*1024,totalBytes:768*1024});
export interface StoredQueryLibrary {version:1;savedConnectionId:string;revision:number;saved:SavedQuery[]}
export class QueryLibraryStorageError extends Error {constructor(readonly code:'input'|'invalid'|'version'|'budget'|'stale'|'missing'|'storage'){super(`Stored SQL library ${code}`);}}
const prefix='sql.library.v1.',queues=new WeakMap<PluginKeyValueStore,Promise<unknown>>();
const fail=(code:QueryLibraryStorageError['code']):never=>{throw new QueryLibraryStorageError(code);};
const size=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
function key(id:string){if(typeof id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(id))fail('input');return prefix+id;}
function exact(v:unknown,keys:string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');}
function entry(input:unknown):SavedQueryInput{
 if(!exact(input,['name','sql','parameters','time']))return fail('input');
 const v=input as unknown as SavedQueryInput;
 if(typeof v.sql!=='string'||typeof v.parameters!=='string'||new TextEncoder().encode(v.sql).length>8192||new TextEncoder().encode(v.parameters).length>8192)fail('budget');
 try{const saved=saveQuery(emptyQueryLibrary(),v).saved[0];return {name:saved.name,sql:saved.sql,parameters:saved.parameters,time:saved.time};}catch{return fail('input');}
}
function parse(raw:unknown,id:string):StoredQueryLibrary{
 if(!raw||typeof raw!=='object')return fail('invalid');if((raw as {version?:unknown}).version!==1)fail('version');
 if(!exact(raw,['version','savedConnectionId','revision','saved'])||raw.savedConnectionId!==id||!Number.isSafeInteger(raw.revision)||(raw.revision as number)<1||!Array.isArray(raw.saved)||raw.saved.length>30)fail('invalid');
 if(size(raw)>STORED_QUERY_LIMITS.libraryBytes)fail('budget');
 const saved:SavedQuery[]=[],ids=new Set<string>(),names=new Set<string>();
 for(const item of (raw as Record<string,unknown>).saved as unknown[]){if(!exact(item,['id','name','sql','parameters','time'])||typeof item.id!=='string'||! /^saved-[0-9]+-[0-9]+$/.test(item.id)||item.id.length>64)return fail('invalid');
  let clean:SavedQueryInput;try{clean=entry({name:item.name,sql:item.sql,parameters:item.parameters,time:item.time});}catch{return fail('invalid');}
  if(clean.name!==item.name||ids.has(item.id)||names.has(clean.name))fail('invalid');ids.add(item.id);names.add(clean.name);saved.push({id:item.id,...clean});
 }
 return {version:1,savedConnectionId:id,revision:(raw as Record<string,unknown>).revision as number,saved};
}
/** Explicit plaintext SQL/parameter storage only. Never persist history/results.
 * One owner/shared storage object required: the host offers no cross-runtime CAS.
 * Empty revisioned libraries are kept to prevent delete/recreate ABA conflicts.
 */
export function createQueryLibraryStorage(storage:PluginKeyValueStore){
 function serial<T>(work:()=>Promise<T>):Promise<T>{const run=(queues.get(storage)??Promise.resolve()).then(work);queues.set(storage,run.catch(()=>{}));return run;}
 async function access<T>(work:()=>Promise<T>){try{return await work();}catch{throw new QueryLibraryStorageError('storage');}}
 async function read(id:string){const raw=await access(()=>storage.get(key(id)));return raw===undefined?{version:1 as const,savedConnectionId:id,revision:0,saved:[]}:parse(raw,id);}
 async function write(next:StoredQueryLibrary){
  const bytes=size(next);if(bytes>STORED_QUERY_LIMITS.libraryBytes)fail('budget');const k=key(next.savedConnectionId);
  const keys=(await access(()=>storage.keys())).filter(k=>k.startsWith(prefix));
  if(keys.length>8||(!keys.includes(k)&&keys.length>=8))fail('budget');let total=bytes;
  for(const other of keys){if(other===k)continue;const id=other.slice(prefix.length);key(id);const value=await access(()=>storage.get(other));total+=size(parse(value,id));}
  if(total>STORED_QUERY_LIMITS.totalBytes)fail('budget');await access(()=>storage.set(k,next as unknown as Parameters<PluginKeyValueStore['set']>[1]));return structuredClone(next);
 }
 function expected(value:number){if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail('input');}
 return {
  load(id:string){key(id);return serial(()=>read(id));},
  save(id:string,input:SavedQueryInput,expectedRevision:number){key(id);expected(expectedRevision);const snapshot=entry(input);return serial(async()=>{const current=await read(id);if(current.revision!==expectedRevision)fail('stale');let saved:SavedQuery[];try{saved=saveQuery({version:1,history:[],saved:current.saved},snapshot).saved;serializeQueryLibrary({version:1,history:[],saved});}catch{return fail('budget');}return write({version:1,savedConnectionId:id,revision:current.revision+1,saved});});},
  remove(id:string,queryId:string,expectedRevision:number){key(id);expected(expectedRevision);if(typeof queryId!=='string'||! /^saved-[0-9]+-[0-9]+$/.test(queryId)||queryId.length>64)fail('input');return serial(async()=>{const current=await read(id);if(current.revision!==expectedRevision)fail('stale');if(!current.saved.some(q=>q.id===queryId))fail('missing');return write({...current,revision:current.revision+1,saved:current.saved.filter(q=>q.id!==queryId)});});}
 };
}
