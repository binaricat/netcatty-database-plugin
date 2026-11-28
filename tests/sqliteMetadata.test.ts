import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { Disposable, PluginContext } from '@netcatty/plugin-sdk';
import { createWorkbenchContext, inspectSqliteSchema } from '../src/sqliteClient';
test('workspace returns actual foreign keys and DDL without changing read-only session', async t => {
  const disposables: Disposable[] = [];
  const context = createWorkbenchContext({ subscriptions: {add:(d:Disposable)=>disposables.push(d)}, storage:{get:async()=>undefined} } as unknown as PluginContext);
  t.after(()=>disposables.forEach(d=>d.dispose()));
  const session = await context.database.openFixture({});
  const schema = await context.database.readSchema(session);
  const orders = schema.tables.find(table=>table.name==='orders')!;
  assert.deepEqual(orders.primaryKeyColumns,['id']);
  assert.deepEqual(orders.foreignKeys,[{id:0,targetTable:'customers',columns:[{from:'customer_id',to:'id'}],onUpdate:'NO ACTION',onDelete:'NO ACTION',match:'NONE'}]);
  assert.match(orders.definition!, /^CREATE TABLE orders/);
  assert.match(schema.tables.find(table=>table.name==='order_totals')!.definition!,/^CREATE VIEW/);
  await assert.rejects(context.database.query({...session,sql:'DELETE FROM orders',parameters:[],mode:'read'}));
});
test('real engine inspects composite PK/FK, expression and partial indexes, trigger SQL and quoted names', async t => {
  const SQL = await initSqlJs(); const db = new SQL.Database(); t.after(()=>db.close());
  db.run(`CREATE TABLE parent (b TEXT, a INTEGER, PRIMARY KEY (a,b));
    CREATE TABLE "child'quoted" (x INTEGER, y TEXT, FOREIGN KEY (x,y) REFERENCES parent(a,b) ON DELETE CASCADE ON UPDATE RESTRICT);
    CREATE UNIQUE INDEX child_idx ON "child'quoted"(lower(y) DESC, x) WHERE x > 0;
    CREATE TRIGGER child_trigger AFTER INSERT ON "child'quoted" BEGIN SELECT NEW.x; END;
    CREATE VIEW child_view AS SELECT x FROM "child'quoted";
    PRAGMA query_only=ON;`);
  const schema = inspectSqliteSchema(db);
  assert.deepEqual(schema.tables.find(table=>table.name==='parent')!.primaryKeyColumns,['a','b']);
  const child = schema.tables.find(table=>table.name==="child'quoted")!;
  assert.deepEqual(child.foreignKeys![0].columns,[{from:'x',to:'a'},{from:'y',to:'b'}]);
  assert.equal(child.foreignKeys![0].onDelete,'CASCADE');
  assert.equal(child.indexes![0].unique,true); assert.equal(child.indexes![0].partial,true);
  assert.deepEqual(child.indexes![0].columns[0],{name:null,expression:true,descending:true,collation:'BINARY'});
  assert.match(child.indexes![0].definition!,/WHERE x > 0/);
  assert.equal(child.triggers![0].name,'child_trigger'); assert.match(child.triggers![0].definition,/SELECT NEW.x/);
  assert.equal(schema.tables.find(table=>table.name==='child_view')!.columns[0].nullable,undefined);
  assert.equal(db.exec('PRAGMA query_only')[0].values[0][0],1);
});
test('inspection rejects excessive objects, columns, index count and metadata text with statements freed', async t => {
  const SQL = await initSqlJs();
  for (const [setup, error] of [
    [Array.from({length:33},(_,i)=>`CREATE TABLE t${i}(a)`).join(';'), /object budget/],
    [`CREATE TABLE t(${Array.from({length:65},(_,i)=>`c${i}`).join(',')})`, /column budget/],
    [`CREATE TABLE t(a);${Array.from({length:33},(_,i)=>`CREATE INDEX i${i} ON t(a)`).join(';')}`, /index budget/],
    [`CREATE TABLE t(a DEFAULT '${'x'.repeat(8200)}')`, /metadata text budget/],
  ] as const) {
    const db = new SQL.Database(); try { db.run(setup); assert.throws(()=>inspectSqliteSchema(db),error); assert.equal(db.exec('SELECT 1')[0].values[0][0],1); } finally { db.close(); }
  }
});
test('UTF-8 metadata budget rejects large schema even within object and individual text limits', async t => {
  const SQL = await initSqlJs(); const db = new SQL.Database(); t.after(()=>db.close());
  db.run(Array.from({length:12},(_,i)=>`CREATE TABLE t${i}(a DEFAULT '${'界'.repeat(3000)}')`).join(';'));
  assert.throws(()=>inspectSqliteSchema(db),/metadata byte budget/);
});
