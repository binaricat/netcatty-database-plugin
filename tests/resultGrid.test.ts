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

import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ResultGrid,InspectedCellValue} from '../src/ResultGrid';
import {resultCellDisplay} from '../src/resultCellDisplay';
import type {Translate} from '../src/i18n';
const t:Translate=(key)=>key;
test('unsafe characters display as reversible explicit JSON, distinct from literal escapes',()=>{
 for(const value of ['a\0b','\0','x\u0085y','\ufeffhello','x\u202ey','中😀\0"\\end']){const display=resultCellDisplay(value);assert.equal(display.escaped,true);assert.equal(JSON.parse(display.text),value);assert.doesNotMatch(display.text,/[\0\u0085\ufeff\u202e]/u);}
 const literal='\\u0000';assert.deepEqual(resultCellDisplay(literal),{text:literal,escaped:false});assert.notEqual(resultCellDisplay('\0').text,literal);
 for(const value of ['普通😀文本','a\nb\tc','', '"quoted"'])assert.deepEqual(resultCellDisplay(value),{text:value,escaped:false});
});
test('grid flags escaped display without modifying raw results or ordinary inspector behavior',()=>{
 const rows=[['a\0b'],['\\u0000'],['\ufeff中文😀']],before=structuredClone(rows);
 const result={columns:['value'],rows,rowCount:3,truncated:false,changes:0,elapsedMs:0};
 const html=renderToStaticMarkup(React.createElement(ResultGrid,{result,t}));assert.match(html,/JSON-escaped/);assert.match(html,/\\u0000/);assert.match(html,/\\ufeff/);assert.doesNotMatch(html,/\0/);assert.deepEqual(rows,before);
 const escaped=renderToStaticMarkup(React.createElement(InspectedCellValue,{value:rows[0][0],offset:0,t}));assert.match(escaped,/JSON-escaped cell value/);assert.match(escaped,/raw exports retain the original value/);assert.match(escaped,/\\u0000/);
 const normal=renderToStaticMarkup(React.createElement(InspectedCellValue,{value:'\\u0000中文😀',offset:0,t}));assert.match(normal,/Full cell value/);assert.doesNotMatch(normal,/Display escaping only|JSON-escaped/);assert.deepEqual(rows,before);
});
