import test from 'node:test';
import assert from 'node:assert/strict';
import {exportQueryResult} from '../src/resultExportModel';
import type {DatabaseQueryResult} from '../src/databaseTypes';
const result=(rows:DatabaseQueryResult['rows'],columns=rows[0]?.map((_,i)=>`c${i}`)??[]):DatabaseQueryResult=>({columns,rows,truncated:false,changes:0,elapsedMs:0});
test('CSV RFC4180 quotes commas, quotes, CRLF and Unicode; documents NULL versus empty text',()=>{
  const output=exportQueryResult(result([[null,'','a,"b"\r\n林','\\N']]),{format:'csv'});
  assert.equal(output.text,'"c0","c1","c2","c3"\r\n\\N,"","a,""b""\r\n林","\\N"\r\n');
  assert.ok(output.notes.some(note=>note.includes('unquoted \\N')));
});
test('CSV formula protection applies to text and headers but preserves signed numeric cells',()=>{
  const output=exportQueryResult(result([['=1+1','+cmd','-1','@cmd',' \t=cmd',-2,true]],['=header','b','c','d','e','f','g']),{format:'csv'});
  assert.match(output.text,/"'=header"/);assert.match(output.text,/"'=1\+1","'\+cmd","'-1","'@cmd","' \t=cmd",-2,true/);
});
test('JSON preserves types, duplicate column names, null, empty, unicode and source truncation',()=>{
  const input={...result([[null,'',false,1,'林']],['x','x','b','n','s']),truncated:true};
  const output=exportQueryResult(input,{format:'json'});const parsed=JSON.parse(output.text);
  assert.deepEqual(parsed.rows,input.rows);assert.deepEqual(parsed.columns,input.columns);assert.equal(output.truncated,true);assert.equal(output.rowCount,1);assert.equal(output.scope,'returned-rows-only');
});
test('SQL quotes identifiers and literals and warns about non-restorable BLOB text',()=>{
  const input=result([["O'Brien\n林",null,true,2,'<BLOB 4 bytes>']],['a"b','n','b','num','blob']);
  const output=exportQueryResult(input,{format:'sql',tableName:'my"table'});
  assert.match(output.text,/INSERT INTO "my""table" \("a""b", "n", "b", "num", "blob"\) VALUES \('O''Brien\n林', NULL, TRUE, 2, '<BLOB 4 bytes>'\);/);
  assert.ok(output.notes.some(note=>note.includes('cannot restore binary')));
  assert.throws(()=>exportQueryResult(result([['a\0b']]),{format:'sql',tableName:'t'}),/NUL/);
  assert.throws(()=>exportQueryResult(result([[1,2]],['a','A']),{format:'sql',tableName:'t'}),/unique/);
});
test('Markdown escapes layout/HTML/link injection and marks null/empty display values',()=>{
  const output=exportQueryResult(result([['<img>|[x](url)\n林',null,'']]),{format:'markdown'});
  assert.match(output.text,/&#60;img&#62;&#124;&#91;x&#93;&#40;url&#41;<br>林/);assert.match(output.text,/\*NULL\* \| \*empty string\*/);
});
test('oversized UTF-8 or escaping expansion fails, never silently truncates',()=>{
  assert.throws(()=>exportQueryResult(result([['林'.repeat(40000)]]),{format:'csv'}),/96 KiB/);
  assert.throws(()=>exportQueryResult(result([['|'.repeat(20000)]]),{format:'markdown'}),/96 KiB/);
  assert.throws(()=>exportQueryResult(result([[Infinity]]),{format:'json'}),/finite/);
  assert.throws(()=>exportQueryResult(result([[1]],['a','b']),{format:'json'}),/match/);
});
