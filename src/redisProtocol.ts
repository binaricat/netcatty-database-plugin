/** RESP2 wire codec only. Protocol reference: https://redis.io/docs/latest/develop/reference/protocol-spec/
 * No transport, credentials, logging or Redis connection claim. Strings remain bytes.
 */
export type RedisValue =
  | { type: 'simple' | 'error'; value: Uint8Array }
  | { type: 'integer'; value: number }
  | { type: 'bulk'; value: Uint8Array | null }
  | { type: 'array'; value: RedisValue[] | null };
export const REDIS_PROTOCOL_LIMITS = Object.freeze({frameBytes:256*1024,resultBytes:96*1024,arrayItems:10000,depth:16});
export class RedisProtocolError extends Error {
  constructor(readonly code:'malformed'|'limit'|'unsafe-integer'|'truncated'|'closed') {super(`RESP2 ${code}`);}
}
const encoder = new TextEncoder();
/** Explicit opt-in text decoding; binary keys/values must not pass through this helper. */
export function redisText(bytes:Uint8Array):string {
  try {return new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {throw new RedisProtocolError('malformed');}
}
export function encodeRedisCommand(arguments_:readonly (string|Uint8Array)[]):Uint8Array {
  if(!arguments_.length||arguments_.length>REDIS_PROTOCOL_LIMITS.arrayItems)throw new RedisProtocolError('limit');
  const pieces:Uint8Array[]=[encoder.encode(`*${arguments_.length}\r\n`)];let size=pieces[0].length;
  for(const arg of arguments_){
    if(typeof arg!=='string'&&!(arg instanceof Uint8Array))throw new RedisProtocolError('malformed');
    if(typeof arg==='string'&&arg.length>REDIS_PROTOCOL_LIMITS.frameBytes)throw new RedisProtocolError('limit');
    const value=typeof arg==='string'?encoder.encode(arg):arg;
    const header=encoder.encode(`$${value.length}\r\n`);size+=header.length+value.length+2;
    if(size>REDIS_PROTOCOL_LIMITS.frameBytes)throw new RedisProtocolError('limit');
    pieces.push(header,value,new Uint8Array([13,10]));
  }
  const output=new Uint8Array(size);let offset=0;for(const piece of pieces){output.set(piece,offset);offset+=piece.length;}return output;
}
type Frame={remaining:number;values:RedisValue[]};
/** Incremental bounded decoder. Any error poisons the decoder; never resynchronize
 * on untrusted bytes. Returned byte strings are owned copies, not buffer views.
 */
export class RedisResp2Decoder {
  private buffer=new Uint8Array(1024);private used=0;private offset=0;private scan=0;
  private stack:Frame[]=[];private bulk:number|null=null;private frameBytes=0;private resultBytes=0;private items=0;private failed=false;
  private fail(code:RedisProtocolError['code']):never {this.failed=true;this.buffer.fill(0);this.used=0;this.offset=0;this.stack=[];throw new RedisProtocolError(code);}
  private count(bytes:number){this.frameBytes+=bytes;if(this.frameBytes>REDIS_PROTOCOL_LIMITS.frameBytes)this.fail('limit');}
  private payload(bytes:number){this.resultBytes+=bytes;if(this.resultBytes>REDIS_PROTOCOL_LIMITS.resultBytes)this.fail('limit');}
  private number(start:number,end:number,signed:boolean):number {
    const text=String.fromCharCode(...this.buffer.subarray(start,end));
    if(!(signed ? /^[+-]?[0-9]+$/ : /^-?[0-9]+$/).test(text))this.fail('malformed');
    const value=Number(text);if(!Number.isSafeInteger(value))this.fail('unsafe-integer');return value;
  }
  feed(chunk:Uint8Array):RedisValue[]{
    if(this.failed)throw new RedisProtocolError('closed');
    if(!(chunk instanceof Uint8Array))this.fail('malformed');
    const remaining=this.used-this.offset;
    if(remaining+chunk.length>REDIS_PROTOCOL_LIMITS.frameBytes)this.fail('limit');
    if(this.offset){this.buffer.copyWithin(0,this.offset,this.used);this.scan=Math.max(0,this.scan-this.offset);this.used=remaining;this.offset=0;}
    if(this.used+chunk.length>this.buffer.length){const next=new Uint8Array(Math.min(REDIS_PROTOCOL_LIMITS.frameBytes,Math.max(this.used+chunk.length,this.buffer.length*2)));next.set(this.buffer.subarray(0,this.used));this.buffer.fill(0);this.buffer=next;}
    this.buffer.set(chunk,this.used);this.used+=chunk.length;
    const output:RedisValue[]=[];
    const emit=(value:RedisValue)=>{
      while(this.stack.length){const parent=this.stack[this.stack.length-1];parent.values.push(value);if(--parent.remaining)return;this.stack.pop();value={type:'array',value:parent.values};}
      output.push(value);this.frameBytes=0;this.resultBytes=0;this.items=0;
    };
    while(this.offset<this.used){
      if(this.bulk!==null){const length=this.bulk;if(this.used-this.offset<length+2)break;
        if(this.buffer[this.offset+length]!==13||this.buffer[this.offset+length+1]!==10)this.fail('malformed');
        const value=this.buffer.slice(this.offset,this.offset+length);this.offset+=length+2;this.count(length+2);this.scan=this.offset;this.bulk=null;emit({type:'bulk',value});continue;
      }
      const start=this.offset,marker=this.buffer[start];if(![43,45,58,36,42].includes(marker))this.fail('malformed');
      let end=-1;
      for(let i=Math.max(start+1,this.scan);i<this.used;i++){
        if(this.buffer[i]===10)this.fail('malformed');
        if(this.buffer[i]===13){if(i+1===this.used){this.scan=i;break;}if(this.buffer[i+1]!==10)this.fail('malformed');end=i;break;}
        this.scan=i+1;
      }
      if(end<0){if(this.used-start+this.frameBytes>=REDIS_PROTOCOL_LIMITS.frameBytes)this.fail('limit');break;}
      this.count(end+2-start);this.offset=end+2;this.scan=this.offset;
      if(this.stack.length && ++this.items>REDIS_PROTOCOL_LIMITS.arrayItems)this.fail('limit');
      if(marker===43||marker===45){this.payload(end-start-1);emit({type:marker===43?'simple':'error',value:this.buffer.slice(start+1,end)});continue;}
      if(end-start>32)this.fail('unsafe-integer');const length=this.number(start+1,end,marker===58);
      if(marker===58){emit({type:'integer',value:length});continue;}
      if(length < -1)this.fail('malformed');
      if(marker===36){if(length===-1){emit({type:'bulk',value:null});continue;}this.payload(length);if(length+2+this.frameBytes>REDIS_PROTOCOL_LIMITS.frameBytes)this.fail('limit');this.bulk=length;continue;}
      if(this.stack.length+1>REDIS_PROTOCOL_LIMITS.depth)this.fail('limit');
      if(length===-1){emit({type:'array',value:null});continue;}
      if(length>REDIS_PROTOCOL_LIMITS.arrayItems-this.items)this.fail('limit');
      if(length===0){emit({type:'array',value:[]});continue;}
      this.stack.push({remaining:length,values:[]});
    }
    return output;
  }
  finish():void {if(this.failed)throw new RedisProtocolError('closed');if(this.used!==this.offset||this.bulk!==null||this.stack.length)this.fail('truncated');}
}
