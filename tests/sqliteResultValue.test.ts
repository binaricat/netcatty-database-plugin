import test from 'node:test';import assert from 'node:assert/strict';import initSqlJs from 'sql.js/dist/sql-asm.js';import {readSqliteResultRow} from '../src/sqliteResultValue';
test('query rows preserve int64 decimal values instead of silent double rounding',async()=>{const SQL=await initSqlJs(),db=new SQL.Database();const stmt=db.prepare('SELECT 9007199254740993, 9223372036854775807, -9223372036854775808, 9007199254740991, 42, 1.25, NULL, x\'0102\', \'hello\'');try{assert.equal(stmt.step(),true);assert.deepEqual(readSqliteResultRow(stmt),['9007199254740993','9223372036854775807','-9223372036854775808',9007199254740991,42,1.25,null,'<BLOB 2 bytes>','hello']);}finally{stmt.free();db.close();}});
test('same-row TEXT bytes preserve embedded NUL, UTF8 multibyte, leading BOM and empty versus NULL',async()=>{
 const SQL=await initSqlJs(),db=new SQL.Database();const stmt=db.prepare("SELECT CAST(x'610062' AS TEXT),CAST(x'e4b8ad00f09f98ba' AS TEXT),CAST(x'efbbbf61' AS TEXT),'',NULL,x'610062'");
 try{assert.equal(stmt.step(),true);assert.deepEqual(readSqliteResultRow(stmt),['a\0b','中\0😺','\ufeffa','',null,'<BLOB 3 bytes>']);}finally{stmt.free();db.close();}
});
test('invalid UTF8 including after NUL rejects the whole row without replacement or prefix result',async()=>{
 const SQL=await initSqlJs(),db=new SQL.Database();for(const hex of ['6100ff62','c080','eda080','f4908080','e282']){const stmt=db.prepare(`SELECT 'first',CAST(x'${hex}' AS TEXT)`);try{assert.equal(stmt.step(),true);assert.throws(()=>readSqliteResultRow(stmt),{message:'SQLite result contains invalid UTF-8 text.'});}finally{stmt.free();}}db.close();
});
test('missing getBlob never falls back to already truncated strings; integer-only rows need no text API',()=>{
 const fake=(get:()=>unknown[],getBlob?:()=>unknown)=>({get,...(getBlob?{getBlob}:{})}) as unknown as import('sql.js').Statement;
 assert.throws(()=>readSqliteResultRow(fake(()=>['a'])),{message:'SQLite exact text decoding is unavailable.'});
 assert.deepEqual(readSqliteResultRow(fake(()=>[9007199254740993n,1n,null])),['9007199254740993',1,null]);
 assert.throws(()=>readSqliteResultRow(fake(()=>['a'],()=>{throw Error('private value');})),{message:'SQLite exact text decoding failed.'});
 assert.throws(()=>readSqliteResultRow(fake(()=>['a'],()=>[97])),{message:'SQLite exact text decoding failed.'});
});
test('post-copy per-row UTF8 budget counts bytes and wipes copied buffers on success, limit and decode failure',()=>{
 const run=(buffers:Uint8Array[])=>readSqliteResultRow({get:()=>buffers.map(()=>''),getBlob:(i:number)=>buffers[i]} as unknown as import('sql.js').Statement);
 const exact=new Uint8Array(96*1024).fill(97);assert.equal((run([exact])[0] as string).length,96*1024);assert.ok(exact.every(v=>v===0));
 const first=new Uint8Array(48*1024).fill(97),second=new Uint8Array(48*1024+1).fill(98);assert.throws(()=>run([first,second]),/96 KiB/);assert.ok(first.every(v=>v===0));assert.ok(second.every(v=>v===0));
 const invalid=Uint8Array.of(255);assert.throws(()=>run([invalid]),/invalid UTF-8/);assert.equal(invalid[0],0);
 const multi=new TextEncoder().encode('中'.repeat(32769));assert.throws(()=>run([multi]),/96 KiB/);assert.ok(multi.every(v=>v===0));
});
test('real oversized TEXT refuses after copying and does not change database values',async()=>{
 const SQL=await initSqlJs(),db=new SQL.Database();const stmt=db.prepare("SELECT printf('%.*c',98305,'a')");try{assert.equal(stmt.step(),true);assert.throws(()=>readSqliteResultRow(stmt),/96 KiB/);}finally{stmt.free();}assert.equal(db.exec('SELECT 1')[0].values[0][0],1);db.close();
});
test('non-finite REAL fails explicitly instead of JSON converting it to NULL',async()=>{
 const SQL=await initSqlJs(),db=new SQL.Database();try{for(const sql of ['SELECT 1e999','SELECT -1e999']){const stmt=db.prepare(sql);try{assert.equal(stmt.step(),true);assert.throws(()=>readSqliteResultRow(stmt),{message:'SQLite result contains a non-finite number.'});}finally{stmt.free();}}assert.throws(()=>readSqliteResultRow({get:()=>[NaN]} as unknown as import('sql.js').Statement),/non-finite/);}finally{db.close();}
});
