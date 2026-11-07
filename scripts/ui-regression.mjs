// Actual main SDK remote DOM + real plugin-owned SQLite. Host storage/view transport
// is injected; this is not native GUI, native permission, Docker or live AI evidence.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
const root=process.cwd(),hostRoot=process.env.NETCATTY_HOST_ROOT;
if(!hostRoot||!path.isAbsolute(hostRoot))throw new Error('Set NETCATTY_HOST_ROOT to the current main checkout.');
const host=createRequire(path.join(hostRoot,'package.json')),plugin=createRequire(path.join(root,'package.json'));
const {JSDOM}=host('jsdom'),{build}=host('esbuild');
const {validatePluginRemoteTree,validatePluginMutationBatch}=host('./domain/pluginRemoteTreePolicy.cjs');
const evidence=path.resolve(process.env.NETCATTY_REACT_EVIDENCE||'dist/react-main');await mkdir(evidence,{recursive:true});
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://synthetic.invalid',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','Element','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','HTMLFormElement','Node','MutationObserver','Event','MouseEvent','KeyboardEvent','CustomEvent','FocusEvent','CompositionEvent'])Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='window'?dom.window:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {act}=plugin('react');const bundle=path.join(evidence,'plugin.cjs');
await build({entryPoints:['src/index.tsx'],outfile:bundle,bundle:true,platform:'node',format:'cjs',loader:{'.css':'text'},plugins:[{name:'shared-react',setup(b){b.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:plugin.resolve(args.path),external:true}));}}]});
const VIEW='com.binaricat.netcatty-database.workbench',instanceId='main-regression';
const receivers=new Map(),storage=new Map(),disposables=[],environmentListeners=new Set();let tree={children:[]};let maxNodes=0,batches=0;const errors=[];
const nodes=(root=tree)=>{const all=[];function visit(node){all.push(node);node.children?.forEach(visit);}root.children.forEach(visit);return all;};
const text=node=>node.type===3?node.data:(node.children??[]).map(text).join('');
const find=fn=>nodes().find(fn),byLabel=label=>find(n=>n.attributes?.['aria-label']===label),button=label=>find(n=>n.element==='button'&&text(n)===label);
const receive=message=>receivers.get(VIEW)?.({instanceId,...message});
const context={enabledFeatures:new Set(['views.host-drawn','views.vault-pages','metadata.brand-icon','ai.model-invocation']),environment:{locale:'en',theme:'dark',onDidChange(fn){environmentListeners.add(fn);return {dispose(){environmentListeners.delete(fn);}};}},subscriptions:{add(d){disposables.push(d);}},storage:{get:async key=>structuredClone(storage.get(key)),set:async(key,value)=>storage.set(key,structuredClone(value))},ai:{openChat:async()=>{throw new Error('No live model configured in this fixture');}},views:{onDidReceiveMessage(id,listener){receivers.set(id,listener);return {dispose(){receivers.delete(id);}};},getState:async()=>null,setState:async()=>{},postMessage(id,message){if(message.kind!=='host-ui.update')return;try{assert.equal(id,VIEW);validatePluginMutationBatch(message.mutations);batches++;for(const m of message.mutations){const n=m[1]==='~'?tree:nodes().find(n=>n.id===m[1]);assert.ok(n,'mutation target exists');if(m[0]===0)n.children.splice(m[3],0,structuredClone(m[2]));else if(m[0]===1)n.children.splice(m[2],1);else if(m[0]===2)n.data=m[2];else if(m[3]===null)delete n.attributes[m[2]];else n.attributes[m[2]]=m[3];}validatePluginRemoteTree(tree);maxNodes=Math.max(maxNodes,nodes().length);}catch(e){errors.push(e.message);}}}};
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
async function settle(predicate=()=>true){for(let i=0;i<100;i++){await act(async()=>{await tick();});assert.deepEqual(errors,[]);if(predicate())return;}throw new Error('UI did not settle: '+text(tree));}
async function event(node,props){assert.ok(node);await act(async()=>{receive({kind:'host-ui.event',event:{nodeId:node.id,...props}});await tick();});assert.deepEqual(errors,[]);}
async function click(label){const n=button(label);assert.ok(n,'Missing button '+label);assert.ok(!Object.hasOwn(n.attributes,'disabled'),'Disabled '+label);await event(n,{type:'click'});}
async function change(label,value){await event(byLabel(label),{type:'input',value});}
async function snapshot(name){await writeFile(path.join(evidence,name+'.json'),JSON.stringify(tree,null,2));}
try{
 await act(async()=>{await plugin(bundle).default.activate(context);receive({kind:'host-ui.open',stateScope:VIEW});await tick();});await settle(()=>button('New Connection'));await snapshot('01-home');
 await click('New Connection');await settle(()=>byLabel('SQLite'));assert.ok(byLabel('PostgreSQL'));assert.ok(nodes().filter(n=>n.element==='img').every(n=>n.attributes.src.startsWith('asset:')));await snapshot('02-picker');
 await event(byLabel('SQLite'),{type:'click'});await click('Next');await change('Connection name','Main regression sample');await click('Test');await settle(()=>!Object.hasOwn(button('Save & Connect').attributes,'disabled'));
 await click('Save & Connect');await settle(()=>byLabel('Open table notes'));await snapshot('03-connected');
 await click('Run read query');await settle(()=>text(tree).includes('Synthetic launch checklist'));assert.match(text(tree),/2 rows \/ 3 columns/);await snapshot('04-query');
 await event(byLabel('Open table orders'),{type:'click'});assert.ok(byLabel('Structure of orders'));await click('Data');await click('Run read query');await settle(()=>text(tree).includes('Sample order'));assert.match(text(tree),/NULL/);assert.match(text(tree),/Empty string/);await snapshot('05-orders');
 await change('SQL statement','DELETE FROM notes');await click('Run read query');await settle(()=>text(tree).includes('read-only'));await change('SQL statement','SELECT name,total FROM order_totals ORDER BY name');await click('Run read query');await settle(()=>text(tree).includes('41.5'));await snapshot('06-recovery');
 await act(async()=>{context.environment.locale='zh-CN';environmentListeners.forEach(fn=>fn(context.environment));await tick();});await settle(()=>button('执行只读查询'));assert.equal(byLabel('SQL 语句').attributes.value,'SELECT name,total FROM order_totals ORDER BY name');await snapshot('07-chinese');
 console.log(JSON.stringify({status:'PASS',scope:'Real SQLite + main SDK/remote-DOM validators, injected storage/view transport; no native or Docker claim.',maxNodes,batches,snapshots:7},null,2));
}finally{await act(async()=>{receive({kind:'host-ui.close'});disposables.forEach(d=>d.dispose());await tick();});dom.window.close();}
