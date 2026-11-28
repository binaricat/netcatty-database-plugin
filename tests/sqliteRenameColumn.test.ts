import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import type {Database} from 'sql.js';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import {applySqliteRenameColumn,inspectRenameColumnAuthority,createWorkbenchContext} from '../src/sqliteClient';
const draft={table:'plain',from:'value',to:'renamed'};
async function raw(t:{after:(fn:()=>void)=>void}){const SQL=await initSqlJs(),db=new SQL.Database();t.after(()=>db.close());db.run("CREATE TABLE plain(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO plain VALUES(1,'keep'),(2,NULL);CREATE TABLE other(id INTEGER PRIMARY KEY,label TEXT);INSERT INTO other VALUES(1,'other');");return db;}
const version=(db:Database)=>db.exec('PRAGMA schema_version')[0].values[0][0];
const rows=(db:Database)=>db.exec('SELECT * FROM plain ORDER BY id')[0].values;
async function setup(t:{after:(fn:()=>void)=>void}){const disposables:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});const review=await context.database.previewCreateTable({...session,draft:{name:'plain',columns:[{name:'id',type:'INTEGER',nullable:false,primaryKey:true},{name:'value',type:'TEXT',nullable:true,primaryKey:false}]}});await context.database.applyCreateTable({...session,review});return {db:context.database,session};}
test('facade preview is nonexecuting, fresh isolated table renames despite unrelated default fixture view',async t=>{
 const {db,session}=await setup(t),before=await db.readSchema(session);const review=await db.previewRenameColumn({...session,draft});assert.equal(review.dependencyValidation,'adapter-required');assert.deepEqual(await db.readSchema(session),before);
 const result=await db.applyRenameColumn({...session,review});assert.equal(result.changes,0);assert.equal(result.schema.tables.find(t=>t.name==='plain')!.columns[1].name,'renamed');assert.deepEqual(result.schema.tables.filter(t=>t.name!=='plain'),before.tables.filter(t=>t.name!=='plain'));
 await assert.rejects(db.applyRenameColumn({...session,review}),/stale|review/);
});
test('review binding rejects fabricated/cross-session/closed/stale requests',async t=>{
 const {db,session}=await setup(t);const review=await db.previewRenameColumn({...session,draft});const other=await db.openFixture({});await assert.rejects(db.applyRenameColumn({...other,review}),/stale/);
 await assert.rejects(db.applyRenameColumn({...session,review:{...review,sql:review.sql+' DROP TABLE notes;'}}),/review/);
 const add=await db.previewAddColumn({...session,draft:{table:'plain',name:'extra',type:'TEXT'}});await db.applyAddColumn({...session,review:add});await assert.rejects(db.applyRenameColumn({...session,review}),/stale/);
 const closed=await db.previewRenameColumn({...session,draft});await db.close(session);await assert.rejects(db.applyRenameColumn({...session,review:closed}),/closed/);
});
test('real engine preserves data and unrelated view/trigger definitions exactly',async t=>{
 const db=await raw(t);db.run('CREATE VIEW unrelated AS SELECT label FROM other;CREATE TRIGGER unrelated_trigger AFTER UPDATE ON other BEGIN SELECT label FROM other; END;');const before=rows(db);const otherSql=db.exec("SELECT name,sql FROM sqlite_schema WHERE name LIKE 'unrelated%' ORDER BY name")[0].values;
 const result=applySqliteRenameColumn(db,{...draft,to:'new"; DROP TABLE other;--'});assert.equal(result.schema.tables.find(t=>t.name==='plain')!.columns[1].name,'new"; DROP TABLE other;--');assert.deepEqual(rows(db),before);assert.deepEqual(db.exec("SELECT name,sql FROM sqlite_schema WHERE name LIKE 'unrelated%' ORDER BY name")[0].values,otherSql);assert.equal(db.exec('PRAGMA query_only')[0].values[0][0],1);
});
test('direct/indirect/star views and other-table triggers force rollback including schema version/data',async t=>{
 for(const dependency of ['CREATE VIEW dep AS SELECT value FROM plain','CREATE VIEW dep AS SELECT * FROM plain','CREATE VIEW dep AS SELECT value FROM plain;CREATE VIEW indirect AS SELECT * FROM dep','CREATE TRIGGER dep AFTER UPDATE ON other BEGIN SELECT value FROM plain; END']){
  const db=await raw(t);db.run(dependency);const before=version(db),data=rows(db),sql=db.exec('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')[0].values;
  assert.throws(()=>applySqliteRenameColumn(db,draft),/dependency/);assert.equal(version(db),before);assert.deepEqual(rows(db),data);assert.deepEqual(db.exec('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')[0].values,sql);assert.equal(db.exec('PRAGMA query_only')[0].values[0][0],1);
 }
});
test('TEMP objects and virtual/generated columns reject before committing',async t=>{
 const temp=await raw(t);temp.run('CREATE TEMP VIEW temp_dep AS SELECT * FROM main.plain');assert.throws(()=>applySqliteRenameColumn(temp,draft),/dependency/);assert.equal(temp.exec('PRAGMA query_only')[0].values[0][0],1);
 const generated=await raw(t);generated.run('CREATE TABLE generated(a INTEGER,b INTEGER GENERATED ALWAYS AS(a+1))');assert.throws(()=>inspectRenameColumnAuthority(generated,'generated'),/table/);
 const shadow=await raw(t);shadow.run('CREATE TEMP TABLE plain(x TEXT)');assert.throws(()=>inspectRenameColumnAuthority(shadow,'plain'),/dependency/);
});

test('post-ALTER database budget failure rolls rename and version back',async t=>{
 const db=await raw(t);db.run("INSERT INTO plain VALUES(3,zeroblob(1100000))");const before=version(db);
 assert.throws(()=>applySqliteRenameColumn(db,draft),/budget/);assert.equal(version(db),before);assert.equal(db.exec("SELECT name FROM pragma_table_info('plain') WHERE cid=1")[0].values[0][0],'value');assert.equal(db.exec('PRAGMA query_only')[0].values[0][0],1);
});
