// Main SDK remote DOM plus actual plugin Redis codec/session/browser.
// Network bytes are injected: not native GUI, TLS/permission, real Redis or Docker evidence.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
const root=process.cwd(),hostRoot=process.env.NETCATTY_HOST_ROOT;
if(!hostRoot||!path.isAbsolute(hostRoot))throw new Error('Set NETCATTY_HOST_ROOT to the current main checkout.');
const host=createRequire(path.join(hostRoot,'package.json')),plugin=createRequire(path.join(root,'package.json'));
const {JSDOM}=host('jsdom'),{build}=host('esbuild');
const {validatePluginRemoteTree,validatePluginMutationBatch}=host('./domain/pluginRemoteTreePolicy.cjs');
const evidence=path.resolve(process.env.NETCATTY_REACT_EVIDENCE||'dist/redis-react-main');await mkdir(evidence,{recursive:true});
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://synthetic.invalid',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','Element','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','HTMLFormElement','Node','MutationObserver','Event','MouseEvent','KeyboardEvent','CustomEvent','FocusEvent','CompositionEvent'])Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='window'?dom.window:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {act}=plugin('react');const bundle=path.join(evidence,'plugin.cjs');
await build({stdin:{contents:`import React from 'react';import {registerHostReactView} from '@netcatty/plugin-sdk/host-react';import {RedisWorkbench} from './src/RedisWorkbench';export {RedisResp2Decoder} from './src/redisProtocol';export function activate(context,endpoints){return registerHostReactView(context.views,'redis-regression',()=>React.createElement(RedisWorkbench,{context,declaredEndpoints:endpoints}));}`,resolveDir:root,loader:'tsx'},outfile:bundle,bundle:true,platform:'node',format:'cjs',plugins:[{name:'shared-react',setup(b){b.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:plugin.resolve(args.path),external:true}));}}]});
const VIEW='redis-regression',instanceId='main-regression';
const receivers=new Map(),storage=new Map(),disposables=[],environmentListeners=new Set();let tree={children:[]};let maxNodes=0,batches=0;const errors=[];
const nodes=(root=tree)=>{const all=[];function visit(node){all.push(node);node.children?.forEach(visit);}root.children.forEach(visit);return all;};
const text=node=>node.type===3?node.data:(node.children??[]).map(text).join('');
const find=fn=>nodes().find(fn),byLabel=label=>find(n=>n.attributes?.['aria-label']===label),button=label=>find(n=>n.element==='button'&&text(n)===label);
const receive=message=>receivers.get(VIEW)?.({instanceId,...message});
const {RedisResp2Decoder,activate}=plugin(bundle);
const endpoint='tls://redis.example:6380';let connects=0,closes=0,oversized=false;const commands=[];
const bytes=text=>new TextEncoder().encode(text),bulk=text=>`$${bytes(text).length}\r\n${text}\r\n`;
const network={connect:async({endpoint:actual})=>{assert.equal(actual,endpoint);connects++;const queue=[];let waiting=null,closed=false;const decoder=new RedisResp2Decoder();const push=value=>waiting?(waiting(value),waiting=null):queue.push(value);return {endpoint:actual,readable:{id:'in',read:()=>queue.length?Promise.resolve(queue.shift()):closed?Promise.resolve(null):new Promise(resolve=>waiting=resolve),cancel(){closed=true;push(null);},dispose(){}},writable:{id:'out',async write(wire){const frame=decoder.feed(new Uint8Array(wire))[0];assert.equal(frame.type,'array');const args=frame.value.map(value=>new TextDecoder().decode(value.value));commands.push(args);let response;
if(args[0]==='PING')response='+PONG\r\n';else if(args[0]==='AUTH')response='+OK\r\n';else if(args[0]==='INFO')response=bulk('redis_version:7.2.0\r\n');else if(args[0]==='SCAN'){const n=oversized?1001:120;response='*2\r\n'+bulk('17')+`*${n}\r\n`+Array.from({length:n},(_,i)=>bulk(`key-${i}`)).join('');}else if(args[0]==='TYPE')response='+string\r\n';else if(args[0]==='TTL'||args[0]==='PTTL')response=':-1\r\n';else if(args[0]==='GET')response=bulk('synthetic value');else throw Error('Unexpected command');push(bytes(response));},end:async()=>{},fail(){},cancel(){},dispose(){}},async close(){closes++;closed=true;push(null);},dispose(){}};}};
const context={network,environment:{locale:'en'},enabledFeatures:new Set(['network.byte-streams']),views:{onDidReceiveMessage(id,listener){receivers.set(id,listener);return {dispose(){receivers.delete(id);}};},getState:async()=>null,setState:async()=>{},postMessage(id,message){if(message.kind!=='host-ui.update')return;try{assert.equal(id,VIEW);validatePluginMutationBatch(message.mutations);batches++;for(const m of message.mutations){const n=m[1]==='~'?tree:nodes().find(n=>n.id===m[1]);assert.ok(n,'mutation target exists: '+JSON.stringify(m));if(m[0]===0)n.children.splice(m[3],0,structuredClone(m[2]));else if(m[0]===1)n.children.splice(m[2],1);else if(m[0]===2)n.data=m[2];else if(m[3]===null)delete n.attributes[m[2]];else n.attributes[m[2]]=m[3];}validatePluginRemoteTree(tree);maxNodes=Math.max(maxNodes,nodes().length);}catch(e){errors.push(e.message);}}}};
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
async function settle(predicate=()=>true){for(let i=0;i<100;i++){await act(async()=>{await tick();});assert.deepEqual(errors,[]);if(predicate())return;}throw new Error('UI did not settle: '+text(tree));}
async function event(node,props){assert.ok(node);await act(async()=>{receive({kind:'host-ui.event',event:{nodeId:node.id,...props}});await tick();});assert.deepEqual(errors,[]);}
async function click(label){const n=button(label);assert.ok(n,'Missing button '+label);assert.ok(!Object.hasOwn(n.attributes,'disabled'),'Disabled '+label);await event(n,{type:'click'});}
async function change(label,value){const node=byLabel(label);await event(node,{type:node.element==='select'?'change':'input',value});}
async function snapshot(name){await writeFile(path.join(evidence,name+'.json'),JSON.stringify(tree,null,2));}

