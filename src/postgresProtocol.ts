/** PostgreSQL v3 wire structures only; no transport or authentication implementation. */
export const PG_LIMITS=Object.freeze({frameBytes:256*1024,resultBytes:96*1024,columns:64,frames:1000});
export class PostgresProtocolError extends Error {constructor(readonly code:'malformed'|'limit'|'unsupported'|'truncated'|'closed'){super(`PG protocol ${code}`);}}
const fail=(code:PostgresProtocolError['code']):never=>{throw new PostgresProtocolError(code);};
const te=new TextEncoder(),td=new TextDecoder('utf-8',{fatal:true});
function text(b:Uint8Array){try{return td.decode(b);}catch{return fail('malformed');}}
function join(parts:Uint8Array[]){const n=parts.reduce((v,b)=>v+b.length,0);if(n>PG_LIMITS.frameBytes)fail('limit');const out=new Uint8Array(n);let p=0;for(const b of parts){out.set(b,p);p+=b.length;}return out;}
function i32(n:number){if(!Number.isInteger(n)||n<0||n>0x7fffffff)fail('malformed');const b=new Uint8Array(4);new DataView(b.buffer).setInt32(0,n);return b;}
function i16(n:number){if(!Number.isInteger(n)||n<0||n>32767)fail('malformed');return new Uint8Array([n>>8,n&255]);}
function str(s:string){if(typeof s!=='string'||s.includes('\0')||s.length>8192)fail('malformed');return join([te.encode(s),new Uint8Array([0])]);}
function packet(tag:string,parts:Uint8Array[]){const body=join(parts);return join([te.encode(tag),i32(body.length+4),body]);}
export function pgStartup(user:string,database:string){const body=join([i32(196608),str('user'),str(user),str('database'),str(database),str('client_encoding'),str('UTF8'),new Uint8Array([0])]);return join([i32(body.length+4),body]);}
export function pgParse(sql:string,statement=''){return packet('P',[str(statement),str(sql),i16(0)]);}
/** Text parameters only; null is a length -1, never the string "NULL". */
export function pgBind(parameters:readonly (string|null)[],portal='',statement=''){
 if(!Array.isArray(parameters)||parameters.length>32)fail('limit');const parts=[str(portal),str(statement),i16(0),i16(parameters.length)];
 for(const value of parameters){if(value===null){parts.push(new Uint8Array([255,255,255,255]));continue;}if(typeof value!=='string'||value.includes('\0')||value.length>8192)fail('malformed');const b=te.encode(value);parts.push(i32(b.length),b);}parts.push(i16(0));return packet('B',parts);
}
export function pgDescribe(portal=''){return packet('D',[te.encode('P'),str(portal)]);}
export function pgExecute(portal='',maxRows=100){if(!Number.isInteger(maxRows)||maxRows<1||maxRows>100)fail('limit');return packet('E',[str(portal),i32(maxRows)]);}
export function pgSync(){return packet('S',[]);}
export type PgMessage=
 |{type:'authentication';method:number;data:Uint8Array}
 |{type:'parameter';name:string;value:string}
 |{type:'ready';status:'I'|'T'|'E'}
 |{type:'columns';columns:{name:string;tableOid:number;attribute:number;typeOid:number;size:number;modifier:number;format:0|1}[]}
 |{type:'row';values:(Uint8Array|null)[]}
 |{type:'error';sqlState:string|null}
 |{type:'complete';kind:'parse'|'bind'|'no-data'|'suspended'};
