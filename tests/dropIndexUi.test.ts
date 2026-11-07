import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DropIndex,dropIndexController,dropIndexErrorText} from '../src/DropIndex';
import {DropIndexError} from '../src/schemaDropIndex';
import {serialPreview} from '../src/schemaPreviewQueue';
import type {DatabaseSchemaResult,DropIndexReview} from '../src/databaseTypes';
import type {WorkbenchContext} from '../src/databaseClient';
const schema:DatabaseSchemaResult={tables:[{name:'notes',kind:'table',columns:[],indexes:[{name:'idx_a',origin:'c',unique:true,partial:false,columns:[]},{name:'idx_b',origin:'c',unique:false,partial:false,columns:[]},{name:'sqlite_autoindex',origin:'u',unique:true,partial:false,columns:[]}]}]};
const review=(name='idx_a'):DropIndexReview=>({handleId:'h',draft:{table:'notes',name},sql:`DROP INDEX "main"."${name}";`,unique:name==='idx_a',schemaRevision:1,tempSchemaRevision:0});
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,0));
test('preview only, explicit confirmation applies once and announces global busy until schema callback',async()=>{
 let applies=0,applied=0;const busy:boolean[]=[],pending=deferred<{changes:0;schema:DatabaseSchemaResult;sql:string}>();
 const db={previewDropIndex:async()=>review(),applyDropIndex:async()=>{applies++;return pending.promise;}};
 const c=dropIndexController(db,'h',schema,()=>{applied++;},value=>busy.push(value));await c.preview();assert.equal(applies,0);assert.equal(c.getSnapshot().review?.unique,true);
 const first=c.confirm();await c.confirm();assert.equal(c.cancel(),false);c.edit({name:'idx_b'});assert.equal(c.getSnapshot().draft.name,'idx_a');assert.deepEqual(busy,[true]);assert.equal(applies,1);
 pending.resolve({changes:0,schema,sql:review().sql});await first;assert.deepEqual(busy,[true,false]);assert.equal(applied,1);assert.equal(c.getSnapshot().done,true);await c.confirm();assert.equal(applies,1);
});
test('edit/cancel/dispose invalidate late previews and never execute',async()=>{
 for(const action of ['edit','cancel','dispose']){const pending=deferred<DropIndexReview>();let applies=0;const c=dropIndexController({previewDropIndex:()=>pending.promise,applyDropIndex:async()=>{applies++;return {changes:0,schema,sql:''};}},'h',schema,()=>{});const started=c.preview();await tick();if(action==='edit')c.edit({name:'idx_b'});else if(action==='cancel')c.cancel();else c.dispose();pending.resolve(review());await started;assert.equal(c.getSnapshot().review,null);await c.confirm();assert.equal(applies,0);}
});
test('shared queue serializes close/reopen with another DDL preview, preserving newest issued review',async()=>{
 const pending=deferred<DropIndexReview>();let calls=0;const db={previewDropIndex:async()=>++calls===1?pending.promise:review('idx_b'),applyDropIndex:async()=>({changes:0 as const,schema,sql:''})};const first=dropIndexController(db,'h',schema,()=>{});const old=first.preview();await tick();first.dispose();let otherRan=false;const other=serialPreview(db,'h',async()=>{otherRan=true;});const second=dropIndexController(db,'h',schema,()=>{});second.edit({name:'idx_b'});const newer=second.preview();await tick();assert.equal(calls,1);assert.equal(otherRan,false);pending.resolve(review());await Promise.all([old,other,newer]);assert.equal(otherRan,true);assert.equal(calls,2);assert.equal(second.getSnapshot().review?.draft.name,'idx_b');
});
test('stale/error feedback discards review; disposal during apply suppresses callback but releases busy',async()=>{
 const c=dropIndexController({previewDropIndex:async()=>review(),applyDropIndex:async()=>{throw new DropIndexError('stale');}},'h',schema,()=>{});await c.preview();await c.confirm();assert.equal(c.getSnapshot().notice,'stale');assert.equal(c.getSnapshot().review,null);
 let applied=0;const busy:boolean[]=[],pending=deferred<{changes:0;schema:DatabaseSchemaResult;sql:string}>();const disposed=dropIndexController({previewDropIndex:async()=>review(),applyDropIndex:()=>pending.promise},'h',schema,()=>{applied++;},v=>busy.push(v));await disposed.preview();const running=disposed.confirm();disposed.dispose();pending.resolve({changes:0,schema,sql:''});await running;assert.equal(applied,0);assert.deepEqual(busy,[true,false]);
});
test('wrong handle/draft cannot authorize confirmation; unknown selections and autoindexes are ignored',async()=>{
 for(const value of [{...review(),handleId:'other'},review('idx_b'),{...review(),unique:false}]){const c=dropIndexController({previewDropIndex:async()=>value,applyDropIndex:async()=>({changes:0,schema,sql:''})},'h',schema,()=>{});c.edit({name:'sqlite_autoindex'});assert.equal(c.getSnapshot().draft.name,'idx_a');await c.preview();assert.equal(c.getSnapshot().notice,'review');assert.equal(c.getSnapshot().review,null);}
});
test('standalone component has explicit UNIQUE risk and action labels, conservative rejection wording',()=>{
 const context={database:{},environment:{locale:'en'}} as unknown as WorkbenchContext;const html=renderToStaticMarkup(React.createElement(DropIndex,{context,handleId:'h',schema,onApplied:()=>{},onClose:()=>{}}));assert.match(html,/removes its uniqueness enforcement/);assert.match(html,/Confirm remove UNIQUE index/);assert.match(html,/role="alert"/);assert.doesNotMatch(html,/sqlite_autoindex/);assert.match(html,/Preview DROP INDEX/);
 assert.match(dropIndexErrorText('dependency',false),/conservative dependency checks/);assert.doesNotMatch(dropIndexErrorText('dependency',false),/were changed/);
});
