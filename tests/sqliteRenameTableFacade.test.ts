import test from 'node:test';import assert from 'node:assert/strict';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import {createWorkbenchContext} from '../src/sqliteClient';
async function setup(t:{after:(fn:()=>void)=>void}){const disposables:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});const review=await context.database.previewCreateTable({...session,draft:{name:'plain',columns:[{name:'id',type:'INTEGER',nullable:false,primaryKey:true},{name:'value',type:'TEXT',nullable:true,primaryKey:false}]}});await context.database.applyCreateTable({...session,review});return {db:context.database,session};}

test('facade table rename preserves bound data and consumes shared review',async t=>{
 const {db,session}=await setup(t);
 const insert=await db.previewRowInsert({...session,draft:{table:'plain',values:{id:{mode:'value',value:1},value:{mode:'value',value:'keep'}}}});
 await db.applyRowInsert({...session,review:insert});
 const before=await db.readSchema(session);const review=await db.previewRenameTable({...session,draft:{from:'plain',to:'renamed_table'}});
 assert.deepEqual(await db.readSchema(session),before);
 const result=await db.applyRenameTable({...session,review});assert.ok(result.schema.tables.some(t=>t.name==='renamed_table'));
 assert.ok(!result.schema.tables.some(t=>t.name==='plain'));
 const rows=await db.query({...session,mode:'read',sql:'SELECT * FROM renamed_table',parameters:[],maxRows:10});assert.deepEqual(rows.rows,[[1,'keep']]);
 await assert.rejects(db.applyRenameTable({...session,review}),/review/);
});
test('facade cross-operation previews invalidate table rename and closed handles refuse',async t=>{
 const {db,session}=await setup(t);const review=await db.previewRenameTable({...session,draft:{from:'plain',to:'renamed_table'}});
 await db.previewAddColumn({...session,draft:{table:'plain',name:'extra',type:'TEXT'}});
 await assert.rejects(db.applyRenameTable({...session,review}),/review/);
 const fresh=await db.previewRenameTable({...session,draft:{from:'plain',to:'renamed_table'}});await db.close(session);
 await assert.rejects(db.applyRenameTable({...session,review:fresh}),/review|closed/);
});
