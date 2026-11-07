import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ResultExport,exportPreviewPages} from '../src/ResultExport';
import {translator} from '../src/i18n';
import type {WorkbenchContext} from '../src/databaseClient';
test('preview fragments retain every character without splitting surrogate pairs',()=>{
 const text='x'.repeat(3999)+'🦔'+'中'.repeat(9000);const pages=exportPreviewPages(text);
 assert.equal(pages.join(''),text);assert.ok(pages.every(page=>page.length<=4000));assert.ok(pages.every(page=>!/[\uD800-\uDBFF]$/.test(page)));
});
test('collapsed export discloses scope/formula convention, never requests clipboard on render',()=>{
 let calls=0;const context={clipboard:{writeText:async()=>{calls++;return true;}}} as unknown as WorkbenchContext;
 const result={columns:['name'],rows:[['=1+1']],truncated:true,changes:0,elapsedMs:0};
 for(const locale of ['en','zh-CN']){
  const html=renderToStaticMarkup(React.createElement(ResultExport,{result,context,t:translator(locale)}));
  assert.match(html,/<details class="result-export">/);assert.doesNotMatch(html,/<details[^>]*open/);assert.match(html,locale==='en'?/not the whole table/:/不是整张表/);assert.match(html,locale==='en'?/apostrophe/:/单引号/);
 }
 assert.equal(calls,0);
});
test('oversize full export disables copy instead of copying the current preview fragment',()=>{
 const context={clipboard:{writeText:async()=>assert.fail('No automatic copy')}} as unknown as WorkbenchContext;
 const result={columns:['name'],rows:[['中'.repeat(2000)]],truncated:false,changes:0,elapsedMs:0};
 const html=renderToStaticMarkup(React.createElement(ResultExport,{result,context,t:translator('en')}));
 assert.match(html,/4096-byte host limit/);assert.match(html,/<button[^>]*disabled=""[^>]*>Copy complete returned result/);
});
test('NUL stays in original export, display substitution is disclosed and copy disabled',()=>{
 const text='x'.repeat(3999)+'\0'+'y';const pages=exportPreviewPages(text);assert.equal(pages.join(''),'x'.repeat(3999)+'\\0y');assert.ok(pages.every(page=>page.length<=4000));
 const context={clipboard:{writeText:async()=>assert.fail('NUL cannot be copied')}} as unknown as WorkbenchContext;
 const result={columns:['name'],rows:[['a\0b']],truncated:false,changes:0,elapsedMs:0};
 const html=renderToStaticMarkup(React.createElement(ResultExport,{result,context,t:translator('en')}));
 assert.match(html,/Original export is unchanged/);assert.match(html,/choose JSON/);assert.match(html,/a\\0b/);assert.ok(!html.includes('\0'));assert.match(html,/<button[^>]*disabled=""[^>]*>Copy complete returned result/);
});
