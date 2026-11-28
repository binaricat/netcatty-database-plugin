import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {StructureMetadata} from '../src/StructureMetadata';import {translator} from '../src/i18n';
test('object definition uses bounded read-only SQL highlighting and escapes markup',()=>{
 const html=renderToStaticMarkup(React.createElement(StructureMetadata,{object:{name:'notes',kind:'table',columns:[],definition:"CREATE TABLE notes (name TEXT DEFAULT '<img src=x onerror=alert(1)>')"},t:translator('en')}));
 assert.match(html,/sql-preview/);assert.match(html,/sql-keyword/);assert.match(html,/&lt;img/);assert.ok(!html.includes('<img'));assert.ok(!html.includes('<textarea'));
});
test('missing object definition is explicit rather than a misleading blank code surface',()=>{
 const html=renderToStaticMarkup(React.createElement(StructureMetadata,{object:{name:'v',kind:'view',columns:[]},t:translator('en')}));assert.match(html,/No objects in this category/);assert.ok(!html.includes('sql-preview'));
});
