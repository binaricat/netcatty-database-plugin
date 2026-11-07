import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorDrafts,serializeEditorDrafts,parseEditorDrafts,nextEditorDraftId} from '../src/editorDrafts';
const tab={id:7,sql:'SELECT ? -- 林',parameters:'["unfinished',objectName:'orders',surface:'data' as const};
test('roundtrip keeps stable ids, active tab, exact SQL and incomplete draft parameters',()=>{
  const value=createEditorDrafts([tab,{id:23,sql:'',parameters:'[]'}],7);
  assert.deepEqual(parseEditorDrafts(serializeEditorDrafts(value)),{ok:true,value});assert.equal(nextEditorDraftId(value),24);
  assert.deepEqual(parseEditorDrafts(serializeEditorDrafts(createEditorDrafts([],null))),{ok:true,value:{version:1,tabs:[],activeTab:null}});
});
test('allowlist excludes query results, credentials, handles and runtime/write state',()=>{
  const unsafe={...tab,result:{rows:['private']},password:'secret',handleId:'handle',busy:true,pendingWrite:{sql:'DELETE'}};unsafe.result.rows.push('more');
  const value=createEditorDrafts([unsafe],7);assert.deepEqual(value.tabs,[tab]);
  const serialized=serializeEditorDrafts(value);assert.doesNotMatch(serialized,/password|private|handleId|busy|pendingWrite/);
  const raw=JSON.stringify({...value,credential:'secret',tabs:[unsafe]});assert.deepEqual(parseEditorDrafts(raw),{ok:true,value});
});
test('malformed/version/duplicate ids/missing active tab and invalid object surfaces reject atomically',()=>{
  assert.deepEqual(parseEditorDrafts(undefined),{ok:false,reason:'missing'});
  assert.deepEqual(parseEditorDrafts('{'),{ok:false,reason:'invalid-json'});
  assert.deepEqual(parseEditorDrafts('{"version":2}'),{ok:false,reason:'unsupported-version'});
  for(const value of [{version:1,tabs:[tab,tab],activeTab:7},{version:1,tabs:[tab],activeTab:9},{version:1,tabs:[],activeTab:7},{version:1,tabs:[{...tab,id:-1}],activeTab:-1},{version:1,tabs:[{id:1,sql:'',parameters:'',surface:'structure'}],activeTab:1}])assert.deepEqual(parseEditorDrafts(JSON.stringify(value)),{ok:false,reason:'invalid-document'});
});
test('tab, character and UTF-8 total limits fail without truncating content',()=>{
  assert.throws(()=>createEditorDrafts(Array.from({length:11},(_,i)=>({...tab,id:i+1})),1));
  assert.throws(()=>createEditorDrafts([{...tab,sql:'x'.repeat(8193)}],7));
  assert.throws(()=>createEditorDrafts([{...tab,parameters:'x'.repeat(8193)}],7));
  const tabs=Array.from({length:10},(_,i)=>({...tab,id:i+1,sql:'界'.repeat(8192)}));
  assert.throws(()=>createEditorDrafts(tabs,1),/96 KiB/);
  assert.deepEqual(parseEditorDrafts(JSON.stringify({version:1,tabs,activeTab:1})),{ok:false,reason:'too-large'});
});
test('restore creates independent state and does not run or infer a database connection',()=>{
  const source={...tab};const value=createEditorDrafts([source],7);source.sql='CHANGED';assert.equal(value.tabs[0].sql,tab.sql);
  assert.deepEqual(Object.keys(value).sort(),['activeTab','tabs','version']);
});
