/** Read-only assertion helper for the manually seeded TLS fixture. Not plugin code. */
import type {RedisBrowser} from '../src/redisBrowser';
const key=(name:string)=>new TextEncoder().encode(`netcatty:tls:${name}`);
const fail=():never=>{throw new Error('Redis typed fixture mismatch');};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export async function verifyRedisFixtureTypes(browser:RedisBrowser){
 const values:string[]=[];let offset=0,listDone=false,listPages=0;
 for(let i=0;i<20;i++){
  const p=await browser.readPage(key('list'),{offset,pageSize:2});listPages++;
  if(p.kind!=='list'||p.metadata.type!=='list'||p.metadata.ttl!==-1||p.metadata.pttl!==-1||p.offset!==offset)return fail();
  for(const value of p.values){if(value.utf8===null)return fail();values.push(value.utf8);}
  if(p.nextOffset===null){listDone=true;break;}if(p.nextOffset!==offset+2)return fail();offset=p.nextOffset;
 }
 if(!listDone||!same(values,['alpha','beta','gamma'])||listPages!==2)return fail();
 const hash=new Map<string,string>(),set=new Set<string>(),zset=new Map<string,string>();const pageCounts:Record<string,number>={list:listPages};
 for(const kind of ['hash','set','zset'] as const){
  let cursor='0',done=false;
  for(let i=0;i<20;i++){
   const p=await browser.readPage(key(kind),{cursor,pageSize:1});
   if(p.kind!==kind||p.metadata.type!==kind||p.metadata.ttl!==-1||p.metadata.pttl!==-1||!('cursor' in p)||p.cursor!==cursor)return fail();
   if(p.kind==='hash')for(const entry of p.entries){if(entry.field.utf8===null||entry.value.utf8===null)return fail();hash.set(entry.field.utf8,entry.value.utf8);}
   if(p.kind==='set')for(const member of p.values){if(member.utf8===null)return fail();set.add(member.utf8);}
   if(p.kind==='zset')for(const entry of p.entries){if(entry.member.utf8===null)return fail();zset.set(entry.member.utf8,entry.score);}
   // COUNT is a server work hint, not a row limit. Preserve complete pages.
   pageCounts[kind]=i+1;cursor=p.nextCursor;if(p.done){if(cursor!=='0')return fail();done=true;break;}
  }if(!done)return fail();
 }
 const pairs=(map:Map<string,string>)=>[...map].sort(([a],[b])=>a.localeCompare(b));
 if(!same(pairs(hash),[['count','2'],['name','Netcatty TLS'],['status','verified']])||!same([...set].sort(),['alpha','beta','gamma'])||!same(pairs(zset),[['alpha','1'],['beta','2.5'],['gamma','10']]))return fail();
 return {typesVerified:['hash','list','set','zset'],pageCounts,listOrderVerified:true,hashFieldsVerified:true,setMembersVerified:true,zsetScoresVerified:true,ttlVerified:true};
}
