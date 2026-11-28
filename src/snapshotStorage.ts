import type {PluginKeyValueStore} from '@netcatty/plugin-sdk';
/** Explicit local persistence of entire databases, UNENCRYPTED, not a credential
 * vault. No automatic writes. Only restore plugin-generated snapshots, not files.
 * Serializes callers sharing this storage object; the host offers no CAS across
 * separate runtimes. Integration must use one adapter owner for all snapshots.
 */
export const SNAPSHOT_LIMITS=Object.freeze({bytes:512*1024,count:4,totalBytes:2*1024*1024,totalJsonBytes:3*1024*1024});
export interface SnapshotInfo {version:1;savedConnectionId:string;byteLength:number;sha256:string;savedAt:number}
export interface SnapshotRecord {info:SnapshotInfo;bytes:Uint8Array}
interface Envelope extends SnapshotInfo {encoding:'base64';data:string}
export class SnapshotStorageError extends Error {constructor(readonly code:'input'|'invalid'|'version'|'integrity'|'budget'|'storage'){super(`SQLite snapshot ${code}`);}}
const prefix='sqlite.snapshot.v1.';
const queues=new WeakMap<PluginKeyValueStore,Promise<unknown>>();
const fail=(code:SnapshotStorageError['code']):never=>{throw new SnapshotStorageError(code);};
function key(id:string){if(typeof id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(id))fail('input');return prefix+id;}
const header=new TextEncoder().encode('SQLite format 3\0');
function checkBytes(bytes:Uint8Array){if(!(bytes instanceof Uint8Array)||bytes.length<100)fail('invalid');if(bytes.length>SNAPSHOT_LIMITS.bytes)fail('budget');if(header.some((v,i)=>bytes[i]!==v))fail('invalid');}
function encode(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
async function digest(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)),b=>b.toString(16).padStart(2,'0')).join('');}
function info(e:Envelope):SnapshotInfo{return {version:1,savedConnectionId:e.savedConnectionId,byteLength:e.byteLength,sha256:e.sha256,savedAt:e.savedAt};}
async function decode(raw:unknown,id:string):Promise<SnapshotRecord>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail('invalid');const e=raw as Envelope;
 if(e.version!==1)fail('version');
 if(Object.keys(e).sort().join(',')!=='byteLength,data,encoding,savedAt,savedConnectionId,sha256,version'||e.savedConnectionId!==id||e.encoding!=='base64'||!Number.isSafeInteger(e.byteLength)||e.byteLength<100||e.byteLength>SNAPSHOT_LIMITS.bytes||!Number.isSafeInteger(e.savedAt)||e.savedAt<0||typeof e.sha256!=='string'||! /^[a-f0-9]{64}$/.test(e.sha256)||typeof e.data!=='string'||e.data.length!==4*Math.ceil(e.byteLength/3)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.data))fail('invalid');
 let bytes:Uint8Array|undefined;
 try {const text=atob(e.data);bytes=Uint8Array.from(text,c=>c.charCodeAt(0));if(bytes.length!==e.byteLength||encode(bytes)!==e.data)fail('invalid');checkBytes(bytes);if(await digest(bytes)!==e.sha256)fail('integrity');return {info:info(e),bytes};}
 catch(error){bytes?.fill(0);throw error instanceof SnapshotStorageError?error:new SnapshotStorageError('invalid');}
}
export function createSnapshotStorage(storage:PluginKeyValueStore){
 function serial<T>(work:()=>Promise<T>):Promise<T>{const run=(queues.get(storage)??Promise.resolve()).then(work);queues.set(storage,run.catch(()=>{}));return run;}
 async function access<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch{throw new SnapshotStorageError('storage');}}
 return {
  get(id:string):Promise<SnapshotRecord|undefined>{const k=key(id);return serial(async()=>{const raw=await access(()=>storage.get(k));return raw===undefined?undefined:decode(raw,id);});},
  save(id:string,input:Uint8Array):Promise<SnapshotInfo>{
   const k=key(id);checkBytes(input);const bytes=input.slice();
   return serial(async()=>{try{
    const keys=(await access(()=>storage.keys())).filter(k=>k.startsWith(prefix));
    if(keys.length>SNAPSHOT_LIMITS.count||(!keys.includes(k)&&keys.length>=SNAPSHOT_LIMITS.count))fail('budget');
    let total=bytes.length,jsonBytes=0;
    for(const existing of keys){if(existing===k)continue;const otherId=existing.slice(prefix.length);if(key(otherId)!==existing)fail('invalid');const raw=await access(()=>storage.get(existing));const checked=await decode(raw,otherId);total+=checked.bytes.length;checked.bytes.fill(0);jsonBytes+=new TextEncoder().encode(JSON.stringify(raw)).length;}
    const e:Envelope={version:1,savedConnectionId:id,byteLength:bytes.length,sha256:await digest(bytes),savedAt:Date.now(),encoding:'base64',data:encode(bytes)};
    jsonBytes+=new TextEncoder().encode(JSON.stringify(e)).length;
    if(total>SNAPSHOT_LIMITS.totalBytes||jsonBytes>SNAPSHOT_LIMITS.totalJsonBytes)fail('budget');
    // Host set is a single SQLite UPSERT; never delete the prior snapshot first.
    await access(()=>storage.set(k,e as unknown as Parameters<PluginKeyValueStore['set']>[1]));return info(e);
   }finally{bytes.fill(0);}});
  },
  delete(id:string):Promise<void>{const k=key(id);return serial(()=>access(()=>storage.delete(k)));}
 };
}
