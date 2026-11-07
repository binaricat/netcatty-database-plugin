import { CancellationTokenSource, type PluginByteConnection, type PluginNetworkClient } from '@netcatty/plugin-sdk';
import { encodeRedisCommand, RedisResp2Decoder, type RedisValue } from './redisProtocol';
export const REDIS_SESSION_LIMITS=Object.freeze({replyBytes:96*1024,requestBytes:8192,queue:16,timeoutMs:5000});
export class RedisSessionError extends Error {constructor(readonly code:'endpoint'|'command'|'authentication'|'identification'|'closed'|'protocol'|'limit'|'timeout'|'aborted'|'transport'|'server'){super(`Redis session ${code}`);}}
type Args=readonly (string|Uint8Array)[];
export interface RedisRequestOptions {timeoutMs?:number;signal?:AbortSignal;}
export interface RedisConnectOptions extends RedisRequestOptions {endpoint:string;authentication?:{username?:string;password:string};}
function duration(value:number|undefined){if(value===undefined)return REDIS_SESSION_LIMITS.timeoutMs;if(!Number.isInteger(value)||value<1||value>10000)throw new RedisSessionError('limit');return value;}
function endpoint(value:string){
  if(typeof value!=='string'||value.length>512||!/^tls:\/\/(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):[1-9][0-9]{0,4}$/.test(value))throw new RedisSessionError('endpoint');
  try{const uri=new URL(value.replace(/^tls:/,'https:'));const port=Number(value.slice(value.lastIndexOf(':')+1));if(port>65535||!uri.hostname)throw 0;
    const host=uri.hostname.toLowerCase();if(host==='localhost'||host.endsWith('.localhost')||/^(?:127\.|0\.|169\.254\.)/.test(host)||host==='[::1]'||host==='[::]')throw 0;
  }catch{throw new RedisSessionError('endpoint');}
  return value; // Exact caller endpoint: never rewrite, proxy or broaden the host's policy.
}
function command(args:Args){
  const word=args[0];if(typeof word!=='string'||word!==word.toUpperCase())throw new RedisSessionError('command');
  const numeric=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,9})$/.test(v)?Number(v):-1;
  const cursor=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&(v.length<20||v<='18446744073709551615');
  let allowed=false;
  if(word==='PING')allowed=args.length===1;
  else if(word==='INFO')allowed=args.length===1||args.length===2&&typeof args[1]==='string'&&['server','clients','memory','stats','replication','cpu','keyspace'].includes(args[1]);
  else if(['GET','TYPE','TTL','PTTL','HGETALL','SMEMBERS'].includes(word))allowed=args.length===2;
  else if(word==='SCAN')allowed=args.length===4&&cursor(args[1])&&args[2]==='COUNT'&&numeric(args[3])>=1&&numeric(args[3])<=100;
  else if(['HSCAN','SSCAN','ZSCAN'].includes(word))allowed=args.length===5&&cursor(args[2])&&args[3]==='COUNT'&&numeric(args[4])>=1&&numeric(args[4])<=100;
  else if(word==='LRANGE'||word==='ZRANGE'){const start=numeric(args[2]),end=numeric(args[3]);allowed=(args.length===4||word==='ZRANGE'&&args.length===5&&args[4]==='WITHSCORES')&&start>=0&&end>=start&&end-start<100;}
  if(!allowed)throw new RedisSessionError('command');
}
type Pending={wire:Uint8Array;resolve:(value:RedisValue)=>void;reject:(error:RedisSessionError)=>void;cleanup:()=>void;decoder:RedisResp2Decoder;bytes:number;reply?:RedisValue;};
/** One FIFO command at a time. No credentials are stored on the session. Error text
 * is fixed and never incorporates server replies, command values or transport errors.
 */
