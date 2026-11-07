import test from 'node:test';
import assert from 'node:assert/strict';
import type {PluginAgentClient} from '@netcatty/plugin-sdk';
import {AgentSession, type AgentEvent} from '../src/agentSession';
const deferred = <T>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; };
function fixture(events:AgentEvent[] = [{kind:'text',text:'Draft'}, {kind:'end',reason:'completed'}]) {
 const calls:string[]=[];
 const client:PluginAgentClient = {
  listBackends:async()=>({items:[{backendRef:'backend',label:'Mock',backend:'catty',status:'supported',reason:'ready'}]}),
  listChats:async()=>({items:[]}), selectTargets:async()=>{calls.push('select');return {selectionHandle:'selected',expiresAt:100,items:[]};},
  openChat:async p=>{calls.push('open:'+p.selectionHandle+':'+(p.conversationRef??''));return {chatHandle:'chat',conversationRef:'conversation',backendLabel:'Mock',expiresAt:100};},
  history:async()=>({items:[{role:'user',text:'Previous'}]}),
  send:async()=>{calls.push('send');return {turnHandle:'turn',expiresAt:100};},
  read:async()=>events.shift()!, stop:async()=>{calls.push('stop');return {ok:true};},closeChat:async()=>{calls.push('close');return {ok:true};},
 };
 return {client,calls,session:new AgentSession(client,{actionsPermissionDeclared:false},()=>1)};
}
test('conversation selection, resume, history, streaming and close',async()=>{
 const {session,calls}=fixture();await session.open('backend','old');assert.equal(session.state,'ready');
 assert.deepEqual(await session.history(),{items:[{role:'user',text:'Previous'}],omitted:0});
 const output:AgentEvent[]=[];assert.equal((await session.send('Help',e=>output.push(e))).reason,'completed');
 assert.equal(output.length,2);assert.equal(session.state,'ready');await session.close();assert.equal(session.state,'closed');
 assert.deepEqual(calls,['select','open:selected:old','send','stop','close']);
});
test('denied permission is propagated without retry or target selection',async()=>{
 const {session,client,calls}=fixture();const denial=new Error('permissionDenied');client.listBackends=async()=>{throw denial;};
 await assert.rejects(session.open('backend'),e=>e===denial);assert.deepEqual(calls,[]);assert.equal(session.state,'closed');
});
test('late opening after cancellation is closed, never published',async()=>{
 const {session,client,calls}=fixture();const pending=deferred<Awaited<ReturnType<PluginAgentClient['openChat']>>>();
 client.openChat=()=>pending.promise;const opening=session.open('backend');await new Promise(r=>setImmediate(r));await session.stop();
 pending.resolve({chatHandle:'late',conversationRef:'old',backendLabel:'Mock',expiresAt:100});await assert.rejects(opening,/cancelled/);assert.equal(session.state,'closed');assert.deepEqual(calls,['select','close']);
});
test('cancelled read cannot publish late output',async()=>{
 const {session,client}=fixture();await session.open('backend');const pending=deferred<AgentEvent>();client.read=()=>pending.promise;
 const sending=session.send('Question',()=>assert.fail('late event'));await new Promise(r=>setImmediate(r));await session.stop();pending.resolve({kind:'text',text:'late'});await assert.rejects(sending,/cancelled/);assert.equal(session.state,'closed');
});
test('output limits and unexpected actions stop rather than execute SQL',async()=>{
 for(const event of [{kind:'text',text:'x'.repeat(8193)},{kind:'activity',capabilityId:'terminal.execute',state:'started'}] as AgentEvent[]){
  const {session,calls}=fixture([event]);await session.open('backend');await assert.rejects(session.send('Help',()=>assert.fail('unsafe event')),/limit|actions-forbidden/);assert.ok(calls.includes('stop'));
 }
});
test('concurrent sends refuse; input bounds and expiry do not send',async()=>{
 const {session,client,calls}=fixture();await session.open('backend');await assert.rejects(session.send('x'.repeat(12001),()=>{}),/limit/);
 const pending=deferred<AgentEvent>();client.read=()=>pending.promise;const sending=session.send('Question',()=>{});await assert.rejects(session.send('Other',()=>{}),/busy/);
 pending.resolve({kind:'end',reason:'cancelled'});await sending;assert.equal(calls.filter(x=>x==='send').length,1);
});
test('cancelling a pending send cleans its late turn without touching new chat',async()=>{
 const {session,client,calls}=fixture();await session.open('backend');const pending=deferred<Awaited<ReturnType<PluginAgentClient['send']>>>();client.send=()=>pending.promise;
 const sending=session.send('Question',()=>assert.fail('late event'));await session.close();await session.open('backend');pending.resolve({turnHandle:'late-turn',expiresAt:100});await assert.rejects(sending,/cancelled/);assert.equal(session.state,'ready');assert.ok(calls.includes('stop'));
});
test('expired selection and unsupported backend do not open a chat',async()=>{
 const {session,client,calls}=fixture();await assert.rejects(session.open('unknown'),/backend-unavailable/);client.selectTargets=async()=>({selectionHandle:'expired',expiresAt:0,items:[]});await assert.rejects(session.open('backend'),/expired/);assert.ok(!calls.some(x=>x.startsWith('open')));
});
test('history keeps complete bounded messages and discloses omissions',async()=>{
 const {session,client}=fixture();await session.open('backend');client.history=async()=>({items:[{role:'user',text:'x'.repeat(8193)},{role:'assistant',text:'Small'}]});assert.deepEqual(await session.history(),{items:[{role:'assistant',text:'Small'}],omitted:1});
});
