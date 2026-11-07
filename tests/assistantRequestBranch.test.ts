import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantRequestBranch } from '../src/assistantRequestBranch';
import { DraftStream } from '../src/domain';
import type { PluginAIClient } from '@netcatty/plugin-sdk';
test('snapshot detaches history and retry replaces its turn instead of duplicating it', () => {
  const b = new AssistantRequestBranch();
  const history = [{request:'before',draft:'old'}];
  const snapshot = b.capture('original schema and SQL', 'question', 'fix', history);
  history[0].draft = 'changed';
  const first = b.complete(b.begin(), snapshot, 'first');
  const retry = b.complete(b.begin(), snapshot, 'replacement');
  assert.deepEqual(first, [{request:'before',draft:'old'},{request:'question',draft:'first'}]);
  assert.deepEqual(retry, [{request:'before',draft:'old'},{request:'question',draft:'replacement'}]);
  assert.equal(snapshot.prompt, 'original schema and SQL');
  assert.ok(Object.isFrozen(snapshot.history[0]));
});
test('cancel, reset and replacement invalidate old completions; edit reads only pre-turn history', () => {
  const b = new AssistantRequestBranch();
  const a = b.capture('old','request','generate',[]);
  const rev = b.begin(); b.invalidate();
  assert.equal(b.complete(rev,a,'late'),null);
  assert.equal(b.snapshot,a); // Stop permits explicit retry.
  const nextRev = b.begin();
  assert.deepEqual(b.complete(nextRev,a,'retried'),[{request:'request',draft:'retried'}]);
  assert.deepEqual(b.snapshot?.history,[]);
  b.clear(); assert.equal(b.snapshot,null);
  assert.equal(b.complete(nextRev,a,'late'),null);
});
test('bounded history/request and explicit retry do not invoke a model on capture/edit', () => {
  const b = new AssistantRequestBranch();
  const s = b.capture('bounded prompt','x'.repeat(1600),'explain',
    Array.from({length:9},(_,i)=>({request:String(i),draft:String(i)})));
  assert.equal(s.request.length,1500); assert.equal(s.history.length,3);
  assert.equal(b.complete(b.begin(),s,'reply')?.length,3);
  b.clear(); assert.equal(b.snapshot,null);
});
test('cancelled stream cannot contaminate explicit retry with late open completion', async () => {
  let openCount=0; let release!: (value:{chatHandle:string;model:string})=>void;
  const prompts:string[]=[]; const closed:string[]=[];
  const ai = {
    openChat: async () => ++openCount===1 ? new Promise(resolve=>{release=resolve;}) : {chatHandle:'new',model:'test'},
    startTurn:async ({prompt}:{prompt:string})=>{prompts.push(prompt);return {turnHandle:'turn'};},
    readTurn:async ()=>({sequence:1,kind:'end'}),
    stopTurn:async()=>{}, closeChat:async({chatHandle}:{chatHandle:string})=>{closed.push(chatHandle);},
  } as unknown as PluginAIClient;
  const stream = new DraftStream(ai);
  const first = stream.run('original',()=>assert.fail('late output'));
  await new Promise(resolve=>setImmediate(resolve));
  await stream.stop();
  await stream.run('original',()=>assert.fail('empty'));
  release({chatHandle:'old',model:'test'}); await first;
  assert.deepEqual(prompts,['original']); assert.ok(closed.includes('old'));
});
