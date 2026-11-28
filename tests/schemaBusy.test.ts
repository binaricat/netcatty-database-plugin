import test from 'node:test';import assert from 'node:assert/strict';
import {acquireSchemaBusy,createSchemaBusyOwners} from '../src/schemaBusy';
import {snapshotController} from '../src/SnapshotPanel';import {persistentQueryController} from '../src/PersistentQueryLibrary';import {gridBatchController} from '../src/GridBatchPanel';import {previewGridBatch} from '../src/gridBatchMutation';import type {DatabaseSchemaResult,GridBatchReview} from '../src/databaseTypes';
const deferred=<T>()=>{let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('owned leases are idempotent, coexist with legacy owner and cannot release another operation',()=>{
 const events:boolean[]=[],owners=createSchemaBusyOwners(b=>events.push(b));owners.set(true);const a=acquireSchemaBusy(owners.set),b=acquireSchemaBusy(owners.set);owners.set(false);assert.equal(owners.busy,true);a();a();assert.equal(owners.busy,true);owners.set(false,Symbol('foreign'));b();assert.equal(owners.busy,false);assert.deepEqual(events,[true,false]);
 assert.throws(()=>acquireSchemaBusy((busy,owner)=>{owners.set(busy,owner);if(busy)throw Error('callback');}));assert.equal(owners.busy,false);
});
test('snapshot pending restore survives dispose; old completion cannot unlock new snapshot operation or publish',async()=>{
 const owners=createSchemaBusyOwners(()=>{}),a=deferred<{schema:DatabaseSchemaResult}>(),b=deferred<undefined>();let applied=0;
 const db={snapshotInfo:()=>b.promise,saveSnapshot:async()=>{throw Error('unused');},previewRestoreSnapshot:async()=>({handleId:'h',token:'x',info:{version:1 as const,savedConnectionId:'s',byteLength:4096,sha256:'a'.repeat(64),savedAt:0},schema:{tables:[]}}),applyRestoreSnapshot:()=>a.promise,deleteSnapshot:async()=>null};
 const old=snapshotController(db,'h',()=>applied++,owners.set);await old.preview();const p=old.confirmRestore();old.dispose();old.dispose();assert.equal(owners.busy,true);
 const next=snapshotController(db,'h',()=>applied++,owners.set),q=next.inspect();a.resolve({schema:{tables:[]}});await p;assert.equal(owners.busy,true);assert.equal(applied,0);assert.equal(next.getSnapshot().busy,true);b.reject(Error('storage failure'));await q;assert.equal(owners.busy,false);assert.equal(next.getSnapshot().notice,'failed');
});
test('query library late disposed read cannot unlock second operation and rejection releases its own lease',async()=>{
 const owners=createSchemaBusyOwners(()=>{}),a=deferred<never>(),b=deferred<never>();let calls=0;
 const store={load:()=>++calls===1?a.promise:b.promise,save:async()=>{throw Error('unused');},remove:async()=>{throw Error('unused');}};
 const old=persistentQueryController(store,'s',()=>true,()=>assert.fail('no load'),owners.set),p=old.load();old.dispose();const next=persistentQueryController(store,'s',()=>true,()=>assert.fail('no load'),owners.set),q=next.load();a.reject(Error('old'));await p;assert.equal(owners.busy,true);assert.equal(next.getSnapshot().busy,true);b.reject(Error('new'));await q;assert.equal(owners.busy,false);
});
test('grid batch disposed pending apply holds lease until settlement and cannot unlock newer queued preview',async()=>{
 const schema:DatabaseSchemaResult={tables:[{name:'t',kind:'table',definition:'CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT)',triggers:[],foreignKeys:[],columns:[{name:'id',type:'INTEGER',nullable:false,primaryKey:true,defaultSql:null,rowidAlias:true},{name:'value',type:'TEXT',nullable:true,primaryKey:false,defaultSql:null,rowidAlias:false}]}]};
 const a=deferred<{changes:number}>(),b=deferred<GridBatchReview>();let previews=0,applied=0;const owners=createSchemaBusyOwners(()=>{});
 const db={previewGridBatch:async({handleId,draft}:{handleId:string;draft:Parameters<typeof previewGridBatch>[0]}):Promise<GridBatchReview>=>++previews===1?{handleId,kind:'grid-batch',token:'x',schemaRevision:1,plan:previewGridBatch(draft,schema)}:b.promise,applyGridBatch:()=>a.promise};
 const make=()=>gridBatchController(db,'h',schema,'t',['id','value'],[[1,'v']],()=>applied++,owners.set);
 const old=make();old.toggle(0);await old.preview();const p=old.confirm();old.dispose();assert.equal(owners.busy,true);const next=make();next.toggle(0);const q=next.preview();await new Promise(r=>setImmediate(r));a.resolve({changes:1});await p;assert.equal(applied,0);assert.equal(owners.busy,true);assert.equal(next.getSnapshot().busy,'preview');b.reject(Error('new'));await q;assert.equal(owners.busy,false);
});
