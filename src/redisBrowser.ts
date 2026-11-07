import type {RedisValue} from './redisProtocol';
import {redisText} from './redisProtocol';
import type {RedisRequestOptions} from './redisSession';
export interface RedisBrowserTransport {request(args:readonly (string|Uint8Array)[],options?:RedisRequestOptions):Promise<RedisValue>;}
export interface RedisBinary {bytes:Uint8Array;hex:string;utf8:string|null;}
export interface RedisKeyMetadata {type:string;ttl:number;pttl:number;}
export class RedisBrowserError extends Error {constructor(readonly code:'response'|'budget'|'page-limit'|'input'|'unsupported'|'transport'){super(`Redis browser ${code}`);}}
const MAX_BYTES=96*1024;
export const REDIS_BROWSER_SCAN_PAGE_LIMIT=1000;
function bounded<T>(value:T):T {if(new TextEncoder().encode(JSON.stringify(value)).length>MAX_BYTES)throw new RedisBrowserError('budget');return value;}
function binary(value:RedisValue):RedisBinary {if(value.type!=='bulk'||value.value===null)throw new RedisBrowserError('response');const bytes=value.value.slice();let utf8:string|null=null;try{utf8=redisText(bytes);}catch{}return {bytes,hex:Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join(''),utf8};}
function text(value:RedisValue):string {if((value.type!=='bulk'&&value.type!=='simple')||value.value===null)throw new RedisBrowserError('response');try{return redisText(value.value);}catch{throw new RedisBrowserError('response');}}
function array(value:RedisValue):RedisValue[]{if(value.type!=='array'||!value.value)throw new RedisBrowserError('response');return value.value;}
function cursor(value:string){if(typeof value!=='string'||(!/^(0|[1-9][0-9]{0,19})$/.test(value)||value.length===20&&value>'18446744073709551615'))throw new RedisBrowserError('input');return value;}
function count(value:number){if(!Number.isInteger(value)||value<1||value>100)throw new RedisBrowserError('input');return value;}
function key(value:Uint8Array){if(!(value instanceof Uint8Array)||value.length>4096)throw new RedisBrowserError('input');return value.slice();}
function scanReply(value:RedisValue,width:number){const outer=array(value);if(outer.length!==2)throw new RedisBrowserError('response');let next:string;try{next=cursor(text(outer[0]));}catch{throw new RedisBrowserError('response');}const values=array(outer[1]);if(values.length%width)throw new RedisBrowserError('response');if(values.length/width>REDIS_BROWSER_SCAN_PAGE_LIMIT)throw new RedisBrowserError('page-limit');return {nextCursor:next,done:next==='0',values};}
/** Read-only server browser. COUNT is a hint, not a server-side limit: an oversized
 * server SCAN page (>1000 logical entries or 96 KiB serialized output) is rejected
 * without advancing its cursor or silently dropping members. COUNT is only a
 * requested server work hint: complete larger pages are retained for local paging.
 * Callers may see duplicates or an empty nonterminal page while the DB changes.
 * No retries, endpoint redirects, cluster MOVED/ASK handling, storage or result cache.
 */
