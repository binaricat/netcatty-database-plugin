import test from 'node:test';
import assert from 'node:assert/strict';
import {completeSql,quoteCompletionIdentifier} from '../src/sqlCompletion';
import type {DatabaseSchemaResult} from '../src/databaseTypes';
const schema:DatabaseSchemaResult={tables:[{name:'orders',columns:[{name:'id',type:'INTEGER',primaryKey:true},{name:'customer_id',type:'INTEGER',primaryKey:false}]},{name:'customers',columns:[{name:'name',type:'TEXT',primaryKey:false},{name:'odd"column',type:'TEXT',primaryKey:false}]}]};
const suggest=(sql:string)=>completeSql(sql,sql.length,schema);
test('keywords, table positions and prefix replacement leave original SQL unchanged',()=>{
  assert.equal(suggest('sel')[0].insertText,'SELECT');
  assert.deepEqual(suggest('SELECT * FROM ord')[0],{kind:'table',label:'orders',insertText:'"orders"',from:14,to:17});
  const sql='SELECT * FROM ordx WHERE id=1';const item=completeSql(sql,17,schema)[0];assert.equal(item.to,18);assert.equal(sql,'SELECT * FROM ordx WHERE id=1');
});
test('simple aliases including AS and joins resolve columns and quote identifiers',()=>{
  assert.deepEqual(suggest('SELECT * FROM orders o WHERE o.c')[0],{kind:'column',label:'customer_id',insertText:'"customer_id"',from:31,to:32,detail:'orders'});
  assert.equal(suggest('SELECT * FROM orders AS o JOIN customers AS c ON c.na')[0].label,'name');
  assert.equal(suggest('SELECT * FROM customers c WHERE c.odd')[0].insertText,'"odd""column"');
  assert.equal(quoteCompletionIdentifier('a"b'),'"a""b"');
  assert.deepEqual(suggest('SELECT * FROM orders WHERE missing.'),[]);
});
test('strings comments and incomplete quoted identifiers suppress suggestions',()=>{
  for(const sql of ["SELECT 'ord",'SELECT -- ord','SELECT /* ord','SELECT "ord','SELECT `ord','SELECT [ord'])assert.deepEqual(suggest(sql),[]);
  assert.equal(suggest("SELECT 'FROM bogus' FROM ord")[0].label,'orders');
  assert.equal(suggest('SELECT /* FROM bogus */ * FROM ord')[0].label,'orders');
});
test('bounded output, unsupported scopes and invalid caret fail closed',()=>{
  assert.ok(suggest('').length<=12);assert.deepEqual(suggest('WITH x AS '),[]);assert.deepEqual(suggest('SELECT * FROM (SELECT '),[]);
  assert.deepEqual(suggest('SELECT * FROM main.orders WHERE '),[]);
  assert.deepEqual(suggest('SELECT * FROM orders x JOIN customers x ON x.'),[]);
  assert.deepEqual(completeSql('SELECT',-1,schema),[]);assert.deepEqual(completeSql('SELECT',1.5,schema),[]);assert.deepEqual(suggest('x'.repeat(8193)),[]);
  assert.equal(suggest('SELECT 1; SELECT * FROM ord')[0].label,'orders');
});
