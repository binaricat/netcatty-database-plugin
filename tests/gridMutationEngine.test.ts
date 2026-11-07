import test from 'node:test';
import assert from 'node:assert/strict';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import {createWorkbenchContext} from '../src/sqliteClient';
import type {DatabaseScalar} from '../src/databaseTypes';
async function setup(t:{after:(fn:()=>void)=>void}){const disposables:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});const read=(sql:string)=>context.database.query({...session,sql,parameters:[],mode:'read'});const write=(sql:string,parameters:DatabaseScalar[]=[])=>context.database.query({...session,sql,parameters,mode:'write',writeConfirmation:{handleId:session.handleId,sql,parameters}});const row=(await read('SELECT id,title,status FROM notes WHERE id=1')).rows[0];return {db:context.database,session,read,write,original:{id:row[0],title:row[1],status:row[2]}};}
test('actual grid update previews without execution and applies once to exactly one identified original row',async t=>{
 const {db,session,read,original}=await setup(t);const review=await db.previewGridMutation({...session,draft:{kind:'update',table:'notes',original,changes:{title:'Edited from grid'}}});
 assert.deepEqual((await read('SELECT title FROM notes WHERE id=1')).rows,[[original.title]]);
 assert.deepEqual(await db.applyGridMutation({...session,review}),{changes:1});assert.deepEqual((await read('SELECT title FROM notes WHERE id=1')).rows,[['Edited from grid']]);
 await assert.rejects(db.applyGridMutation({...session,review}),/review/);assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
test('concurrent data edit causes conflict and rollback; latest data is never overwritten',async t=>{
 const {db,session,read,write,original}=await setup(t);const review=await db.previewGridMutation({...session,draft:{kind:'update',table:'notes',original,changes:{title:'stale replacement'}}});
 await write('UPDATE notes SET title=? WHERE id=?',['Other editor',1]);await assert.rejects(db.applyGridMutation({...session,review}),/conflict/);assert.deepEqual((await read('SELECT title FROM notes WHERE id=1')).rows,[['Other editor']]);await assert.rejects(db.previewGridMutation({...session,draft:{kind:'delete',table:'notes',original}}),/conflict/);
 await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
test('delete requires exact review and removes only selected row, with no automatic retry',async t=>{
 const {db,session,read,original}=await setup(t);const review=await db.previewGridMutation({...session,draft:{kind:'delete',table:'notes',original}});
 await assert.rejects(db.applyGridMutation({...session,review:{...review,sql:'DELETE FROM notes'}}),/review/);
 const other=await db.openFixture({});await assert.rejects(db.applyGridMutation({...other,review}),/stale/);
 assert.deepEqual(await db.applyGridMutation({...session,review}),{changes:1});assert.deepEqual((await read('SELECT id FROM notes ORDER BY id')).rows,[[2],[3]]);await assert.rejects(db.applyGridMutation({...session,review}),/review/);
});
test('NULL comparisons and quoted/text parameter values preserve literal meaning',async t=>{
 const {db,session,read}=await setup(t);const row=(await read('SELECT id,customer_id,amount,memo FROM orders WHERE id=1')).rows[0];const original={id:row[0],customer_id:row[1],amount:row[2],memo:row[3]};const value="'; DELETE FROM notes; --";
 const review=await db.previewGridMutation({...session,draft:{kind:'update',table:'orders',original,changes:{memo:value}}});await db.applyGridMutation({...session,review});assert.deepEqual((await read('SELECT memo FROM orders WHERE id=1')).rows,[[value]]);assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);
});
test('DDL invalidates old schema revision; closed handle cannot apply',async t=>{
 const {db,session,original}=await setup(t);const review=await db.previewGridMutation({...session,draft:{kind:'delete',table:'notes',original}});const index=await db.previewCreateIndex({...session,draft:{name:'guard_index',table:'notes',unique:false,columns:[{name:'title',direction:'ASC'}]}});await db.applyCreateIndex({...session,review:index});await assert.rejects(db.applyGridMutation({...session,review}),/stale/);
 const pending=await db.previewGridMutation({...session,draft:{kind:'delete',table:'notes',original}});await db.close(session);await assert.rejects(db.applyGridMutation({...session,review:pending}),/closed/);
});
