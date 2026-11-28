import test from 'node:test';
import assert from 'node:assert/strict';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import {createWorkbenchContext} from '../src/sqliteClient';
async function setup(t:{after:(fn:()=>void)=>void}){const disposables:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});const read=(sql:string)=>context.database.query({...session,sql,parameters:[],mode:'read'});const preview=(csv:string,table='notes')=>context.database.previewCsvImport({...session,draft:{table,csv,nullMode:'backslash-N'}});return {db:context.database,session,read,preview};}
test('CSV preview inserts nothing; exact confirmation atomically imports every row once',async t=>{
 const {db,session,read,preview}=await setup(t);const review=await preview('title,status,id\n"A, B",open,4\n"Line\nTwo",done,5');assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);
 assert.deepEqual(await db.applyCsvImport({...session,review}),{changes:2});assert.deepEqual((await read('SELECT id,title,status FROM notes WHERE id>3 ORDER BY id')).rows,[[4,'A, B','open'],[5,'Line\nTwo','done']]);await assert.rejects(db.applyCsvImport({...session,review}),/review/);
});
test('constraint failure after an inserted row rolls back the entire import and restores read protection',async t=>{
 const {db,session,read,preview}=await setup(t);const review=await preview('id,title,status\n4,will rollback,open\n1,duplicate,open');await assert.rejects(db.applyCsvImport({...session,review}),/UNIQUE/);assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);await assert.rejects(db.applyCsvImport({...session,review}),/consumed/);await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
test('foreign key failure rolls back earlier rows and literal SQL content is not executable',async t=>{
 const {db,session,read,preview}=await setup(t);const bad=await preview('id,customer_id,amount,memo\n4,1,2,first\n5,999,2,invalid','orders');await assert.rejects(db.applyCsvImport({...session,review:bad}),/FOREIGN KEY/);assert.deepEqual((await read('SELECT count(*) FROM orders')).rows,[[3]]);
 const review=await preview('id,title,status\n4,"DELETE FROM notes; --",open');await db.applyCsvImport({...session,review});assert.deepEqual((await read('SELECT title FROM notes WHERE id=4')).rows,[['DELETE FROM notes; --']]);assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[4]]);
});
test('tampering, cross handle, schema change and close reject import',async t=>{
 const {db,session,preview}=await setup(t);const review=await preview('id,title,status\n4,hello,open');await assert.rejects(db.applyCsvImport({...session,review:{...review,plan:{...review.plan,rowCount:99}}}),/review/);const other=await db.openFixture({});await assert.rejects(db.applyCsvImport({...other,review}),/stale/);
 const index=await db.previewCreateIndex({...session,draft:{name:'csv_guard',table:'notes',unique:false,columns:[{name:'title',direction:'ASC'}]}});await db.applyCreateIndex({...session,review:index});await assert.rejects(db.applyCsvImport({...session,review}),/stale/);const pending=await preview('id,title,status\n4,hello,open');await db.close(session);await assert.rejects(db.applyCsvImport({...session,review:pending}),/closed/);
});
test('NULL versus empty text survives binding without automatic primary keys',async t=>{
 const {db,session,read,preview}=await setup(t);const review=await preview('id,customer_id,amount,memo\n4,1,2,\\N\n5,1,2,','orders');await db.applyCsvImport({...session,review});assert.deepEqual((await read('SELECT memo FROM orders WHERE id>3 ORDER BY id')).rows,[[null],['']]);
});
