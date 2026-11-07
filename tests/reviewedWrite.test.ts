import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesReviewedWrite, type QueryTab, type ReviewedWrite} from '../src/useWorkbench';
const tab:QueryTab={id:2,sql:'UPDATE notes SET status = ? WHERE id = ?',parameters:'["done",1]',result:null};
const review:ReviewedWrite={handleId:'memory-a',tabId:2,sql:tab.sql,parameters:tab.parameters,connectionName:'Disposable'};
test('write review binds exact connection, tab, SQL and parameter text',()=>{
 assert.equal(matchesReviewedWrite(review,'memory-a',tab),true);
 for(const current of [{...tab,id:3},{...tab,sql:tab.sql+' '},{...tab,parameters:'["done",2]'},{...tab,parameters:'[ "done",1]'}])assert.equal(matchesReviewedWrite(review,'memory-a',current),false);
 assert.equal(matchesReviewedWrite(review,'memory-b',tab),false);
 assert.equal(matchesReviewedWrite(review,undefined,tab),false);
 assert.equal(matchesReviewedWrite(review,'memory-a',undefined),false);
});
