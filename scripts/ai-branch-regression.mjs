// Isolated real React component/hook events with an injected deterministic provider.
// No real provider, native UI, network, SQL execution or permissions are exercised.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root=process.cwd(),hostRoot=process.env.NETCATTY_HOST_ROOT;
if(!hostRoot||!path.isAbsolute(hostRoot))throw new Error('Set NETCATTY_HOST_ROOT to the current main checkout.');
const host=createRequire(path.join(hostRoot,'package.json')),plugin=createRequire(path.join(root,'package.json'));
const {JSDOM}=host('jsdom');const dom=new JSDOM('<!doctype html><body><div id="app"></div></body>',{url:'https://synthetic.invalid'});
for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Event','MouseEvent'])Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom.window:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=plugin('react'),{act}=React,{createRoot}=plugin('react-dom/client');
const temp=await mkdtemp(path.join(os.tmpdir(),'ai-branch-'));
try {
 await host('esbuild').build({entryPoints:['src/SqlAssistant.tsx'],outfile:path.join(temp,'component.cjs'),bundle:true,platform:'node',format:'cjs',plugins:[{name:'shared-react',setup(b){b.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},a=>({path:plugin.resolve(a.path),external:true}));}}]});
 const {SqlAssistant}=plugin(path.join(temp,'component.cjs'));
 let nextMode='ok',id=0;const turns=new Map(),prompts=[],calls=[];let late;
 const context={enabledFeatures:new Set(['ai.model-invocation']),ai:{
  openChat:async()=>{calls.push('open');return {chatHandle:'chat'+(++id),model:'Injected test provider'};},
  startTurn:async({prompt})=>{prompts.push(prompt);const handle='turn'+id;turns.set(handle,{mode:nextMode,read:0});nextMode='ok';return {turnHandle:handle};},
  readTurn:async({turnHandle})=>{const t=turns.get(turnHandle);t.read++;if(t.mode==='pending')return new Promise(resolve=>{late=resolve;});if(t.mode==='fail')throw new Error('Injected failure');return t.read===1?{sequence:1,kind:'text',text:'```sql\nSELECT '+id+'\n```'}:{sequence:2,kind:'end'};},
  stopTurn:async()=>{calls.push('stop');},closeChat:async()=>{calls.push('close');},
 }};
 const schema=name=>({tables:[{name,columns:[{name:'id',type:'INTEGER',primaryKey:true}]}]});
 let props={context,schema:schema('original_table'),sql:'SELECT original',label:'Original',disabled:false,insert:()=>assert.fail('No implicit SQL insertion'),t:key=>key};
 const app=createRoot(document.getElementById('app'));
 const render=async()=>{await act(async()=>{app.render(React.createElement(SqlAssistant,props));});};
 const button=label=>[...document.querySelectorAll('button')].find(e=>e.textContent===label);
 const click=async label=>{const el=button(label);assert.ok(el,label);assert.equal(el.disabled,false,label+' enabled');await act(async()=>{el.dispatchEvent(new MouseEvent('click',{bubbles:true}));});};
 const input=async value=>{const el=document.querySelector('textarea[aria-label="Your request"]');await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});};
 const envelope=prompt=>JSON.parse(prompt.split('BEGIN_UNTRUSTED_JSON\n')[1].split('\nEND_UNTRUSTED_JSON')[0]);
 await render();assert.equal(calls.length,0);
 await input('Original request');await click('Run assistance');assert.equal(prompts.length,1);assert.equal(envelope(prompts[0]).request,'Original request');
 props={...props,schema:schema('new_table'),sql:'SELECT changed',label:'Changed'};await render();
 await click('Retry last request');assert.equal(prompts.length,2);assert.equal(prompts[1],prompts[0]);
 assert.match(document.body.textContent,/original SQL and schema/);
 await click('Edit last request');assert.equal(prompts.length,2);assert.equal(document.querySelector('textarea').value,'Original request');
 await input('Edited request');await click('Run assistance');assert.equal(prompts.length,3);
 const edited=envelope(prompts[2]);assert.equal(edited.sql,'SELECT changed');assert.equal(edited.schema.tables[0].name,'new_table');assert.equal(edited.request,'Edited request');assert.deepEqual(edited.conversation,[]);
 await click('Retry last request');assert.equal(prompts[3],prompts[2]);
 await input('Follow-up');await click('Run assistance');const follow=envelope(prompts[4]);assert.equal(follow.conversation.length,1);assert.equal(follow.conversation[0].request,'Edited request');
 nextMode='pending';await input('Stopped request');await click('Run assistance');assert.equal(button('Retry last request').disabled,true);
 await click('Stop');await click('Retry last request');const afterRetry=document.querySelector('pre').textContent;assert.match(afterRetry,/SELECT 7/);
 await act(async()=>{late({sequence:1,kind:'text',text:'LATE CONTAMINATION'});});assert.equal(document.querySelector('pre').textContent,afterRetry);
 await input('After stop');await click('Run assistance');const after=envelope(prompts.at(-1));assert.equal(after.conversation.filter(t=>t.request==='Stopped request').length,1);assert.ok(after.conversation.every(t=>!t.draft.includes('LATE')));
 nextMode='fail';await input('Failed request');await click('Run assistance');assert.ok(document.querySelector('[role="alert"]'));assert.equal(button('Insert draft into editor').disabled,true);
 const failedPrompt=prompts.at(-1);await click('Retry last request');assert.equal(prompts.at(-1),failedPrompt);assert.equal(document.querySelector('[role="alert"]'),null);
 await click('New AI conversation');assert.equal(button('Retry last request'),undefined);assert.equal(button('Edit last request'),undefined);
 await act(async()=>{app.unmount();});
 console.log(JSON.stringify({status:'PASS',scope:'Real SqlAssistant/useSqlAssistant React click/input events; injected fake provider only',checks:['retry snapshot unchanged after schema/SQL change','edit sends nothing then Run uses current context','successful retry replaces branch without duplication','stop and late stream cannot contaminate retry','failure explicitly retried','reset removes retry state'],modelRequests:prompts.length},null,2));
} finally {dom.window.close();await rm(temp,{recursive:true,force:true});}
