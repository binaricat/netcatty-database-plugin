import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import type {PluginContext,Disposable} from '@netcatty/plugin-sdk';
import {previewDropIndexSql,DropIndexError} from '../src/schemaDropIndex';
import {applySqliteDropIndex,inspectSqliteSchema,createWorkbenchContext} from '../src/sqliteClient';
async function raw(t:{after:(f:()=>void)=>void}){const SQL=await initSqlJs(),db=new SQL.Database();t.after(()=>db.close());db.run("CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT);INSERT INTO notes VALUES(1,'a'),(2,'b');CREATE INDEX idx_title ON notes(title);CREATE INDEX idx_id ON notes(id)");return db;}
const draft={table:'notes',name:'idx_title'};
test('normalizes exact existing explicit index and quotes SQL; detached preview performs no DDL',async t=>{
 const db=await raw(t),before=db.exec("SELECT sql FROM sqlite_schema ORDER BY name");const result=previewDropIndexSql({table:'NOTES',name:'IDX_TITLE'},inspectSqliteSchema(db));assert.deepEqual(result,{draft,sql:'DROP INDEX "main"."idx_title";',unique:false});assert.deepEqual(db.exec("SELECT sql FROM sqlite_schema ORDER BY name"),before);
 db.run('CREATE INDEX "x""; DROP TABLE notes;--" ON notes(title)');assert.equal(previewDropIndexSql({table:'notes',name:'x"; DROP TABLE notes;--'},inspectSqliteSchema(db)).sql,'DROP INDEX "main"."x""; DROP TABLE notes;--";');
 for(const bad of [{...draft,extra:true},{...draft,name:'sqlite_autoindex_notes_1'},{...draft,name:'missing'},{...draft,table:'missing'}])assert.throws(()=>previewDropIndexSql(bad,inspectSqliteSchema(db)));
});
test('real engine removes only reviewed explicit index and preserves data/other index/read protection',async t=>{
 const db=await raw(t),before=db.exec('SELECT * FROM notes ORDER BY id');const result=applySqliteDropIndex(db,draft);assert.equal(result.changes,0);assert.deepEqual(result.schema.tables[0].indexes!.map(i=>i.name),['idx_id']);assert.deepEqual(db.exec('SELECT * FROM notes ORDER BY id'),before);assert.equal(db.exec('PRAGMA query_only')[0].values[0][0],1);
});
test('explicit UNIQUE index disclosed, while constraint indexes/partial/expression/FK dependencies reject',async t=>{
 const db=await raw(t);db.run('CREATE UNIQUE INDEX idx_unique ON notes(title);CREATE INDEX idx_partial ON notes(title) WHERE id>0;CREATE INDEX idx_expression ON notes(lower(title));CREATE TABLE auto(a TEXT UNIQUE)');
 const schema=inspectSqliteSchema(db);assert.equal(previewDropIndexSql({...draft,name:'idx_unique'},schema).unique,true);
 for(const name of ['idx_partial','idx_expression'])assert.throws(()=>previewDropIndexSql({...draft,name},schema),/index/);
 const auto=schema.tables.find(t=>t.name==='auto')!.indexes![0].name;assert.throws(()=>previewDropIndexSql({table:'auto',name:auto},schema),/identifier/);
 db.run('CREATE TABLE child(a TEXT REFERENCES notes(title))');assert.throws(()=>previewDropIndexSql(draft,inspectSqliteSchema(db)),/dependency/);
});
test('INDEXED BY views or triggers cannot become broken; unrelated views remain valid',async t=>{
 const db=await raw(t);db.run('CREATE VIEW unrelated AS SELECT * FROM notes');assert.doesNotThrow(()=>previewDropIndexSql(draft,inspectSqliteSchema(db)));db.run('CREATE VIEW dep AS SELECT * FROM notes INDEXED /* space */ BY idx_title');assert.throws(()=>applySqliteDropIndex(db,draft),/dependency/);assert.ok(inspectSqliteSchema(db).tables.find(t=>t.name==='notes')!.indexes!.some(i=>i.name==='idx_title'));
 const trigger=await raw(t);trigger.run('CREATE TABLE other(x TEXT);CREATE TRIGGER dep AFTER INSERT ON other BEGIN SELECT title FROM notes INDEXED BY idx_title;END');assert.throws(()=>applySqliteDropIndex(trigger,draft),/dependency/);
});
test('TEMP ambiguity and post-drop database budget violations rollback schema version/index',async t=>{
 const temp=await raw(t);temp.run('CREATE TEMP TABLE notes(x TEXT)');assert.throws(()=>applySqliteDropIndex(temp,draft),/dependency|index/);
 const db=await raw(t);db.run('CREATE TABLE big(x BLOB);INSERT INTO big VALUES(zeroblob(1100000))');const version=db.exec('PRAGMA schema_version')[0].values[0][0];assert.throws(()=>applySqliteDropIndex(db,draft),/budget/);assert.equal(db.exec('PRAGMA schema_version')[0].values[0][0],version);assert.ok(inspectSqliteSchema(db).tables.find(t=>t.name==='notes')!.indexes!.some(i=>i.name==='idx_title'));assert.equal(db.exec('PRAGMA query_only')[0].values[0][0],1);
});
test('facade different DDL previews invalidate each other; one-shot/stale/tampered/closed reviews fail',async t=>{
 const ds:Disposable[]=[];const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>ds.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);t.after(()=>ds.forEach(d=>d.dispose()));const db=context.database,session=await db.openFixture({});
 const created=await db.previewCreateIndex({...session,draft:{name:'idx_title',table:'notes',unique:false,columns:[{name:'title',direction:'ASC'}]}});await db.applyCreateIndex({...session,review:created});
 const review=await db.previewDropIndex({...session,draft});assert.ok((await db.readSchema(session)).tables.find(t=>t.name==='notes')!.indexes!.some(i=>i.name==='idx_title'));
 const add=await db.previewAddColumn({...session,draft:{table:'notes',name:'extra',type:'TEXT'}});await assert.rejects(db.applyDropIndex({...session,review}),/review/);
 const next=await db.previewDropIndex({...session,draft});await assert.rejects(db.applyAddColumn({...session,review:add}),/review/);
 await assert.rejects(db.applyDropIndex({...session,review:{...next,sql:'DROP TABLE notes;'}}),/review/);
 const other=await db.openFixture({});await assert.rejects(db.applyDropIndex({...other,review:next}),/stale/);
 await db.applyDropIndex({...session,review:next});await assert.rejects(db.applyDropIndex({...session,review:next}),/stale|review/);
 const again=await db.previewCreateIndex({...session,draft:{name:'idx_title',table:'notes',unique:false,columns:[{name:'title',direction:'ASC'}]}});await db.applyCreateIndex({...session,review:again});const closed=await db.previewDropIndex({...session,draft});await db.close(session);await assert.rejects(db.applyDropIndex({...session,review:closed}),/closed/);
});

test('reused authority errors remain DropIndexError for TEMP/default/metadata-budget failures',async t=>{
 const temp=await raw(t);temp.run('CREATE TEMP VIEW harmless AS SELECT 1');assert.throws(()=>applySqliteDropIndex(temp,draft),e=>e instanceof DropIndexError&&e.code==='dependency');
 const defaults=await raw(t);defaults.run('CREATE TABLE defaults(id INTEGER PRIMARY KEY,value TEXT DEFAULT \'x\');CREATE INDEX default_idx ON defaults(value)');assert.throws(()=>applySqliteDropIndex(defaults,{table:'defaults',name:'default_idx'}),e=>e instanceof DropIndexError&&e.code==='table');
 const many=await raw(t);for(let i=0;i<4;i++){many.run(`CREATE TABLE t${i}(a INTEGER)`);for(let j=0;j<31;j++)many.run(`CREATE INDEX i${i}_${j} ON t${i}(a)`);}
 assert.throws(()=>applySqliteDropIndex(many,draft),e=>e instanceof DropIndexError&&e.code==='budget');
});
