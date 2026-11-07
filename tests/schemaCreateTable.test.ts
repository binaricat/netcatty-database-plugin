import test from 'node:test';
import assert from 'node:assert/strict';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import {previewCreateTableSql,type DatabaseCreateTableDraft} from '../src/schemaCreateTable';
import {createWorkbenchContext} from '../src/sqliteClient';
const draft=(name='created'):DatabaseCreateTableDraft=>({name,columns:[{name:'id',type:'INTEGER',nullable:false,primaryKey:true},{name:'label',type:'TEXT',nullable:true,primaryKey:false}]});
async function setup(t:{after:(fn:()=>void)=>void}){const disposables:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});return {db:context.database,session,read:(sql:string)=>context.database.query({...session,sql,parameters:[],mode:'read'})};}
test('pure model generates exact quoted plain CREATE TABLE without mutating draft',()=>{
 const input=draft('a"; DROP TABLE notes;--');const {sql,draft:copy}=previewCreateTableSql(input);
 assert.equal(sql,'CREATE TABLE "a""; DROP TABLE notes;--" (\n  "id" INTEGER NOT NULL PRIMARY KEY,\n  "label" TEXT\n);');assert.deepEqual(copy,input);assert.notEqual(copy,input);assert.notEqual(copy.columns,input.columns);
});
test('pure model rejects extra syntax, invalid identifiers, duplicate columns and contradictory PK/nullability',()=>{
 for(const input of [{...draft(),default:'x'},{...draft(),columns:[]},{...draft(),name:'sqlite_master'},{...draft(),name:'\0'},{...draft(),name:' '},{...draft(),name:'x'.repeat(129)},{...draft(),columns:[{...draft().columns[0],nullable:true}]},{...draft(),columns:[...draft().columns,{...draft().columns[0],name:'ID'}]},{...draft(),columns:[...draft().columns,{...draft().columns[0],name:'other'}]},{...draft(),columns:[{...draft().columns[0],type:'TEXT); DROP TABLE notes;--'}]},{...draft(),columns:[{...draft().columns[0],expression:'1'}]},{...draft(),columns:Array.from({length:33},(_,i)=>({...draft().columns[1],name:`c${i}`}))}])assert.throws(()=>previewCreateTableSql(input));
 assert.throws(()=>previewCreateTableSql(draft('NOTES'),['notes']),/exists/);
});
test('preview does not create anything; explicit apply creates zero rows, preserves notes and refreshes real schema',async t=>{
 const {db,session,read}=await setup(t);const name='a"; DROP TABLE notes;--';const review=await db.previewCreateTable({...session,draft:draft(name)});
 assert.equal((await db.readSchema(session)).tables.some(table=>table.name===name),false);assert.ok(Number.isInteger(review.schemaRevision));
 const result=await db.applyCreateTable({...session,review});assert.equal(result.changes,0);assert.equal(result.sql,review.sql);assert.ok(result.schema.tables.some(table=>table.name===name));
 assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);
 assert.deepEqual((await read('SELECT count(*) FROM "a""; DROP TABLE notes;--"')).rows,[[0]]);
 await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
 await assert.rejects(db.query({...session,sql:'CREATE TABLE bypass(a)',parameters:[],mode:'write',writeConfirmation:{handleId:session.handleId,sql:'CREATE TABLE bypass(a)',parameters:[]}}),/only INSERT/);
});
test('existing objects, cross-connection, edited/fabricated reviews, stale revision and closed sessions refuse',async t=>{
 const {db,session}=await setup(t);await assert.rejects(db.previewCreateTable({...session,draft:draft('notes')}),/exists/);
 const first=await db.previewCreateTable({...session,draft:draft('first')});const secondSession=await db.openFixture({});await assert.rejects(db.applyCreateTable({...secondSession,review:first}),/stale/);
 const forged={...first,...previewCreateTableSql(draft('forged'))};await assert.rejects(db.applyCreateTable({...session,review:forged}),/review/);
 await assert.rejects(db.applyCreateTable({...session,review:{...first,sql:first.sql+' DROP TABLE notes;'}}),/review/);
 const second=await db.previewCreateTable({...session,draft:draft('second')});await assert.rejects(db.applyCreateTable({...session,review:first}),/review/);await db.applyCreateTable({...session,review:second});
 await assert.rejects(db.applyCreateTable({...session,review:first}),/stale/);
 const closed=await db.previewCreateTable({...session,draft:draft('closed')});await db.close(session);await assert.rejects(db.applyCreateTable({...session,review:closed}),/closed/);
});
test('metadata budget failure after DDL rolls back creation and schema revision, restoring read protection',async t=>{
 const {db,session,read}=await setup(t);let failed=false;
 for(let i=0;i<20;i++){
   const input:DatabaseCreateTableDraft={name:`wide_${i}`,columns:Array.from({length:32},(_,j)=>({name:`c${j}_`+'x'.repeat(120),type:'TEXT',nullable:true,primaryKey:false}))};
   const review=await db.previewCreateTable({...session,draft:input});
   try{await db.applyCreateTable({...session,review});}catch(error){assert.match(String(error),/metadata .*budget/);failed=true;assert.equal((await db.readSchema(session)).tables.some(table=>table.name===input.name),false);const retry=await db.previewCreateTable({...session,draft:input});assert.equal(retry.schemaRevision,review.schemaRevision);break;}
 }
 assert.equal(failed,true);assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
test('UTF-8 SQL and global table/view object bounds are enforced before an extra creation',async t=>{
 assert.throws(()=>previewCreateTableSql({name:'wide',columns:Array.from({length:32},(_,i)=>({name:String(i)+'界'.repeat(120),type:'TEXT',nullable:true,primaryKey:false}))}),/budget/);
 const {db,session}=await setup(t);const initial=(await db.readSchema(session)).tables.length;
 for(let i=initial;i<32;i++){const review=await db.previewCreateTable({...session,draft:{name:`table_${i}`,columns:[{name:'c',type:'TEXT',nullable:true,primaryKey:false}]}});await db.applyCreateTable({...session,review});}
 assert.equal((await db.readSchema(session)).tables.length,32);await assert.rejects(db.previewCreateTable({...session,draft:draft('one_too_many')}),/budget/);assert.equal((await db.readSchema(session)).tables.length,32);
});
