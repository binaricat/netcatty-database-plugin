import assert from 'node:assert/strict';
import test from 'node:test';
import type { Disposable, PluginContext } from '@netcatty/plugin-sdk';
import type { DatabaseScalar } from '../src/databaseTypes';
import {createWorkbenchContext} from '../src/sqliteClient';
async function setup(t: {after: (fn:()=>void)=>void}) {
  const disposables: Disposable[]=[];
  const context=createWorkbenchContext({subscriptions:{add:(d:Disposable)=>disposables.push(d)},storage:{get:async()=>undefined}} as unknown as PluginContext);
  t.after(()=>disposables.forEach(d=>d.dispose()));const session=await context.database.openFixture({});
  const write=(sql:string,parameters:DatabaseScalar[]=[])=>context.database.query({...session,sql,parameters,mode:'write',writeConfirmation:{handleId:session.handleId,sql,parameters:[...parameters]}});
  const read=(sql:string,parameters:DatabaseScalar[]=[])=>context.database.query({...session,sql,parameters,mode:'read'});
  return {context,session,write,read};
}
test('explicit reviewed bound DML changes real memory SQLite and returns current schema',async t=>{
  const {session,write,read}=await setup(t);assert.equal(session.readOnly,false);assert.equal(session.supportsReviewedWrites,true);
  const inserted=await write('INSERT INTO notes (id,title,status) VALUES (?,?,?)',[4,"O'Brien 林",'open']);
  assert.equal(inserted.changes,1);assert.ok(inserted.schema?.tables.find(table=>table.name==='notes'));
  assert.equal((await write('UPDATE notes SET title=? WHERE id=? AND status=?',['changed',4,'open'])).changes,1);
  assert.deepEqual((await read('SELECT title FROM notes WHERE id=4')).rows,[['changed']]);
  assert.equal((await write('DELETE FROM notes WHERE id=?',[4])).changes,1);
  assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);
  await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
test('missing or mismatched review refuses before mutation, including session and parameter changes',async t=>{
  const {context,session,read}=await setup(t);const sql='DELETE FROM notes WHERE id=?';
  for(const confirmation of [undefined,{handleId:'other',sql,parameters:[1]},{handleId:session.handleId,sql:'DELETE FROM notes',parameters:[1]},{handleId:session.handleId,sql,parameters:[2]}]) await assert.rejects(context.database.query({...session,sql,parameters:[1],mode:'write',writeConfirmation:confirmation}),/confirmation/);
  assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);
});
test('restricted grammar refuses scripts, DDL, transactions, functions, subqueries and RETURNING',async t=>{
  const {write,read}=await setup(t);
  for(const sql of ['DELETE FROM notes; DELETE FROM customers','DELETE FROM sqlite_master','DELETE FROM \"SQLITE_MASTER\"','DELETE FROM [sqlite_sequence]','CREATE TABLE t(a)','DROP TABLE notes','BEGIN','PRAGMA query_only=OFF','REPLACE INTO notes VALUES(1,\'x\',\'x\')','UPDATE notes SET title=randomblob(999999)','UPDATE notes SET title=(SELECT name FROM customers LIMIT 1)','WITH x AS (SELECT 1) DELETE FROM notes','DELETE FROM notes RETURNING *','INSERT INTO notes VALUES(4,\'x\',\'x\'),(5,\'y\',\'y\')']) await assert.rejects(write(sql));
  assert.deepEqual((await read('SELECT count(*) FROM notes')).rows,[[3]]);
});
test('constraint and affected-row failures rollback all changes; following reads/writes remain usable',async t=>{
  const {write,read}=await setup(t);
  await assert.rejects(write('INSERT INTO orders VALUES (4,999,2,NULL)'),/FOREIGN KEY/);
  await assert.rejects(write("UPDATE notes SET id=1"),/UNIQUE/);
  assert.deepEqual((await read('SELECT id FROM notes ORDER BY id')).rows,[[1],[2],[3]]);
  for(let id=4;id<=101;id++) await write('INSERT INTO notes VALUES(?,?,?)',[id,'row','open']);
  await assert.rejects(write("UPDATE notes SET status='done'"),/100 rows/);
  assert.deepEqual((await read("SELECT count(*) FROM notes WHERE status='done'")).rows,[[1]]);
  assert.equal((await write('DELETE FROM notes WHERE id=101')).changes,1);
});
test('database size failure rolls back the attempted row and restores read-only query mode',async t=>{
  const {write,read}=await setup(t);let last=3;let failed=false;
  for(let id=4;id<400;id++) {
    try { await write('INSERT INTO notes VALUES(?,?,?)',[id,'界'.repeat(2000),'界'.repeat(2000)]);last=id; }
    catch(error) { assert.match(String(error),/database budget/);failed=true;break; }
  }
  assert.equal(failed,true);assert.deepEqual((await read('SELECT max(id) FROM notes')).rows,[[last]]);
  await assert.rejects(read('WITH x AS (SELECT 1) DELETE FROM notes'),/readonly|read-only/i);
});