export function createRedisBrowser(session:RedisBrowserTransport){
  const request=async(args:readonly(string|Uint8Array)[],options?:RedisRequestOptions)=>{let value:RedisValue;try{value=await session.request(args,options);}catch{throw new RedisBrowserError('transport');}if(value.type==='error')throw new RedisBrowserError('transport');return value;};
  const inspectKey=async(rawKey:Uint8Array,options?:RedisRequestOptions):Promise<RedisKeyMetadata>=>{
    const name=key(rawKey);const type=text(await request(['TYPE',name],options));if(!/^[a-zA-Z0-9_-]{1,64}$/.test(type))throw new RedisBrowserError('response');
    const ttl=await request(['TTL',name],options),pttl=await request(['PTTL',name],options);
    if(ttl.type!=='integer'||pttl.type!=='integer'||!Number.isSafeInteger(ttl.value)||!Number.isSafeInteger(pttl.value)||ttl.value< -2||pttl.value< -2)throw new RedisBrowserError('response');return {type,ttl:ttl.value,pttl:pttl.value};
  };
  return {
    async serverInfo(options?:RedisRequestOptions){const raw=text(await request(['INFO','server'],options));if(new TextEncoder().encode(raw).length>MAX_BYTES)throw new RedisBrowserError('budget');const fields:Record<string,string>=Object.create(null);let lines=0;
      for(const line of raw.split(/\r?\n/)){if(!line||line.startsWith('#'))continue;if(++lines>256)throw new RedisBrowserError('budget');const colon=line.indexOf(':');if(colon<1||!/^[a-zA-Z0-9_-]{1,64}$/.test(line.slice(0,colon)))throw new RedisBrowserError('response');fields[line.slice(0,colon)]=line.slice(colon+1);}
      return bounded({fields});
    },
    async scan(input:{cursor?:string;pageSize?:number}={},options?:RedisRequestOptions){const current=cursor(input.cursor??'0'),size=count(input.pageSize??50);const page=scanReply(await request(['SCAN',current,'COUNT',String(size)],options),1);return bounded({cursor:current,nextCursor:page.nextCursor,done:page.done,keys:page.values.map(binary)});},
    inspectKey,
    async readPage(rawKey:Uint8Array,input:{cursor?:string;offset?:number;pageSize?:number}={},options?:RedisRequestOptions){
      const name=key(rawKey),size=count(input.pageSize??50),current=cursor(input.cursor??'0');const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset+size>1000000000)throw new RedisBrowserError('input');
      const metadata=await inspectKey(name,options);
      if(metadata.type==='none')return bounded({metadata,kind:'none' as const});
      if(metadata.type==='string'){const value=await request(['GET',name],options);if(value.type==='bulk'&&value.value===null)return bounded({metadata,kind:'string' as const,value:null});return bounded({metadata,kind:'string' as const,value:binary(value)});}
      if(metadata.type==='list'){const values=array(await request(['LRANGE',name,String(offset),String(offset+size-1)],options));if(values.length>size)throw new RedisBrowserError('page-limit');return bounded({metadata,kind:'list' as const,offset,nextOffset:values.length===size?offset+size:null,values:values.map(binary)});}
      const command=({hash:'HSCAN',set:'SSCAN',zset:'ZSCAN'} as Record<string,string>)[metadata.type];if(!command)throw new RedisBrowserError('unsupported');
      const pair=metadata.type!=='set';const page=scanReply(await request([command,name,current,'COUNT',String(size)],options),pair?2:1);
      if(metadata.type==='set')return bounded({metadata,kind:'set' as const,cursor:current,nextCursor:page.nextCursor,done:page.done,values:page.values.map(binary)});
      if(metadata.type==='hash'){const entries=[];for(let i=0;i<page.values.length;i+=2)entries.push({field:binary(page.values[i]),value:binary(page.values[i+1])});return bounded({metadata,kind:'hash' as const,cursor:current,nextCursor:page.nextCursor,done:page.done,entries});}
      const entries=[];for(let i=0;i<page.values.length;i+=2){const score=text(page.values[i+1]);if(!/^[+-]?(?:inf|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/i.test(score)||score.length>64)throw new RedisBrowserError('response');entries.push({member:binary(page.values[i]),score});}
      return bounded({metadata,kind:'zset' as const,cursor:current,nextCursor:page.nextCursor,done:page.done,entries});
    },
  };
}

export type RedisBrowser=ReturnType<typeof createRedisBrowser>;
export type RedisScanPage=Awaited<ReturnType<RedisBrowser['scan']>>;
export type RedisKeyPage=Awaited<ReturnType<RedisBrowser['readPage']>>;
