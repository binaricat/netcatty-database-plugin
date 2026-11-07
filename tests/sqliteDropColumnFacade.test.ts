import test from 'node:test';import assert from 'node:assert/strict';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import {createWorkbenchContext} from '../src/sqliteClient';
async function setup(t:{after:(fn:()=>void)=>void}){const disposables:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});const review=await context.database.previewCreateTable({...session,draft:{name:'plain',columns:[{name:'id',type:'INTEGER',nullable:false,primaryKey:true},{name:'value',type:'TEXT',nullable:true,primaryKey:false}]}});await context.database.applyCreateTable({...session,review});return {db:context.database,session};}


test('DROP facade preserves other columns and unrelated view, cancels stale review on any other database operation',async t=>{
 const {db,session}=await setup(t);const insert=await db.previewRowInsert({...session,draft:{table:'plain',values:{id:{mode:'value',value:7},value:{mode:'value',value:'deleted'}}}});await db.applyRowInsert({...session,review:insert});
 let review=await db.previewDropColumn({...session,draft:{table:'plain',column:'value'}});assert.equal(review.affectedRows,1);assert.equal(review.warning,'permanently-deletes-column-values');await db.readSchema(session);await assert.rejects(db.applyDropColumn({...session,review}),/review/);
 review=await db.previewDropColumn({...session,draft:{table:'plain',column:'value'}});const result=await db.applyDropColumn({...session,review});assert.deepEqual(result.schema.tables.find(t=>t.name==='plain')!.columns.map(c=>c.name),['id']);
 const rows=await db.query({...session,mode:'read',sql:'SELECT * FROM plain',parameters:[],maxRows:10});assert.deepEqual(rows.rows,[[7]]);const totals=await db.query({...session,mode:'read',sql:'SELECT * FROM order_totals',parameters:[],maxRows:10});assert.ok(totals.rows.length>0);
 await assert.rejects(db.applyDropColumn({...session,review}),/review/);
});
test('DROP explicit cleanup is token-specific, other DDL cancels private review and close refuses',async t=>{
 const {db,session}=await setup(t);const old=await db.previewDropColumn({...session,draft:{table:'plain',column:'value'}}),fresh=await db.previewDropColumn({...session,draft:{table:'plain',column:'value'}});
 await db.cancelDropColumnReview({...session,token:old.token});await db.applyDropColumn({...session,review:fresh});
 const rename=await db.previewRenameTable({...session,draft:{from:'plain',to:'plain_new'}});await db.cancelDropColumnReview({...session,token:old.token});await db.applyRenameTable({...session,review:rename});
 await db.close(session);await assert.rejects(db.previewDropColumn({...session,draft:{table:'plain_new',column:'id'}}),/closed/);
});
test('snapshot operations invalidate DROP review before async storage work',async t=>{
 const storage=new Map<string,unknown>(),disposables:Disposable[]=[];const ctx=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async(k:string)=>storage.get(k),set:async(k:string,v:unknown)=>{storage.set(k,v);}}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));
 const session=await ctx.database.openFixture({});await ctx.database.saveConnection({...session,meta:{name:'Drop snapshot cleanup',color:'blue'}});
 const review=await ctx.database.previewDropColumn({...session,draft:{table:'notes',column:'status'}});await ctx.database.snapshotInfo(session);await assert.rejects(ctx.database.applyDropColumn({...session,review}),/review/);
 const schema=await ctx.database.readSchema(session);assert.ok(schema.tables.find(t=>t.name==='notes')!.columns.some(c=>c.name==='status'));
});
