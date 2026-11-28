import test from 'node:test';import assert from 'node:assert/strict';
import {createSchemaBusyOwners,type SchemaBusyCallback} from '../src/schemaBusy';
import {createTableController} from '../src/CreateTable';import {createIndexController} from '../src/CreateIndex';
import type {DatabaseSchemaResult} from '../src/databaseTypes';import type {PluginDatabaseClient} from '../src/databaseClient';
const schema:DatabaseSchemaResult={tables:[{name:'notes',kind:'table',columns:[{name:'id',type:'INTEGER',primaryKey:true}]}]};
const result={schema,sql:'reviewed SQL',changes:0 as const};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function fixture(kind:'table'|'index',busy:SchemaBusyCallback){const pending:Array<ReturnType<typeof deferred<typeof result>>>=[];let applies=0,previews=0,callbacks=0;
 const tableDb:Pick<PluginDatabaseClient,'previewCreateTable'|'applyCreateTable'>={previewCreateTable:async({handleId,draft})=>{previews++;return {handleId,draft,sql:'reviewed SQL',schemaRevision:1};},applyCreateTable:async()=>{applies++;const d=deferred<typeof result>();pending.push(d);return d.promise;}};
 const indexDb:Pick<PluginDatabaseClient,'previewCreateIndex'|'applyCreateIndex'>={previewCreateIndex:async({handleId,draft})=>{previews++;return {handleId,draft,sql:'reviewed SQL',schemaRevision:1};},applyCreateIndex:async()=>{applies++;const d=deferred<typeof result>();pending.push(d);return d.promise;}};
 return {make:()=>kind==='table'?createTableController(tableDb,'same-handle',()=>callbacks++,busy):createIndexController(indexDb,'same-handle',schema,()=>callbacks++,busy),pending,get applies(){return applies;},get previews(){return previews;},get callbacks(){return callbacks;}};
}
for(const kind of ['table','index'] as const){
 test(`${kind}: disposed old apply cannot unlock replacement controller's pending apply`,async()=>{const transitions:boolean[]=[],owners=createSchemaBusyOwners(b=>transitions.push(b)),f=fixture(kind,(b,o)=>owners.set(b,o));
  const old=f.make();old.setName('old');await old.preview();const oldWork=old.confirm();assert.equal(owners.busy,true);old.dispose();assert.equal(owners.busy,true,'unmount must not release an actual operation');
  const next=f.make();next.setName('new');await next.preview();const newWork=next.confirm();assert.equal(f.applies,2);assert.equal(owners.busy,true);
  const countBeforeOld=transitions.length;f.pending[0].resolve(result);await oldWork;assert.equal(owners.busy,true);assert.equal(transitions.length,countBeforeOld,'old completion cannot notify global false');assert.equal(f.callbacks,0);
  f.pending[1].resolve(result);await newWork;assert.equal(owners.busy,false);assert.equal(transitions.at(-1),false);assert.equal(f.callbacks,1);assert.equal(next.getSnapshot().busy,'idle');assert.equal(next.getSnapshot().created,true);
 });
 test(`${kind}: throwing acquire notification prevents submit and rolls back its busy ownership`,async()=>{let shouldThrow=false;const owners=createSchemaBusyOwners(()=>{}),f=fixture(kind,(b,o)=>{owners.set(b,o);if(b&&shouldThrow)throw new Error('notification failure');});const c=f.make();c.setName('name');await c.preview();assert.ok(c.getSnapshot().review);shouldThrow=true;await c.confirm();assert.equal(f.applies,0);assert.equal(owners.busy,false);assert.equal(c.getSnapshot().busy,'idle');assert.equal(c.getSnapshot().created,false);assert.equal(c.getSnapshot().review,null);
 });
 test(`${kind}: throwing release notification cannot reject committed result or strand busy`,async()=>{const owners=createSchemaBusyOwners(()=>{}),f=fixture(kind,(b,o)=>{owners.set(b,o);if(!b)throw new Error('release notification failure');});const c=f.make();c.setName('name');await c.preview();const work=c.confirm();assert.equal(f.applies,1);f.pending[0].resolve(result);await work;assert.equal(owners.busy,false);assert.equal(c.getSnapshot().busy,'idle');assert.equal(c.getSnapshot().created,true);assert.equal(f.callbacks,1);
 });
}
test('CreateTable preview notification failure does not dispatch preview or leave local busy',async()=>{const owners=createSchemaBusyOwners(()=>{}),f=fixture('table',(b,o)=>{owners.set(b,o);if(b)throw new Error('notify');});const c=f.make();c.setName('name');await c.preview();assert.equal(f.previews,0);assert.equal(c.getSnapshot().busy,'idle');assert.equal(owners.busy,false);assert.equal(c.getSnapshot().review,null);});

test('RowInsert disposed old apply does not release newer controller lease',async()=>{
 const {rowInsertController}=await import('../src/RowInsert');const changes:boolean[]=[],owners=createSchemaBusyOwners(b=>changes.push(b));const pending:Array<ReturnType<typeof deferred<{changes:1}>>>=[];let callbacks=0;
 const db:Pick<PluginDatabaseClient,'previewRowInsert'|'applyRowInsert'>={previewRowInsert:async({handleId,draft})=>({handleId,draft,schemaRevision:1,sql:'INSERT INTO notes(id) VALUES (?)',parameters:[1],resolved:{id:1},automaticColumns:[]}),applyRowInsert:async()=>{const d=deferred<{changes:1}>();pending.push(d);return d.promise;}};
 const make=()=>rowInsertController(db,'same-handle','notes',schema,()=>callbacks++,(b,o)=>owners.set(b,o));
 const old=make();old.edit('id',{value:'1'});await old.preview();const oldWork=old.confirm();assert.equal(owners.busy,true);old.dispose();const newer=make();newer.edit('id',{value:'2'});await newer.preview();const newWork=newer.confirm();assert.equal(pending.length,2);pending[0].resolve({changes:1});await oldWork;assert.equal(owners.busy,true);assert.deepEqual(changes,[true]);assert.equal(callbacks,0);pending[1].resolve({changes:1});await newWork;assert.equal(owners.busy,false);assert.deepEqual(changes,[true,false]);assert.equal(callbacks,1);assert.equal(newer.getSnapshot().done,true);
});
test('RowInsert busy acquire throw prevents insertion and releases local/global busy',async()=>{const {rowInsertController}=await import('../src/RowInsert');const owners=createSchemaBusyOwners(()=>{});let submits=0;const db:Pick<PluginDatabaseClient,'previewRowInsert'|'applyRowInsert'>={previewRowInsert:async({handleId,draft})=>({handleId,draft,schemaRevision:1,sql:'INSERT INTO notes(id) VALUES (?)',parameters:[1],resolved:{id:1},automaticColumns:[]}),applyRowInsert:async()=>{submits++;return {changes:1};}};const c=rowInsertController(db,'h','notes',schema,()=>{},(b,o)=>{owners.set(b,o);if(b)throw new Error('notification');});c.edit('id',{value:'1'});await c.preview();await c.confirm();assert.equal(submits,0);assert.equal(owners.busy,false);assert.equal(c.getSnapshot().busy,'idle');});
