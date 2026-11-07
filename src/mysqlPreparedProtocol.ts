/** Pure prepared SELECT codec. No transport, authentication, execution or TLS. */
import {encodeMysqlPacket} from './mysqlProtocol';
export class MysqlPreparedError extends Error{constructor(readonly code:'input'|'limit'|'protocol'|'type'|'value'){super(`MySQL prepared ${code}`);}}
const fail=(code:MysqlPreparedError['code']):never=>{throw new MysqlPreparedError(code);};
export type MysqlBoundValue={kind:'int64';value:string}|{kind:'text';value:string}|{kind:'null'};
export interface MysqlPreparedSelect{schema:string;table:string;columns:string[];where:{column:string;value:MysqlBoundValue}[];limit?:number;}
export interface MysqlPreparedColumn{name:string;schema:string;table:string;originalTable:string;originalName:string;type:number;charset:number;flags:number;}
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function utf8(s:string){if(typeof s!=='string'||s.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s))fail('input');return enc.encode(s);}
const text=(b:Uint8Array)=>{try{return dec.decode(b);}catch{return fail('value');}};
function join(parts:Uint8Array[]){const length=parts.reduce((a,b)=>a+b.length,0);if(length>96*1024)fail('limit');const result=new Uint8Array(length);let p=0;for(const b of parts){result.set(b,p);p+=b.length;}return result;}
function integer(n:number,bytes:number){if(!Number.isSafeInteger(n)||n<0||n>=2**(bytes*8))fail('input');const out=new Uint8Array(bytes);for(let i=0;i<bytes;i++){out[i]=n&255;n=Math.floor(n/256);}return out;}
function id(n:number){if(n===0)fail('input');return integer(n,4);}
function length(n:number){return n<251?integer(n,1):n<=65535?join([Uint8Array.of(252),integer(n,2)]):join([Uint8Array.of(253),integer(n,3)]);}
function identifier(v:unknown){if(typeof v!=='string'||!v||v.length>128)fail('input');utf8(v as string);return v as string;}
const quote=(s:string)=>'`'+s.replaceAll('`','``')+'`';
function bound(value:unknown):MysqlBoundValue{
 if(!object(value))fail('input');const v=value as Record<string,unknown>;
 if(v.kind==='null'){if(Object.keys(v).length!==1)fail('input');return {kind:'null'};}
 if(Object.keys(v).length!==2||typeof v.value!=='string')fail('input');
 if(v.kind==='int64'){if(!/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(v.value as string)||(v.value as string).length>20)fail('value');const n=BigInt(v.value as string);if(n<-(1n<<63n)||n>(1n<<63n)-1n)fail('value');return {kind:'int64',value:v.value as string};}
 if(v.kind==='text'){const b=utf8(v.value as string);if(b.length>8192)fail('limit');return {kind:'text',value:v.value as string};}
 return fail('input');
}
/** NULL-safe equality only; parameters never become SQL source text. */
export function planMysqlPreparedSelect(input:MysqlPreparedSelect):{sql:string;parameters:MysqlBoundValue[];columns:string[];limit:number}{
 if(!object(input)||Object.keys(input).some(k=>!['schema','table','columns','where','limit'].includes(k)))fail('input');
 const schema=identifier(input.schema),table=identifier(input.table),limit=input.limit??100;
 if(!Number.isInteger(limit)||limit<1||limit>100||!Array.isArray(input.columns)||input.columns.length<1||input.columns.length>16||!Array.isArray(input.where)||input.where.length<1||input.where.length>8)fail('input');
 const columns=input.columns.map(identifier);if(new Set(columns).size!==columns.length)fail('input');
 const conditions=input.where.map(c=>{if(!object(c)||Object.keys(c).length!==2||!('column'in c)||!('value'in c))fail('input');return {column:identifier(c.column),value:bound(c.value)};});
 const sql=`SELECT ${columns.map(quote).join(', ')} FROM ${quote(schema)}.${quote(table)} WHERE ${conditions.map(c=>`${quote(c.column)} <=> ?`).join(' AND ')} LIMIT ${limit}`;
 if(utf8(sql).length>8192)fail('limit');return {sql,parameters:conditions.map(c=>c.value),columns,limit};
}
/** No arbitrary SQL entry point: PREPARE always regenerates the restricted plan. */
export function encodeMysqlPrepare(input:MysqlPreparedSelect){const plan=planMysqlPreparedSelect(input);return {plan,wire:encodeMysqlPacket(join([Uint8Array.of(22),utf8(plan.sql)]),0)};}
export function encodeMysqlExecute(statementId:number,parameters:readonly MysqlBoundValue[]):Uint8Array{
 const statement=id(statementId);if(!Array.isArray(parameters)||parameters.length<1||parameters.length>8)fail('input');
 const values=parameters.map(bound),bitmap=new Uint8Array(Math.ceil(values.length/8)),types=new Uint8Array(values.length*2),payloads:Uint8Array[]=[];
 try{values.forEach((v,i)=>{if(v.kind==='null'){bitmap[i>>3]|=1<<(i&7);types[i*2]=6;}else if(v.kind==='int64'){types[i*2]=8;const b=new Uint8Array(8);new DataView(b.buffer).setBigInt64(0,BigInt(v.value),true);payloads.push(b);}else{types[i*2]=253;const b=utf8(v.value);payloads.push(length(b.length),b);}});
 const body=join([Uint8Array.of(23),statement,Uint8Array.of(0),integer(1,4),bitmap,Uint8Array.of(1),types,...payloads]);try{return encodeMysqlPacket(body,0);}finally{body.fill(0);}
 }finally{for(const b of payloads)b.fill(0);bitmap.fill(0);types.fill(0);}
}
export function encodeMysqlStatementClose(statementId:number){return encodeMysqlPacket(join([Uint8Array.of(25),id(statementId)]),0);}
class Reader{pos=0;constructor(readonly b:Uint8Array){if(!(b instanceof Uint8Array)||b.length>96*1024)fail('limit');}
 take(n:number){if(!Number.isSafeInteger(n)||n<0||this.pos+n>this.b.length)fail('protocol');const out=this.b.subarray(this.pos,this.pos+n);this.pos+=n;return out;}
 number(n:number){const b=this.take(n);let v=0;for(let i=n-1;i>=0;i--)v=v*256+b[i];if(!Number.isSafeInteger(v))fail('limit');return v;}
 len(){const n=this.number(1);if(n<251)return n;if(n===251||n===255)fail('protocol');const width=n===252?2:n===253?3:8,v=this.number(width);if(v<(width===2?251:width===3?65536:16777216))fail('protocol');return v;}
 string(max=128){const n=this.len();if(n>max*4)fail('limit');const value=text(this.take(n));if(value.length>max||value.includes('\0'))fail('value');return value;}
 end(){if(this.pos!==this.b.length)fail('protocol');}
}
export function parseMysqlPrepareOk(payload:Uint8Array,expected:{parameters:number;columns:number}){
 if(!Number.isInteger(expected.parameters)||expected.parameters<1||expected.parameters>8||!Number.isInteger(expected.columns)||expected.columns<1||expected.columns>16)fail('input');
 const r=new Reader(payload);if(r.number(1)!==0)fail('protocol');const statementId=r.number(4),columns=r.number(2),parameters=r.number(2);if(!statementId||columns!==expected.columns||parameters!==expected.parameters||r.number(1)!==0||r.number(2)!==0)fail('protocol');r.end();return {statementId,columns,parameters};
}
export function parseMysqlPreparedColumn(payload:Uint8Array):MysqlPreparedColumn{
 const r=new Reader(payload);if(r.string()!=='def')fail('protocol');const schema=r.string(),table=r.string(),originalTable=r.string(),name=r.string(),originalName=r.string();if(r.len()!==12)fail('protocol');const charset=r.number(2);r.number(4);const type=r.number(1),flags=r.number(2);r.number(1);if(r.number(2)!==0)fail('protocol');r.end();return {schema,table,originalTable,name,originalName,type,charset,flags};
}
function supported(c:MysqlPreparedColumn){
 if(!object(c)||!Number.isInteger(c.flags)||c.flags<0||c.flags>65535)fail('type');
 if([1,2,3,8,9,13].includes(c.type)){if(c.charset!==63)fail('type');return;}
 if([15,249,250,251,252,253,254].includes(c.type)&&[33,45,46,83,255].includes(c.charset)&&!(c.flags&(128|256|2048)))return;
 fail('type');
}
/** Binary row NULL bitmap has two reserved leading bits, unlike execute params.
 * Integer results are exact decimal strings; initially supports integer/text only. */
export function parseMysqlBinaryRow(payload:Uint8Array,columns:readonly MysqlPreparedColumn[]):(string|null)[]{
 if(!Array.isArray(columns)||columns.length<1||columns.length>16)fail('input');columns.forEach(supported);
 const r=new Reader(payload);if(r.number(1)!==0)fail('protocol');const bitmap=r.take(Math.ceil((columns.length+2)/8));if(bitmap[0]&3)fail('protocol');
 const used=(columns.length+2)%8;if(used&&bitmap[bitmap.length-1]>>used)fail('protocol');
 const values=columns.map((c,i)=>{if(bitmap[(i+2)>>3]&(1<<((i+2)&7)))return null;
 if([1,2,3,8,9,13].includes(c.type)){const width=c.type===1?1:c.type===2||c.type===13?2:c.type===8?8:4;const b=r.take(width);let v=0n;for(let n=b.length-1;n>=0;n--)v=(v<<8n)|BigInt(b[n]);if(!(c.flags&32)&&(b[b.length-1]&128))v-=1n<<BigInt(width*8);return v.toString();}
 return r.string(2048);
 });r.end();return values;
}
