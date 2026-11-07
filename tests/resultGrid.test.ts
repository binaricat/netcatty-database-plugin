import test from 'node:test';
import assert from 'node:assert/strict';
import {resultRows} from '../src/resultGridModel';
test('sort numeric values stably and preserve source indices',()=>{
 const rows=[[10],[2],[null],[2]];
 assert.deepEqual(resultRows(rows,'',0).map(x=>x.index),[2,1,3,0]);
 assert.deepEqual(resultRows(rows,'',0,true).map(x=>x.index),[0,1,3,2]);
 assert.deepEqual(rows,[[10],[2],[null],[2]]);
});
test('filter searches all columns, including null, without truncating values',()=>{
 const rows=[['abc','x'.repeat(300)+'Needle'],[null,''],['ABC',false]];
 assert.equal(resultRows(rows,'needle',null)[0].index,0);
 assert.equal(resultRows(rows,'NULL',null)[0].index,1);
 assert.equal(resultRows(rows,'abc',null).length,2);
});
