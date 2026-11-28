import {previewAddColumnSql} from '../src/alterTableModel';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import {createWorkbenchContext,assertPlainAddColumnTable,inspectSqliteSchema} from '../src/sqliteClient';
async function setup(t:{after:(fn:()=>void)=>void}){const disposables:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});return {db:context.database,session,read:(sql:string)=>context.database.query({...session,sql,parameters:[],mode:'read'})};}
const draft={table:'notes',name:'extra',type:'TEXT' as const};
test('real SQLite add-column only applies confirmed snapshot; existing rows NULL and review consumed',async t=>{
 const {db,session,read}=await setup(t);const review=await db.previewAddColumn({...session,draft});
 assert.ok(!(await db.readSchema(session)).tables.find(t=>t.name==='notes')!.columns.some(c=>c.name==='extra'));
 const result=await db.applyAddColumn({...session,review});assert.ok(result.schema.tables.find(t=>t.name==='notes')!.columns.some(c=>c.name==='extra'&&c.nullable));
 assert.deepEqual((await read('SELECT extra FROM notes')).rows,[[null],[null],[null]]);
 await assert.rejects(db.applyAddColumn({...session,review}));
 const next=await db.previewAddColumn({...session,draft:{...draft,name:'next'}});assert.ok(next.schemaRevision>review.schemaRevision);
 await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
test('changed SQL/draft/handle, replaced review, schema mutation and closed handles rejected',async t=>{
 const {db,session}=await setup(t);const review=await db.previewAddColumn({...session,draft});const other=await db.openFixture({});
 for(const changed of [{...review,sql:review.sql+' DROP TABLE notes;'},{...review,draft:{...draft,name:'evil'}}])await assert.rejects(db.applyAddColumn({...session,review:changed}));
 await assert.rejects(db.applyAddColumn({...other,review}));
 await db.previewCreateIndex({...session,draft:{name:'idx',table:'notes',unique:false,columns:[{name:'id',direction:'ASC'}]}});
 await assert.rejects(db.applyAddColumn({...session,review}));
 const fresh=await db.previewAddColumn({...session,draft});const table=await db.previewCreateTable({...session,draft:{name:'newtable',columns:[{name:'id',type:'INTEGER',nullable:true,primaryKey:false}]}});await db.applyCreateTable({...session,review:table});
 await assert.rejects(db.applyAddColumn({...session,review:fresh}),/stale/);
 const last=await db.previewAddColumn({...session,draft});await db.close(session);await assert.rejects(db.applyAddColumn({...session,review:last}));
});
test('actual engine metadata rejects generated/strict/virtual/shadow tables',async()=>{
 const SQL=await initSqlJs();const engine=new SQL.Database();try{
 engine.run('CREATE TABLE plain (id INTEGER); CREATE TABLE generated (id INTEGER, g INTEGER AS (id+1)); CREATE TABLE strict_t (id INTEGER) STRICT; CREATE VIRTUAL TABLE ft USING fts3(body);');
 assert.doesNotThrow(()=>assertPlainAddColumnTable(engine,'plain'));
 for(const name of ['generated','strict_t','ft','ft_content','missing'])assert.throws(()=>assertPlainAddColumnTable(engine,name));
 engine.run('CREATE TRIGGER plain_trigger AFTER INSERT ON plain BEGIN SELECT 1; END;');
 assert.throws(()=>previewAddColumnSql({table:'plain',name:'newcol',type:'TEXT'},inspectSqliteSchema(engine)));
 }finally{engine.close();}
});
test('metadata budget failure after actual ALTER rolls back column and schema revision, restores protection',async t=>{
 const {db,session,read}=await setup(t);
 const table=await db.previewCreateTable({...session,draft:{name:'wide',columns:Array.from({length:32},(_,i)=>({name:`base${i}_`+'a'.repeat(120),type:'TEXT',nullable:true,primaryKey:false}))}});await db.applyCreateTable({...session,review:table});
 let rolledBack=false;
 for(let i=0;i<32;i++){
 const name=`new${i}_`+'b'.repeat(120);const review=await db.previewAddColumn({...session,draft:{table:'wide',name,type:'TEXT'}});
 try{await db.applyAddColumn({...session,review});}catch(error){
 assert.match(String(error),/metadata text budget/);const schema=await db.readSchema(session);assert.ok(!schema.tables.find(t=>t.name==='wide')!.columns.some(c=>c.name===name));
 const retry=await db.previewAddColumn({...session,draft:{table:'wide',name,type:'TEXT'}});assert.equal(retry.schemaRevision,review.schemaRevision);
 await assert.rejects(db.applyAddColumn({...session,review}));rolledBack=true;break;
 }
 }
 assert.equal(rolledBack,true);assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);
 await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
