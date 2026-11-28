import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorDraftStorage,type DraftSnapshot} from '../src/editorDraftStorage';
import {createEditorDrafts,serializeEditorDrafts} from '../src/editorDrafts';
function setup(){
  const data=new Map<string,string>();let snapshot:DraftSnapshot|null={connectionId:'saved/one',handleId:'session',revision:1,tabs:[{id:7,sql:'SELECT ?',parameters:'[1]',objectName:'gone',surface:'structure'}],activeTab:7,objectNames:['notes']};
  const applied:unknown[]=[];const confirmations:string[]=[];let confirmed=true;
  const storage={get:async(key:string)=>data.get(key),set:async(key:string,value:string)=>{data.set(key,value);},delete:async(key:string)=>{data.delete(key);}};
  const controller=createEditorDraftStorage({storage,snapshot:()=>snapshot,confirm:async(kind)=>{confirmations.push(kind);return confirmed;},apply:(...args)=>applied.push(args)});
  return {data,storage,controller,applied,confirmations,setSnapshot:(next:DraftSnapshot|null)=>{snapshot=next;},getSnapshot:()=>snapshot!,setConfirmed:(value:boolean)=>{confirmed=value;}};
}
test('explicit save/restore/clear use stable connection key and no session/result data',async()=>{
  const f=setup();assert.equal(f.data.size,0);assert.equal(await f.controller.run('save'),'saved');
  const [key,raw]=[...f.data][0];assert.equal(key,'database.editor-drafts.v1:saved%2Fone');assert.doesNotMatch(raw,/session|handleId|result/);
  assert.equal(await f.controller.run('restore'),'restored-missing');assert.deepEqual(f.confirmations,['restore']);
  assert.deepEqual(f.applied,[[[{id:7,sql:'SELECT ?',parameters:'[1]',surface:'data'}],7,8]]);
  assert.equal(await f.controller.run('clear'),'cleared');assert.deepEqual(f.confirmations,['restore','clear']);assert.equal(f.data.size,0);
});
test('restore and delete cancellation preserve current editors and saved data',async()=>{
  const f=setup();await f.controller.run('save');f.setConfirmed(false);
  assert.equal(await f.controller.run('restore'),'cancelled');assert.equal(await f.controller.run('clear'),'cancelled');assert.equal(f.applied.length,0);assert.equal(f.data.size,1);
});
test('async load cannot overwrite edits or switched connection, including same handle id on a different stable connection',async()=>{
  for(const changed of [{revision:2},{connectionId:'other'},{handleId:'other'}]){
    const f=setup();await f.controller.run('save');let resolve!:(value:string|undefined)=>void;
    f.storage.get=()=>new Promise(r=>{resolve=r;}) as Promise<string|undefined>;
    const pending=f.controller.run('restore');f.setSnapshot({...f.getSnapshot(),...changed});resolve([...f.data.values()][0]);
    assert.equal(await pending,'stale');assert.equal(f.applied.length,0);
  }
});
test('invalid and oversized stored data fail explicitly; storage errors do not apply',async()=>{
  const f=setup();assert.equal(await f.controller.run('restore'),'missing');f.data.set('database.editor-drafts.v1:saved%2Fone','{broken');assert.equal(await f.controller.run('restore'),'invalid');
  f.storage.get=async()=>{throw Error('permission denied');};assert.equal(await f.controller.run('restore'),'failed');assert.equal(f.applied.length,0);
  f.setSnapshot(null);assert.equal(await f.controller.run('save'),'unavailable');
});
test('post-confirmation changes are rechecked and repeated actions are serialized',async()=>{
  let snapshot:DraftSnapshot={connectionId:'one',handleId:'h',revision:1,tabs:[],activeTab:null,objectNames:[]};let resolve!:(value:boolean)=>void;let applied=false;
  const controller=createEditorDraftStorage({storage:{get:async()=>serializeEditorDrafts(createEditorDrafts([],null)),set:async()=>{},delete:async()=>{}},snapshot:()=>snapshot,confirm:()=>new Promise(r=>{resolve=r;}),apply:()=>{applied=true;}});
  const pending=controller.run('restore');await Promise.resolve();assert.equal(await controller.run('save'),'unavailable');snapshot={...snapshot,revision:2};resolve(true);assert.equal(await pending,'stale');assert.equal(applied,false);
});
test('a run that finishes before restore confirmation still invalidates the pending restore generation',async()=>{
  let revision=1;let queryBusy=false;let answer!:(value:boolean)=>void;let applied=false;
  const snapshot:DraftSnapshot={connectionId:'one',handleId:'h',revision:1,tabs:[{id:1,sql:'SELECT 1',parameters:'[]'}],activeTab:1,objectNames:[]};
  const controller=createEditorDraftStorage({storage:{get:async()=>serializeEditorDrafts(createEditorDrafts(snapshot.tabs,1)),set:async()=>{},delete:async()=>{}},snapshot:()=>queryBusy?null:{...snapshot,revision},confirm:()=>new Promise(r=>{answer=r;}),apply:()=>{applied=true;}});
  const pending=controller.run('restore');await Promise.resolve();
  // The hook advances this generation at execute start, independent of busy state.
  queryBusy=true;revision++;await Promise.resolve();queryBusy=false;answer(true);
  assert.equal(await pending,'stale');assert.equal(applied,false);
});