let registration;
try{
 await act(async()=>{registration=activate(context,[]);receive({kind:'host-ui.open',stateScope:VIEW});await tick();});await settle(()=>text(tree).includes('No Redis TLS endpoint'));assert.equal(connects,0);assert.ok(!byLabel('Redis password'));await snapshot('01-no-endpoint');
 await act(async()=>{receive({kind:'host-ui.close'});registration.dispose();await tick();});tree={children:[]};
 await act(async()=>{registration=activate(context,[endpoint]);receive({kind:'host-ui.open',stateScope:VIEW});await tick();});await settle(()=>byLabel('Redis declared endpoint'));assert.equal(connects,0);assert.ok(Object.hasOwn(button('Connect Redis').attributes,'disabled'));await snapshot('02-declared-disconnected');
 await change('Redis declared endpoint',endpoint);await change('Redis ACL username','synthetic');await change('Redis password','synthetic-password');await click('Connect Redis');await settle(()=>text(tree).includes('Connected · TLS / read only'));assert.equal(connects,1);assert.equal(byLabel('Redis password').attributes.value,'');assert.equal(byLabel('Redis ACL username').attributes.value,'');assert.deepEqual(commands.map(args=>args[0]),['AUTH','PING']);await snapshot('03-connected');
 await click('Server info');await settle(()=>byLabel('Redis server information fragment').attributes.value.includes('7.2.0'));
 await click('Scan keys');await settle(()=>button('key-0'));assert.match(text(tree),/cursor 17/);assert.ok(!button('key-20'));await click('More keys in this page');assert.ok(button('key-20'));assert.ok(!button('key-0'));for(let page=1;page<5;page++)await click('More keys in this page');assert.ok(button('key-119'),'COUNT 50 response retains all 120 keys through local paging');for(let page=0;page<5;page++)await click('Previous keys');await click('key-0');await settle(()=>byLabel('Redis value fragment').attributes.value==='synthetic value');assert.match(text(tree),/TTL -1s/);await snapshot('04-key-value');
 oversized=true;await click('Next key page');await settle(()=>text(tree).includes('oversized scan page'));assert.ok(button('key-0'));assert.match(text(tree),/cursor 17/);assert.equal(byLabel('Redis value fragment').attributes.value,'synthetic value');await snapshot('05-oversized-page-preserved');
 await click('Disconnect');await settle(()=>text(tree).includes('Not connected'));assert.equal(closes,1);assert.ok(!button('key-0'));assert.equal(byLabel('Redis value fragment').attributes.value,'');await snapshot('06-disconnected');
 console.log(JSON.stringify({status:'PASS',scope:'Main SDK remote-DOM validator/replay and real plugin Redis codec/session/browser with injected network byte transport; NOT native UI, real Redis/TLS/permissions, or Docker acceptance.',snapshots:6,maxNodes,batches,connects,closes},null,2));
}finally{await act(async()=>{receive({kind:'host-ui.close'});registration?.dispose();await tick();});dom.window.close();}