class Reader{
 p=0;constructor(readonly b:Uint8Array){}
 take(n:number){if(n<0||this.p+n>this.b.length)fail('malformed');const v=this.b.slice(this.p,this.p+n);this.p+=n;return v;}
 int(n:2|4,signed=true){const b=this.take(n),v=new DataView(b.buffer);return n===2?(signed?v.getInt16(0):v.getUint16(0)):(signed?v.getInt32(0):v.getUint32(0));}
 string(){const end=this.b.indexOf(0,this.p);if(end<0)fail('malformed');const s=text(this.take(end-this.p));this.p++;return s;}
 end(){if(this.p!==this.b.length)fail('malformed');}
}
function decode(tag:number,body:Uint8Array):PgMessage{
 const r=new Reader(body);let result:PgMessage;
 switch(String.fromCharCode(tag)){
 case 'R':{const method=r.int(4);if(![0,3,5,10,11,12].includes(method))fail('unsupported');const data=r.take(body.length-r.p);if(([0,3].includes(method)&&data.length!==0)||(method===5&&data.length!==4))fail('malformed');if(method===10){const m=new Reader(data);let count=0;while(m.p<data.length){const s=m.string();if(!s){m.end();break;}if(++count>16)fail('limit');}if(!data.length||data[data.length-1]!==0||data.length<2||data[data.length-2]!==0)fail('malformed');}result={type:'authentication',method,data};break;}
 case 'S':result={type:'parameter',name:r.string(),value:r.string()};break;
 case 'Z':{const status=String.fromCharCode(r.take(1)[0]);if(!['I','T','E'].includes(status))fail('malformed');result={type:'ready',status:status as 'I'|'T'|'E'};break;}
 case 'T':{const n=r.int(2);if(n<0||n>PG_LIMITS.columns)fail('limit');const columns=[];for(let i=0;i<n;i++){const name=r.string(),tableOid=r.int(4,false),attribute=r.int(2),typeOid=r.int(4,false),size=r.int(2),modifier=r.int(4),format=r.int(2);if(format!==0&&format!==1)fail('malformed');columns.push({name,tableOid,attribute,typeOid,size,modifier,format:format as 0|1});}result={type:'columns',columns};break;}
 case 'D':{const n=r.int(2);if(n<0||n>PG_LIMITS.columns)fail('limit');const values=[];for(let i=0;i<n;i++){const len=r.int(4);if(len< -1)fail('malformed');values.push(len===-1?null:r.take(len));}result={type:'row',values};break;}
 case 'E':{let sqlState:string|null=null;let ended=false;while(r.p<body.length){const code=r.take(1)[0];if(!code){ended=true;break;}const value=r.string();if(code===67){if(!/^[0-9A-Z]{5}$/.test(value))fail('malformed');sqlState=value;}}if(!ended)fail('malformed');result={type:'error',sqlState};break;}
 case '1':case '2':case 'n':case 's':result={type:'complete',kind:tag===49?'parse':tag===50?'bind':tag===110?'no-data':'suspended'};break;
 default:return fail('unsupported');
 }r.end();return result;
}
/** One bounded protocol exchange. Instantiate a fresh decoder for a later exchange.
 * Bytes in data rows are raw (text or binary per RowDescription); callers must use
 * pgTextValue for text columns and implement OID-aware typed conversion separately.
 */
export const pgTextValue=text;
export class PostgresDecoder{
 private buffer=new Uint8Array(0);private frames=0;private bytes=0;private failed=false;
 feed(chunk:Uint8Array):PgMessage[]{
  if(this.failed)fail('closed');
  try{
   if(!(chunk instanceof Uint8Array))fail('malformed');if(this.buffer.length+chunk.length>PG_LIMITS.frameBytes)fail('limit');this.buffer=join([this.buffer,chunk]);const output:PgMessage[]=[];let p=0;
   while(this.buffer.length-p>=5){const n=new DataView(this.buffer.buffer,this.buffer.byteOffset+p+1,4).getInt32(0);if(n<4)fail('malformed');if(n+1>PG_LIMITS.frameBytes)fail('limit');if(this.buffer.length-p<n+1)break;if(++this.frames>PG_LIMITS.frames||(this.bytes+=n+1)>PG_LIMITS.resultBytes)fail('limit');output.push(decode(this.buffer[p],this.buffer.slice(p+5,p+n+1)));p+=n+1;}
   this.buffer=this.buffer.slice(p);return output;
  }catch(e){this.failed=true;this.buffer.fill(0);this.buffer=new Uint8Array(0);throw e instanceof PostgresProtocolError?e:new PostgresProtocolError('malformed');}
 }
 finish(){if(this.failed)fail('closed');if(this.buffer.length){this.failed=true;this.buffer.fill(0);fail('truncated');}}
}