export class RedisSession {
  private connection:PluginByteConnection|null;
  private queue:Pending[]=[];private active:Pending|null=null;private writing=false;
  private closed=false;private closePromise:Promise<void>|null=null;private lifetimeCleanup:()=>void=()=>{};
  private constructor(connection:PluginByteConnection){this.connection=connection;void this.readLoop();}
  get isClosed(){return this.closed;}
  private bindLifetime(signal:AbortSignal|undefined){if(!signal)return;const abort=()=>{void this.shutdown(new RedisSessionError('aborted'));};this.lifetimeCleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}
  private async readLoop(){
    try{while(!this.closed){const chunk=await this.connection!.readable.read();if(this.closed)return;if(chunk===null)throw new RedisSessionError('protocol');
      const task=this.active;if(!task||task.reply)throw new RedisSessionError('protocol');task.bytes+=chunk.length;if(task.bytes>REDIS_SESSION_LIMITS.replyBytes)throw new RedisSessionError('limit');
      const replies=task.decoder.feed(chunk);if(!replies.length)continue;if(replies.length!==1)throw new RedisSessionError('protocol');task.decoder.finish();
      if(replies[0].type==='error')throw new RedisSessionError('server');
      task.reply=replies[0];if(!this.writing)this.finishReply(task);
    }}catch(error){if(!this.closed)void this.shutdown(error instanceof RedisSessionError?error:new RedisSessionError('protocol'));}
  }
  private finishReply(task:Pending){if(this.closed||this.active!==task||!task.reply)return;this.active=null;task.cleanup();task.resolve(task.reply);this.drain();}
  private drain(){
    if(this.closed||this.active||this.writing||!this.queue.length)return;
    const task=this.queue.shift()!;this.active=task;this.writing=true;
    Promise.resolve().then(()=>{if(this.closed)return;return this.connection!.writable.write(task.wire);}).then(()=>{
      task.wire.fill(0);this.writing=false;if(task.reply)this.finishReply(task);else this.drain();
    },()=>{this.writing=false;void this.shutdown(new RedisSessionError('transport'));});
  }
  /** Internal handshake only; the public request() enforces the read-only allowlist. */
  private exchange(args:Args,options:RedisRequestOptions={}):Promise<RedisValue>{
    if(this.closed)return Promise.reject(new RedisSessionError('closed'));
    if(this.queue.length+(this.active?1:0)>=REDIS_SESSION_LIMITS.queue)return Promise.reject(new RedisSessionError('limit'));
    let wire:Uint8Array|undefined,ms:number;try{ms=duration(options.timeoutMs);wire=encodeRedisCommand(args);if(wire.length>REDIS_SESSION_LIMITS.requestBytes)throw new RedisSessionError('limit');}catch(error){wire?.fill(0);return Promise.reject(error instanceof RedisSessionError?error:new RedisSessionError('command'));}
    if(options.signal?.aborted){wire.fill(0);void this.shutdown(new RedisSessionError('aborted'));return Promise.reject(new RedisSessionError('aborted'));}
    return new Promise((resolve,reject)=>{
      const fail=(code:'aborted'|'timeout')=>{void this.shutdown(new RedisSessionError(code));};
      const abort=()=>fail('aborted');const timer=setTimeout(()=>fail('timeout'),ms);
      const task:Pending={wire,resolve,reject,decoder:new RedisResp2Decoder(),bytes:0,cleanup:()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}};
      options.signal?.addEventListener('abort',abort,{once:true});this.queue.push(task);this.drain();
    });
  }
  request(args:Args,options:RedisRequestOptions={}):Promise<RedisValue>{try{command(args);}catch{return Promise.reject(new RedisSessionError('command'));}return this.exchange(args,options);}
  private async initialize(authentication:RedisConnectOptions['authentication'],options:RedisRequestOptions){
    if(authentication){
      if(typeof authentication.password!=='string'||!authentication.password.length||authentication.password.length>1024||authentication.username!==undefined&&(typeof authentication.username!=='string'||!authentication.username.length||authentication.username.length>128)){await this.close();throw new RedisSessionError('authentication');}
      const args=authentication.username===undefined?['AUTH',authentication.password]:['AUTH',authentication.username,authentication.password];
      try{const reply=await this.exchange(args,options);if(reply.type!=='simple'||!equals(reply.value,'OK'))throw 0;}catch(error){void this.close();throw error instanceof RedisSessionError&&['timeout','aborted'].includes(error.code)?error:new RedisSessionError('authentication');}finally{args.fill('');}
    }
    try{const reply=await this.request(['PING'],options);if(reply.type!=='simple'||!equals(reply.value,'PONG'))throw 0;}catch(error){void this.close();throw error instanceof RedisSessionError&&['timeout','aborted'].includes(error.code)?error:new RedisSessionError('identification');}
  }
  private shutdown(error:RedisSessionError):Promise<void>{
    if(this.closed)return this.closePromise??Promise.resolve();this.closed=true;this.lifetimeCleanup();this.lifetimeCleanup=()=>{};
    const connection=this.connection;this.connection=null;const tasks=[...(this.active?[this.active]:[]),...this.queue];this.active=null;this.queue=[];
    for(const task of tasks){task.cleanup();task.wire.fill(0);task.reject(error);}
    try{connection?.readable.cancel();}catch{}try{connection?.writable.cancel();}catch{}
    this.closePromise=Promise.resolve().then(()=>connection?.close()).then(()=>{},()=>{});return this.closePromise;
  }
  close():Promise<void>{return this.shutdown(new RedisSessionError('closed'));}
  static async connect(network:PluginNetworkClient,options:RedisConnectOptions):Promise<RedisSession>{
  const exact=endpoint(options.endpoint),ms=duration(options.timeoutMs),cancellation=new CancellationTokenSource();
  let connection:PluginByteConnection|undefined;let timedOut=false,aborted=false;let rejectStop!:(error:RedisSessionError)=>void;
  const stop=new Promise<never>((_,reject)=>{rejectStop=reject;});
  const cancel=(code:'timeout'|'aborted')=>{timedOut=code==='timeout';aborted=code==='aborted';cancellation.cancel();rejectStop(new RedisSessionError(code));};
  const abort=()=>cancel('aborted');const timer=setTimeout(()=>cancel('timeout'),ms);options.signal?.addEventListener('abort',abort,{once:true});
  try{
    if(options.signal?.aborted)abort();
    const opening=Promise.resolve().then(()=>{if(timedOut||aborted)throw new RedisSessionError(aborted?'aborted':'timeout');return network.connect({endpoint:exact},cancellation.token);}).then(value=>{if(timedOut||aborted){void value.close().catch(()=>{});throw new RedisSessionError(aborted?'aborted':'timeout');}connection=value;return value;});
    await Promise.race([opening,stop]);
  }catch(error){throw error instanceof RedisSessionError?error:new RedisSessionError('transport');}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);cancellation.dispose();}
  const session=new RedisSession(connection!);session.bindLifetime(options.signal);await session.initialize(options.authentication,{timeoutMs:ms,signal:options.signal});return session;
}

}
function equals(bytes:Uint8Array,text:string){return bytes.length===text.length&&bytes.every((byte,index)=>byte===text.charCodeAt(index));}
/** Uses only the public host network API. Actual endpoint permission, certificate,
 * local-address checks and byte-stream quotas stay enforced by the main host.
 */
export function connectRedis(network:PluginNetworkClient,options:RedisConnectOptions):Promise<RedisSession>{return RedisSession.connect(network,options);}
