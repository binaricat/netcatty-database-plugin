import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext, Disposable } from '@netcatty/plugin-sdk';
import { createWorkbenchContext } from '../src/sqliteClient';
function setup() {
  const data = new Map<string, unknown>(); const disposables: Disposable[] = [];
  const original = {enabledFeatures:new Set(['views.host-drawn']),subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async(key:string)=>structuredClone(data.get(key)),set:async(key:string,value:unknown)=>{data.set(key,structuredClone(value));}}} as unknown as PluginContext;
  const context = createWorkbenchContext(original);
  return {original,context,data,dispose:()=>disposables.forEach(d=>d.dispose())};
}
test('main adapter executes real SQLite joins, bound Unicode, NULL/empty values and schema introspection', async t => {
  const {context,original,dispose}=setup();t.after(dispose);
  assert.equal('database' in original,false);
  assert.equal(context.enabledFeatures.has('database.sqlite-fixture.v1'),false);
  const s=await context.database.openFixture({});
  const schema=await context.database.readSchema(s);
  assert.deepEqual(schema.tables.map(t=>[t.name,t.kind]),[['customers','table'],['notes','table'],['order_totals','view'],['orders','table']]);
  assert.equal(schema.tables.find(t=>t.name==='orders')?.columns.find(c=>c.name==='id')?.primaryKey,true);
  assert.equal(schema.tables.find(t=>t.kind==='view')?.columns[0].nullable,undefined);
  const result=await context.database.query({...s,sql:'SELECT c.name,o.amount,o.memo FROM customers c JOIN orders o ON o.customer_id=c.id WHERE c.name=? ORDER BY o.id',parameters:['林'],mode:'read'});
  assert.deepEqual(result.rows,[['林',45.25,'']]);
  assert.deepEqual((await context.database.query({...s,sql:'SELECT memo FROM orders WHERE id=1',parameters:[],mode:'read'})).rows,[[null]]);
});
test('read-only SQLite rejects writes, pragma escapes and multi-statement scripts while preserving data', async t => {
  const {context,dispose}=setup();t.after(dispose);const s=await context.database.openFixture({});
  for (const sql of ['DELETE FROM notes','PRAGMA query_only=OFF','SELECT 1; DELETE FROM notes','WITH c AS (SELECT 1) DELETE FROM notes','ATTACH DATABASE \'x\' AS other']) {
    await assert.rejects(context.database.query({...s,sql,parameters:[],mode:'read'}));
  }
  await assert.rejects(context.database.query({...s,sql:'DELETE FROM notes',parameters:[],mode:'write'}),/read-only/);
  assert.deepEqual((await context.database.query({...s,sql:'-- comment\n/* another */ SELECT count(*) FROM notes;',parameters:[],mode:'read'})).rows,[[3]]);
  assert.deepEqual((await context.database.query({...s,sql:"SELECT '; DELETE FROM notes'",parameters:[],mode:'read'})).rows,[['; DELETE FROM notes']]);
});
test('SQLite row and native allocation budgets reject or truncate actual queries', async t => {
  const {context,dispose}=setup();t.after(dispose);const s=await context.database.openFixture({});
  const r=await context.database.query({...s,sql:'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<120) SELECT n FROM x',parameters:[],mode:'read'});
  assert.equal(r.rows.length,100);assert.equal(r.truncated,true);
  await assert.rejects(context.database.query({...s,sql:'SELECT zeroblob(100000000)',parameters:[],mode:'read'}));
  await assert.rejects(context.database.query({...s,sql:'SELECT 1',parameters:[],mode:'read',maxRows:NaN}),/row limit/);
  assert.deepEqual((await context.database.query({...s,sql:'SELECT 1',parameters:[],mode:'read'})).rows,[[1]]);
});
test('saved memory connections serialize mutations and reopen fresh engine instances without credentials', async t => {
  const {context,data,dispose}=setup();t.after(dispose);const s=await context.database.openFixture({});
  await Promise.all(Array.from({length:8},(_,i)=>context.database.saveConnection({...s,meta:{name:`Saved ${i}`,color:'blue'}})));
  const saved=await context.database.listSavedConnections({});assert.equal(saved.length,8);
  assert.doesNotMatch(JSON.stringify([...data.values()]),/password|secretRef|handleId/);
  const reopened=await context.database.openSavedConnection({id:saved[0].id});assert.notEqual(reopened.handleId,s.handleId);
  await context.database.deleteConnection({id:saved[0].id});
  await assert.rejects(context.database.openSavedConnection({id:saved[0].id}),/not found/);
  await assert.rejects(context.database.saveConnection({...s,meta:{name:'Invalid',color:'blue'},secret:{kind:'password',value:'do-not-persist'}}),/Credentials/);
});
test('cancel, view/runtime disposal and pending-open disposal cannot retain SQLite sessions', async () => {
  const {context,dispose}=setup();const s=await context.database.openFixture({});
  await context.database.cancel(s);await context.database.close(s);
  await assert.rejects(context.database.readSchema(s),/closed/);
  const pending=context.database.openFixture({});dispose();await assert.rejects(pending,/closed/);
  await assert.rejects(context.database.openFixture({}),/closed/);
  await assert.rejects(context.database.openTcp({driverId:'postgres',hostname:'localhost',port:5432,database:'unused',username:'unused',password:'unused',tls:true}),/not available/);
});
