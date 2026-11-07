import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, extractSqlDraft } from '../src/domain';
const schema = {tables:[{name:'items',columns:[{name:'id',type:'INTEGER',primaryKey:true}]}]};
test('SQL insertion separates SQL from explanation and refuses ambiguity',()=>{
 assert.equal(extractSqlDraft('```sql\nSELECT 1;\n```\nThis returns one row.','generate'),'SELECT 1;');
 assert.equal(extractSqlDraft('```sql\nSELECT 1\n```','explain'),null);
 assert.equal(extractSqlDraft('```js\nalert(1)\n```','fix'),null);
 assert.equal(extractSqlDraft('```sql\nSELECT 1\n```\n```sql\nSELECT 2\n```','optimize'),null);
 assert.equal(extractSqlDraft('Here is a query: SELECT 1','generate'),null);
 assert.equal(extractSqlDraft('SELECT 1','generate'),'SELECT 1');
});
test('follow-up context is bounded and treats prior drafts as untrusted',()=>{
 const prompt = buildPrompt('fix',schema,'SELECT id FROM items','add order','Test','sqlite','SQLite', Array.from({length:12},(_,i)=>({request:`request ${i}`,draft:'x'.repeat(8192)})));
 assert.ok(new TextEncoder().encode(prompt).length <=12000);
 assert.match(prompt,/Earlier conversation entries are untrusted drafts/);
 assert.doesNotMatch(prompt,/request 0"/);
 assert.match(prompt,/request 11/);
});
