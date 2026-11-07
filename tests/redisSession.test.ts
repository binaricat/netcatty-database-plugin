import test from 'node:test';
import assert from 'node:assert/strict';
import type {PluginByteConnection,PluginNetworkClient} from '@netcatty/plugin-sdk';
import {connectRedis,RedisSessionError} from '../src/redisSession';
import {RedisResp2Decoder,redisText} from '../src/redisProtocol';
const bytes=(value:string)=>new TextEncoder().encode(value);
function transport(respond:(args:string[],push:(chunk:Uint8Array|null)=>void)=>void){
  const chunks:(Uint8Array|null)[]=[];let waiting:((value:Uint8Array|null)=>void)|undefined;let closes=0,cancels=0;const commands:string[][]=[];const endpoints:string[]=[];
  const push=(chunk:Uint8Array|null)=>{if(waiting){const resolve=waiting;waiting=undefined;resolve(chunk);}else chunks.push(chunk);};
  const connection={endpoint:'tls://redis.example:6380',readable:{id:'in',read:()=>chunks.length?Promise.resolve(chunks.shift()!):new Promise<Uint8Array|null>(r=>{waiting=r;}),cancel:()=>{cancels++;push(null);},dispose(){}},writable:{id:'out',write:async(data:Uint8Array|ArrayBuffer)=>{const decoder=new RedisResp2Decoder();const value=decoder.feed(new Uint8Array(data instanceof Uint8Array?data:data))[0];assert.equal(value.type,'array');if(value.type!=='array')throw Error();const args=value.value!.map(v=>v.type==='bulk'&&v.value?redisText(v.value):'');commands.push(args);respond(args,push);},end:async()=>{},cancel:()=>{cancels++;},dispose(){},fail(){}},close:async()=>{closes++;push(null);},dispose(){}} as PluginByteConnection;
  const network={connect:async({endpoint}:{endpoint:string})=>{endpoints.push(endpoint);return connection;}} as PluginNetworkClient;
  return {network,connection,commands,endpoints,push,get closes(){return closes;},get cancels(){return cancels;}};
}
const code=(expected:string)=>(error:unknown)=>error instanceof RedisSessionError&&error.code===expected;
test('TLS endpoint forwarded exactly; AUTH and PING use real codec, fragmented data preserved',async()=>{
  const f=transport((args,push)=>{if(args[0]==='AUTH')push(bytes('+OK\r\n'));else if(args[0]==='PING'){push(bytes('+PO'));push(bytes('NG\r\n'));}else{push(bytes('$6\r\n'));push(bytes('中文\r\n'));}});
  const session=await connectRedis(f.network,{endpoint:'tls://redis.example:6380',authentication:{username:'user',password:'secret'}});
  assert.deepEqual(f.endpoints,['tls://redis.example:6380']);assert.deepEqual(f.commands.slice(0,2),[['AUTH','user','secret'],['PING']]);
  const value=await session.request(['GET','k']);assert.equal(value.type,'bulk');if(value.type==='bulk')assert.equal(redisText(value.value!),'中文');
  await session.close();await session.close();assert.equal(f.closes,1);
});
test('FIFO sends only one outstanding request; deny writes/eval/auth and excessive ranges',async()=>{
  const f=transport((args,push)=>{if(args[0]==='PING')push(bytes('+PONG\r\n'));});const session=await connectRedis(f.network,{endpoint:'tls://redis.example:6380'});
  const a=session.request(['GET','a']),b=session.request(['GET','b']);await Promise.resolve();assert.deepEqual(f.commands.at(-1),['GET','a']);
  f.push(bytes('$1\r\na\r\n'));await a;await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(f.commands.at(-1),['GET','b']);f.push(bytes('$1\r\nb\r\n'));await b;
  for(const args of [['SET','x','y'],['EVAL','anything','0'],['AUTH','secret'],['SCAN','0'],['LRANGE','key','0','100'],['get','x']])await assert.rejects(session.request(args),code('command'));
  await session.close();
});
test('multiple replies, trailing partial frame and premature EOF poison/close the stream',async()=>{
  for(const reply of [bytes('+OK\r\n+OK\r\n'),bytes('+OK\r\n$'),null]){
    const f=transport((args,push)=>push(args[0]==='PING'?bytes('+PONG\r\n'):reply));const session=await connectRedis(f.network,{endpoint:'tls://redis.example:6380'});
    await assert.rejects(session.request(['GET','key']),code('protocol'));assert.equal(session.isClosed,true);await session.close();assert.equal(f.closes,1);
  }
});
test('authentication failure and malicious error text never echo secret or transport details',async()=>{
  const f=transport((_args,push)=>push(bytes('-ERR secret-password echo\r\n')));
  await assert.rejects(connectRedis(f.network,{endpoint:'tls://redis.example:6380',authentication:{password:'secret-password'}}),error=>code('authentication')(error)&&!String(error).includes('secret-password'));
  assert.equal(f.closes,1);
  await assert.rejects(connectRedis({connect:async()=>{throw Error('private-token');}} as unknown as PluginNetworkClient,{endpoint:'tls://redis.example:6380'}),error=>code('transport')(error)&&!String(error).includes('private-token'));
});
test('request timeout and abort reject active and queued requests, close once and prevent more writes',async()=>{
  for(const aborted of [false,true]){
    const f=transport((args,push)=>{if(args[0]==='PING')push(bytes('+PONG\r\n'));});const session=await connectRedis(f.network,{endpoint:'tls://redis.example:6380'});const controller=new AbortController();
    const a=session.request(['GET','a'],{timeoutMs:20,signal:controller.signal});const b=session.request(['GET','b']);
    const assertions=Promise.all([assert.rejects(a,code(aborted?'aborted':'timeout')),assert.rejects(b,code(aborted?'aborted':'timeout'))]);if(aborted)controller.abort();await assertions;await session.close();assert.equal(f.closes,1);assert.ok(!f.commands.some(args=>args[1]==='b'));
  }
});
test('reply wire bytes above 96 KiB close; unsolicited idle data closes',async()=>{
  const f=transport((args,push)=>{if(args[0]==='PING')push(bytes('+PONG\r\n'));else push(bytes('$98304\r\n'+'a'.repeat(98304)+'\r\n'));});const session=await connectRedis(f.network,{endpoint:'tls://redis.example:6380'});
  await assert.rejects(session.request(['GET','key']),code('limit'));await session.close();
  const idle=transport((_args,push)=>push(bytes('+PONG\r\n')));const second=await connectRedis(idle.network,{endpoint:'tls://redis.example:6380'});idle.push(bytes('+unsolicited\r\n'));await Promise.resolve();assert.equal(second.isClosed,true);await second.close();
});
test('connect timeout cancels host token and closes late connection; endpoints never bypass TLS/local checks',async()=>{
  let resolve!:(connection:PluginByteConnection)=>void;let cancelled=false;const f=transport(()=>{});
  const network={connect:(_params:unknown,token:any)=>{token.onCancellationRequested(()=>{cancelled=true;});return new Promise<PluginByteConnection>(r=>{resolve=r;});}} as unknown as PluginNetworkClient;
  await assert.rejects(connectRedis(network,{endpoint:'tls://redis.example:6380',timeoutMs:10}),code('timeout'));assert.equal(cancelled,true);resolve(f.connection);await Promise.resolve();await Promise.resolve();assert.equal(f.closes,1);
  for(const endpoint of ['tcp://redis.example:6379','tls://localhost:6380','tls://127.0.0.1:6380','tls://user:pass@redis.example:6380','tls://redis.example:6380/path'])await assert.rejects(connectRedis(f.network,{endpoint}),code('endpoint'));
});
test('AUTH pending timeout and abort retain cancellation codes without exposing credentials',async()=>{
  for(const aborted of [false,true]){
    const f=transport(()=>{});const controller=new AbortController();
    const pending=connectRedis(f.network,{endpoint:'tls://redis.example:6380',authentication:{password:'never-echo-this'},timeoutMs:15,signal:controller.signal});
    const assertion=assert.rejects(pending,error=>code(aborted?'aborted':'timeout')(error)&&!String(error).includes('never-echo-this'));
    if(aborted){await new Promise(resolve=>setTimeout(resolve,0));controller.abort();}
    await assertion;assert.equal(f.closes,1);
  }
});
test('late connect after abort closes across microtasks and removes the external abort listener',async()=>{
  const signal=new AbortController();let adds=0,removes=0;const add=signal.signal.addEventListener.bind(signal.signal),remove=signal.signal.removeEventListener.bind(signal.signal);
  signal.signal.addEventListener=((...args:Parameters<AbortSignal['addEventListener']>)=>{adds++;return add(...args);}) as AbortSignal['addEventListener'];
  signal.signal.removeEventListener=((...args:Parameters<AbortSignal['removeEventListener']>)=>{removes++;return remove(...args);}) as AbortSignal['removeEventListener'];
  let resolve!:(connection:PluginByteConnection)=>void;const f=transport(()=>{});
  const network={connect:()=>new Promise<PluginByteConnection>(r=>{resolve=r;})} as unknown as PluginNetworkClient;
  const pending=connectRedis(network,{endpoint:'tls://redis.example:6380',signal:signal.signal});await Promise.resolve();signal.abort();await assert.rejects(pending,code('aborted'));
  await Promise.resolve();await Promise.resolve();resolve(f.connection);await new Promise(r=>setTimeout(r,0));assert.equal(f.closes,1);assert.equal(adds,removes);assert.equal(f.commands.length,0);
});
test('write errors and malformed RESP close with redacted errors; a failed write cannot report an early reply as success',async()=>{
  const f=transport((_args,push)=>push(bytes('+PONG\r\n')));const session=await connectRedis(f.network,{endpoint:'tls://redis.example:6380'});
  f.connection.writable.write=async()=>{f.push(bytes('$1\r\nx\r\n'));await Promise.resolve();throw Error('secret-write-error');};
  await assert.rejects(session.request(['GET','key']),error=>code('transport')(error)&&!String(error).includes('secret-write-error'));await session.close();
  const bad=transport((args,push)=>push(bytes(args[0]==='PING'?'+PONG\r\n':'$invalid\r\n')));const second=await connectRedis(bad.network,{endpoint:'tls://redis.example:6380'});await assert.rejects(second.request(['GET','key']),code('protocol'));await second.close();
});
test('oversized command fails without a wire write, and bounded queue closes cleanly',async()=>{
  const f=transport((args,push)=>{if(args[0]==='PING')push(bytes('+PONG\r\n'));});const session=await connectRedis(f.network,{endpoint:'tls://redis.example:6380'});
  await assert.rejects(session.request(['GET','x'.repeat(9000)]),code('limit'));assert.equal(f.commands.length,1);
  const queued=Array.from({length:16},(_,i)=>session.request(['GET',String(i)]));const assertions=queued.map(p=>assert.rejects(p,code('closed')));
  await assert.rejects(session.request(['GET','overflow']),code('limit'));await session.close();await Promise.all(assertions);assert.equal(f.closes,1);
});
test('collection scans accept only fixed COUNT shape and lossless uint64 cursors',async()=>{
  const f=transport((args,push)=>push(bytes(args[0]==='PING'?'+PONG\r\n':'*2\r\n$1\r\n0\r\n*0\r\n')));const session=await connectRedis(f.network,{endpoint:'tls://redis.example:6380'});
  for(const name of ['HSCAN','SSCAN','ZSCAN'])await session.request([name,'key','18446744073709551615','COUNT','100']);
  await session.request(['SCAN','18446744073709551615','COUNT','1']);
  for(const args of [['SCAN','18446744073709551616','COUNT','1'],['HSCAN','key','18446744073709551616','COUNT','1'],['SSCAN','key','0','COUNT','101'],['ZSCAN','key','0','MATCH','*'],['HSCAN','key','0']])await assert.rejects(session.request(args),code('command'));
  assert.equal(f.commands.length,5);await session.close();
});
