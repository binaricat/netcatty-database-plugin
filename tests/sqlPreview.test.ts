import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SqlPreview} from '../src/SqlPreview';
test('SQL preview highlights tokens while escaping hostile text with no editable controls',()=>{const html=renderToStaticMarkup(React.createElement(SqlPreview,{sql:`SELECT '<img src=x onerror=alert(1)>' AS label; -- note`,label:'Reviewed SQL'}));assert.match(html,/sql-keyword/);assert.match(html,/sql-string/);assert.match(html,/sql-comment/);assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<textarea'));assert.match(html,/tabindex="0"/);});
test('generated multi-column DELETE still highlights beyond the editor token budget',()=>{const sql='DELETE FROM "notes" WHERE "id" COLLATE BINARY IS ? AND "title" COLLATE BINARY IS ? AND "status" COLLATE BINARY IS ?;';const html=renderToStaticMarkup(React.createElement(SqlPreview,{sql,label:'Reviewed SQL'}));assert.match(html,/sql-keyword/);assert.match(html,/sql-identifier/);assert.equal((html.match(/sql-keyword/g)??[]).length>=6,true);});
