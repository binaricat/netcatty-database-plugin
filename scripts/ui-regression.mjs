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
const clipboardCalls=[];let clipboardOutcome=false;
const context={clipboard:{writeText:async(value,title)=>{clipboardCalls.push({value,title});if(clipboardOutcome instanceof Error)throw clipboardOutcome;return clipboardOutcome;}},enabledFeatures:new Set(['views.host-drawn','views.vault-pages','metadata.brand-icon','ai.model-invocation','ai.agent-sessions','vault.host-actions']),environment:{locale:'en',theme:'dark',onDidChange(fn){environmentListeners.add(fn);return {dispose(){environmentListeners.delete(fn);}};}},subscriptions:{add(d){disposables.push(d);}},storage:{get:async key=>structuredClone(storage.get(key)),set:async(key,value)=>storage.set(key,structuredClone(value))},agent:{listBackends:async()=>({items:[]}),closeChat:async()=>{}},vault:{selectHosts:async()=>({cancelled:true}),requestConnect:async()=>({cancelled:false,status:'requested'})},ai:{openChat:async()=>{throw new Error('No live model configured in this fixture');}},views:{onDidReceiveMessage(id,listener){receivers.set(id,listener);return {dispose(){receivers.delete(id);}};},getState:async()=>null,setState:async()=>{},postMessage(id,message){if(message.kind!=='host-ui.update')return;try{assert.equal(id,VIEW);validatePluginMutationBatch(message.mutations);batches++;for(const m of message.mutations){const n=m[1]==='~'?tree:nodes().find(n=>n.id===m[1]);assert.ok(n,'mutation target exists: '+JSON.stringify(m));if(m[0]===0)n.children.splice(m[3],0,structuredClone(m[2]));else if(m[0]===1)n.children.splice(m[2],1);else if(m[0]===2)n.data=m[2];else if(m[3]===null)delete n.attributes[m[2]];else n.attributes[m[2]]=m[3];}validatePluginRemoteTree(tree);maxNodes=Math.max(maxNodes,nodes().length);}catch(e){errors.push(e.message);}}}};
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
async function settle(predicate=()=>true){for(let i=0;i<100;i++){await act(async()=>{await tick();});assert.deepEqual(errors,[]);if(predicate())return;}throw new Error('UI did not settle: '+text(tree));}
async function event(node,props){assert.ok(node);await act(async()=>{receive({kind:'host-ui.event',event:{nodeId:node.id,...props}});await tick();});assert.deepEqual(errors,[]);}
async function click(label){const n=button(label);assert.ok(n,'Missing button '+label);assert.ok(!Object.hasOwn(n.attributes,'disabled'),'Disabled '+label);await event(n,{type:'click'});}
async function change(label,value){const node=byLabel(label);await event(node,{type:node.element==='select'?'change':'input',value});}
async function snapshot(name){await writeFile(path.join(evidence,name+'.json'),JSON.stringify(tree,null,2));}
try{
 await act(async()=>{await plugin(bundle).default.activate(context);receive({kind:'host-ui.open',stateScope:VIEW});await tick();});await settle(()=>button('New Connection'));await snapshot('01-home');
 await click('Host connections');await click('Choose saved hosts');await settle(()=>text(tree).includes('Host selection cancelled.'));await click('Host connections');
 await click('New Connection');await settle(()=>byLabel('SQLite'));assert.ok(byLabel('PostgreSQL'));assert.ok(nodes().filter(n=>n.element==='img').every(n=>n.attributes.src.startsWith('asset:')));await snapshot('02-picker');
 await event(byLabel('SQLite'),{type:'click'});await click('Next');await change('Connection name','Main regression sample');await click('Test');await settle(()=>!Object.hasOwn(button('Save & Connect').attributes,'disabled'));
 await click('Save & Connect');await settle(()=>byLabel('Open table notes'));await snapshot('03-connected');
 await click('Run read query');await settle(()=>text(tree).includes('Synthetic launch checklist'));assert.match(text(tree),/2 rows \/ 3 columns/);await snapshot('04-query');
 await event(byLabel('Open table orders'),{type:'click'});assert.ok(byLabel('Structure of orders'));await click('Data');await click('Run read query');await settle(()=>text(tree).includes('Sample order'));assert.match(text(tree),/NULL/);assert.match(text(tree),/Empty string/);await snapshot('05-orders');
 await change('SQL statement','DELETE FROM notes');await click('Run read query');await settle(()=>text(tree).includes('read-only'));await change('SQL statement','SELECT name,total FROM order_totals ORDER BY name');await click('Run read query');await settle(()=>text(tree).includes('41.5'));await snapshot('06-recovery');
 await click('AI SQL assistant');await click('Run assistance');await settle(()=>text(tree).includes('AI unavailable. Check host model configuration'));assert.ok(Object.hasOwn(button('Insert draft into editor').attributes,'disabled'));await event(byLabel('Close AI assistant'),{type:'click'});
 // Deterministic mock transport tests UI handling only, never a live model claim.
 let aiSequence=0;const prompts=[];Object.assign(context.ai,{openChat:async()=>({chatHandle:'mock-chat',model:'Synthetic test only',expiresAt:1}),startTurn:async({prompt})=>{prompts.push(prompt);aiSequence=0;return {turnHandle:'mock-turn'};},readTurn:async()=>++aiSequence===1?{kind:'text',sequence:1,text:'```sql\nSELECT 42 AS answer\n```\nSynthetic explanation.'}:{kind:'end',sequence:2},stopTurn:async()=>{},closeChat:async()=>{}});
 await click('AI SQL assistant');await change('Your request','Draft a literal');await click('Run assistance');await settle(()=>button('Insert draft into editor')&&!Object.hasOwn(button('Insert draft into editor').attributes,'disabled'));await click('Insert draft into editor');assert.equal(byLabel('SQL statement').attributes.value,'SELECT 42 AS answer');assert.match(text(tree),/Nothing executed/);await click('Run assistance');await settle(()=>prompts.length===2&&!Object.hasOwn(button('Run assistance').attributes,'disabled'));assert.ok(prompts[1].includes('Draft a literal'));await click('New AI conversation');assert.match(text(tree),/No draft generated/);await event(byLabel('Close AI assistant'),{type:'click'});await change('SQL statement','SELECT name,total FROM order_totals ORDER BY name');
 await click('AI SQL assistant');await change('AI mode','agent');await click('Check Agent backends');await settle(()=>text(tree).includes('No Agent backend checked.'));await event(byLabel('Close AI assistant'),{type:'click'});
 await click('Query library');await change('Query name','Saved totals');await click('Save current SQL');assert.ok(text(tree).includes('Saved totals'));await event(find(n=>n.element==='button'&&text(n).startsWith('Saved totals')),{type:'click'});assert.equal(byLabel('SQL statement').attributes.value,'SELECT name,total FROM order_totals ORDER BY name');
 await change('SQL statement','WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<25) SELECT n, n+1 AS b, n+2 AS c, n+3 AS d,n+4 AS e,n+5 AS f,n+6 AS g,n+7 AS h,n+8 AS i FROM numbers');await click('Run read query');await settle(()=>text(tree).includes('25 rows / 9 columns'));await event(byLabel('Next rows'),{type:'click'});assert.ok(byLabel('Inspect row 25, column 1'));await event(byLabel('Next columns'),{type:'click'});assert.ok(byLabel('Inspect row 25, column 9'));await event(byLabel('Inspect row 25, column 9'),{type:'click'});assert.equal(byLabel('Full cell value').attributes.value,'33');await click('Close');await change('Filter returned rows','33');assert.ok(byLabel('Inspect row 25, column 9'));await snapshot('08-result-pages');
 await change('SQL statement','SELECT name,total FROM order_totals ORDER BY name');await click('Run read query');await settle(()=>text(tree).includes('41.5'));
 await change('SQL statement',"SELECT printf('%010000d', 1) AS long_value");await click('Run read query');await settle(()=>byLabel('Inspect row 1, column 1'));await event(byLabel('Inspect row 1, column 1'),{type:'click'});assert.equal(byLabel('Full cell value').attributes.value.length,4000);await click('Next');await click('Next');assert.equal(byLabel('Full cell value').attributes.value.length,2000);await click('Close');
 await change('SQL statement','SELECT name,total FROM order_totals ORDER BY name');await click('Run read query');await settle(()=>text(tree).includes('41.5'));
 // Deterministic clipboard transport: no native clipboard or permission-approval claim.
 await change('SQL statement',"SELECT 1 AS id, '=1+1' AS label, NULL AS missing");await click('Run read query');await settle(()=>byLabel('Export format'));
 assert.equal(clipboardCalls.length,0,'Rendering results must not request clipboard access');
 await event(find(n=>n.element==='summary'&&text(n)==='Export returned result'),{type:'click'});
 assert.equal(clipboardCalls.length,0,'Opening export must not request clipboard access');
 assert.equal(byLabel('Export format').attributes.value,'csv');
 const expectedCsv='"id","label","missing"\r\n1,"\'=1+1",\\N\r\n';
 // Native textarea normalizes CRLF for display; the clipboard payload must retain CRLF.
 assert.equal(byLabel('Export preview part').attributes.value,expectedCsv.replaceAll('\r\n','\n'));
 await click('Copy complete returned result');await settle(()=>text(tree).includes('Copy cancelled. No clipboard change was confirmed.'));
 assert.deepEqual(clipboardCalls,[{value:expectedCsv,title:'Copy returned result'}]);assert.doesNotMatch(text(tree),/Export copied/);
 clipboardOutcome=true;await click('Copy complete returned result');await settle(()=>text(tree).includes('Export copied.'));assert.equal(clipboardCalls.length,2);assert.equal(clipboardCalls[1].value,expectedCsv);
 await change('Export format','json');assert.equal(clipboardCalls.length,2,'Changing export format must not copy');
 const expectedJson=JSON.stringify({scope:'returned-rows-only',columns:['id','label','missing'],rows:[[1,'=1+1',null]],truncated:false},null,2);
 assert.equal(byLabel('Export preview part').attributes.value,expectedJson);await click('Copy complete returned result');assert.equal(clipboardCalls[2].value,expectedJson);
 clipboardOutcome=new Error('Synthetic clipboard unavailable');await click('Copy complete returned result');await settle(()=>text(tree).includes('Copy failed: Synthetic clipboard unavailable'));assert.doesNotMatch(text(tree),/Export copied/);
 clipboardOutcome=true;await click('Copy complete returned result');await settle(()=>text(tree).includes('Export copied.'));assert.equal(clipboardCalls[4].value,expectedJson);
 await change('Export format','sql');assert.equal(byLabel('Destination table name').attributes.value,'');assert.match(text(tree),/SQL export requires a valid destination table name/);assert.ok(!button('Copy complete returned result'),'SQL export cannot copy without an explicit table');assert.equal(clipboardCalls.length,5);
 await change('Destination table name','export_target');assert.equal(clipboardCalls.length,5,'Entering SQL destination must not copy');
 const expectedSql='-- Returned rows only; not a full table export.\nINSERT INTO "export_target" ("id", "label", "missing") VALUES (1, \'=1+1\', NULL);';
 assert.equal(byLabel('Export preview part').attributes.value,expectedSql);await click('Copy complete returned result');assert.equal(clipboardCalls[5].value,expectedSql);await snapshot('09-result-export');
 await change('SQL statement','SELECT name,total FROM order_totals ORDER BY name');await click('Run read query');await settle(()=>text(tree).includes('41.5'));
 await act(async()=>{context.environment.locale='zh-CN';environmentListeners.forEach(fn=>fn(context.environment));await tick();});await settle(()=>button('执行只读查询'));assert.equal(byLabel('SQL 语句').attributes.value,'SELECT name,total FROM order_totals ORDER BY name');await snapshot('07-chinese');
 console.log(JSON.stringify({status:'PASS',scope:'Real SQLite + main SDK/remote-DOM validators, injected storage/view transport; no native or Docker claim.',maxNodes,batches,snapshots:9},null,2));
}finally{await act(async()=>{receive({kind:'host-ui.close'});disposables.forEach(d=>d.dispose());await tick();});dom.window.close();}
