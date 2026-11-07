/** Offline MySQL/MariaDB classic protocol structures only. No socket, TLS upgrade,
 * authentication response or capability negotiation. Compressed and 16 MiB
 * continuation packets are deliberately unsupported. */
export const MYSQL_LIMITS=Object.freeze({packetBytes:256*1024,exchangeBytes:96*1024,packets:128});
export class MysqlProtocolError extends Error {
 constructor(readonly code:'input'|'malformed'|'limit'|'sequence'|'unsupported'|'truncated'|'closed'){super(`MySQL protocol ${code}`);}
}
const fail=(code:MysqlProtocolError['code']):never=>{throw new MysqlProtocolError(code);};
export interface MysqlPacket {sequence:number;payload:Uint8Array;}
export function encodeMysqlPacket(payload:Uint8Array,sequence:number):Uint8Array {
 if(!(payload instanceof Uint8Array)||!Number.isInteger(sequence)||sequence<0||sequence>255)fail('input');
 if(payload.length>MYSQL_LIMITS.packetBytes)fail('limit');
 const out=new Uint8Array(payload.length+4);out[0]=payload.length&255;out[1]=(payload.length>>>8)&255;out[2]=(payload.length>>>16)&255;out[3]=sequence;out.set(payload,4);return out;
}
/** One exchange, sequence must include both directions: for a server response to
 * a client packet at sequence 1 construct a decoder at sequence 2. Never silently
 * resynchronize a mismatch. Returned payload is detached from caller input. */
export class MysqlPacketDecoder {
 private buffer=new Uint8Array(0);private bytes=0;private packets=0;private closed=false;
 constructor(private expected=0){if(!Number.isInteger(expected)||expected<0||expected>255)fail('input');}
 feed(chunk:Uint8Array):MysqlPacket[]{
  if(this.closed)fail('closed');
  const result:MysqlPacket[]=[];
  try{
   if(!(chunk instanceof Uint8Array))fail('input');this.bytes+=chunk.length;if(this.bytes>MYSQL_LIMITS.exchangeBytes)fail('limit');
   const merged=new Uint8Array(this.buffer.length+chunk.length);merged.set(this.buffer);merged.set(chunk,this.buffer.length);this.buffer.fill(0);this.buffer=merged;
   while(this.buffer.length>=4){
    const length=this.buffer[0]+this.buffer[1]*256+this.buffer[2]*65536;
    if(length===0xffffff)fail('unsupported');if(length>MYSQL_LIMITS.packetBytes)fail('limit');
    if(this.buffer[3]!==this.expected)fail('sequence');if(this.buffer.length<length+4)break;
    if(++this.packets>MYSQL_LIMITS.packets)fail('limit');
    result.push({sequence:this.expected,payload:this.buffer.slice(4,4+length)});this.expected=(this.expected+1)&255;const previous=this.buffer;this.buffer=previous.slice(4+length);previous.fill(0);
   }return result;
  }catch(e){for(const packet of result)packet.payload.fill(0);this.closed=true;this.buffer.fill(0);this.buffer=new Uint8Array(0);throw e;}
 }
 finish(){if(this.closed)fail('closed');this.closed=true;if(this.buffer.length){this.buffer.fill(0);this.buffer=new Uint8Array(0);fail('truncated');}}
}
class Reader {
 offset=0;constructor(readonly bytes:Uint8Array){}
 take(n:number){if(n<0||this.offset+n>this.bytes.length)fail('malformed');const b=this.bytes.subarray(this.offset,this.offset+n);this.offset+=n;return b;}
 number(n:1|2|4){const b=this.take(n);return n===1?b[0]:n===2?b[0]+b[1]*256:new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);}
 ascii(max:number){const end=this.bytes.indexOf(0,this.offset);if(end<0||end===this.offset||end-this.offset>max)fail('malformed');const b=this.take(end-this.offset);this.take(1);if(b.some(v=>v<32||v>126))fail('malformed');return String.fromCharCode(...b);}
 end(){if(this.offset!==this.bytes.length)fail('malformed');}
}
export interface MysqlHandshakeV10 {
 protocol:10;serverVersion:string;connectionId:number;capabilities:number;characterSet:number;statusFlags:number;authPlugin:string;authPluginData:Uint8Array;tlsAdvertised:boolean;
}
/** Modern V10 only, not authentication. SSL advertised is NOT TLS established.
 * Unknown plugin names are returned as data, never an instruction to authenticate.
 * No fallback to old password / cleartext / RSA or disabled certificate checks.
 */
export function parseMysqlHandshake(payload:Uint8Array):MysqlHandshakeV10 {
 if(!(payload instanceof Uint8Array))fail('input');if(payload.length>1024)fail('limit');
 const r=new Reader(payload);if(r.number(1)!==10)fail('unsupported');const serverVersion=r.ascii(128),connectionId=r.number(4),first=r.take(8);
 if(r.number(1)!==0)fail('malformed');const low=r.number(2);
 if(!(low&0x200)||!(low&0x8000))fail('unsupported');
 const characterSet=r.number(1),statusFlags=r.number(2),high=r.number(2),capabilities=(low+high*65536)>>>0;
 if(!(capabilities&0x80000))fail('unsupported');const authLength=r.number(1);
 // Restrict to the standard 20-byte challenge plus NUL used by native/caching SHA.
 if(authLength!==21)fail('unsupported');r.take(10); // MariaDB may use reserved tail for extended capability bits.
 const tail=r.take(13);if(tail[12]!==0)fail('malformed');const authPlugin=r.ascii(64);if(!/^[a-zA-Z0-9_]+$/.test(authPlugin))fail('malformed');r.end();
 // The only returned challenge buffer is owned by the caller; no view into input.
 const authPluginData=new Uint8Array(20);authPluginData.set(first);authPluginData.set(tail.subarray(0,12),8);
 return {protocol:10,serverVersion,connectionId,capabilities,characterSet,statusFlags,authPlugin,authPluginData,tlsAdvertised:Boolean(capabilities&0x800)};
}
/** Protocol41 ERR packet. Server text is intentionally discarded, never decoded,
 * returned, logged or included in an exception; it may contain SQL or credentials. */
export function parseMysqlError(payload:Uint8Array):{code:number;sqlState:string}{
 if(!(payload instanceof Uint8Array))fail('input');if(payload.length>MYSQL_LIMITS.exchangeBytes)fail('limit');
 const r=new Reader(payload);if(r.number(1)!==255)fail('malformed');const code=r.number(2);if(r.number(1)!==35)fail('unsupported');const state=r.take(5);if(state.some(v=>!(v>=48&&v<=57||v>=65&&v<=90)))fail('malformed');return {code,sqlState:String.fromCharCode(...state)};
}
