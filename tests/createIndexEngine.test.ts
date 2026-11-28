import test from 'node:test';
import assert from 'node:assert/strict';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import {createWorkbenchContext} from '../src/sqliteClient';
import type {DatabaseCreateIndexDraft} from '../src/schemaCreateIndex';
const draft=(name='notes_title_index'):DatabaseCreateIndexDraft=>({name,table:'notes',unique:false,columns:[{name:'title',direction:'DESC'},{name:'id',direction:'ASC'}]});
async function setup(t:{after:(fn:()=>void)=>void}){const disposables:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});return {db:context.database,session,read:(sql:string)=>context.database.query({...session,sql,parameters:[],mode:'read'})};}
test('reviewed CREATE INDEX changes actual schema only on explicit confirmation and preserves column order/directions',async t=>{
 const {db,session,read}=await setup(t);const review=await db.previewCreateIndex({...session,draft:draft()});
 assert.ok(!(await db.readSchema(session)).tables.find(t=>t.name==='notes')!.indexes!.some(i=>i.name===draft().name));
 const result=await db.applyCreateIndex({...session,review});const index=result.schema.tables.find(t=>t.name==='notes')!.indexes!.find(i=>i.name===draft().name)!;
 assert.ok(index);assert.equal(index.unique,false);assert.deepEqual(index.columns.map(c=>[c.name,c.descending]),[['title',true],['id',false]]);
 await assert.rejects(db.applyCreateIndex({...session,review}),/stale|review/);assert.deepEqual((await read('SELECT COUNT(*) FROM notes')).rows,[[3]]);
 await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
test('index review cannot cross sessions, change SQL, outlive session or survive another DDL preview',async t=>{
 const {db,session}=await setup(t);const review=await db.previewCreateIndex({...session,draft:draft()});const other=await db.openFixture({});
 await assert.rejects(db.applyCreateIndex({...other,review}),/stale/);
 await assert.rejects(db.applyCreateIndex({...session,review:{...review,sql:review.sql+' DROP TABLE notes;'}}),/review/);
 await db.previewCreateTable({...session,draft:{name:'other',columns:[{name:'id',type:'INTEGER',nullable:false,primaryKey:true}]}});
 await assert.rejects(db.applyCreateIndex({...session,review}),/review/);
 const closed=await db.previewCreateIndex({...session,draft:draft()});await db.close(session);await assert.rejects(db.applyCreateIndex({...session,review:closed}),/closed/);
});
test('unique constraint failure rolls back index and schema revision, consumes review and restores read protection',async t=>{
 const {db,session,read}=await setup(t);const input:DatabaseCreateIndexDraft={name:'unique_status',table:'notes',unique:true,columns:[{name:'status',direction:'ASC'}]};
 const review=await db.previewCreateIndex({...session,draft:input});await assert.rejects(db.applyCreateIndex({...session,review}),/UNIQUE/i);
 assert.ok(!(await db.readSchema(session)).tables.find(t=>t.name==='notes')!.indexes!.some(i=>i.name===input.name));
 await assert.rejects(db.applyCreateIndex({...session,review}),/review/);
 const retry=await db.previewCreateIndex({...session,draft:input});assert.equal(retry.schemaRevision,review.schemaRevision);
 assert.deepEqual((await read('SELECT COUNT(*) FROM notes')).rows,[[3]]);await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
test('quoted index identifier cannot inject SQL, and successful subsequent DDL makes earlier schema review stale',async t=>{
 const {db,session,read}=await setup(t);const name='idx"; DROP TABLE notes;--';const review=await db.previewCreateIndex({...session,draft:draft(name)});const result=await db.applyCreateIndex({...session,review});assert.ok(result.schema.tables.find(t=>t.name==='notes')!.indexes!.some(i=>i.name===name));assert.deepEqual((await read('SELECT COUNT(*) FROM notes')).rows,[[3]]);
 const pending=await db.previewCreateIndex({...session,draft:draft('pending')});const table=await db.previewCreateTable({...session,draft:{name:'another',columns:[{name:'id',type:'INTEGER',nullable:false,primaryKey:true}]}});await db.applyCreateTable({...session,review:table});await assert.rejects(db.applyCreateIndex({...session,review:pending}),/stale/);
});
