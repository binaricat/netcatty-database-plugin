import test from 'node:test';import assert from 'node:assert/strict';
import {planMysqlPreparedSelect,encodeMysqlPrepare,encodeMysqlExecute,encodeMysqlStatementClose,parseMysqlPrepareOk,parseMysqlPreparedColumn,parseMysqlBinaryRow,type MysqlPreparedColumn} from '../src/mysqlPreparedProtocol';
const enc=new TextEncoder(),s=(v:string)=>Uint8Array.of(enc.encode(v).length,...enc.encode(v));
const input={schema:'fixture',table:'notes',columns:['id','label'],where:[{column:'id',value:{kind:'int64' as const,value:'1'}}],limit:10};
const column=(type=3,flags=0):MysqlPreparedColumn=>({schema:'fixture',table:'notes',originalTable:'notes',name:'id',originalName:'id',type,charset:63,flags});
test('strict SELECT template separates injection-looking parameter values from SQL',()=>{
 const v="'; DROP TABLE x; --";const plan=planMysqlPreparedSelect({...input,where:[{column:'a`b',value:{kind:'text',value:v}},{column:'nullcol',value:{kind:'null'}}]});
 assert.equal(plan.sql,'SELECT `id`, `label` FROM `fixture`.`notes` WHERE `a``b` <=> ? AND `nullcol` <=> ? LIMIT 10');assert.ok(!plan.sql.includes(v));assert.equal(plan.parameters[0].kind,'text');
 const {wire}=encodeMysqlPrepare(input);assert.equal(wire[3],0);assert.equal(wire[4],22);assert.equal(new TextDecoder().decode(wire.slice(5)),planMysqlPreparedSelect(input).sql);
 for(const extra of [{sql:'DROP TABLE x'},{limit:101},{where:[]},{columns:[]},{table:'x\0y'}])assert.throws(()=>planMysqlPreparedSelect({...input,...extra} as never));
});
test('execute int64 boundaries, UTF8 string and NULL have explicit types and binary values',()=>{
 const wire=encodeMysqlExecute(42,[{kind:'int64',value:'-9223372036854775808'},{kind:'text',value:'林'},{kind:'null'}]);const p=wire.slice(4);
 assert.deepEqual(Array.from(p.slice(0,12)),[23,42,0,0,0,0,1,0,0,0,4,1]);assert.deepEqual(Array.from(p.slice(12,18)),[8,0,253,0,6,0]);assert.equal(new DataView(p.buffer,p.byteOffset+18,8).getBigInt64(0,true),-9223372036854775808n);assert.deepEqual(p.slice(26),Uint8Array.of(3,...enc.encode('林')));
 for(const value of ['9223372036854775808','-9223372036854775809','01','-0','1.0'])assert.throws(()=>encodeMysqlExecute(42,[{kind:'int64',value}]));
 assert.throws(()=>encodeMysqlExecute(0,[{kind:'null'}]));assert.throws(()=>encodeMysqlExecute(1,[{kind:'text',value:'\ud800'}]));
 assert.deepEqual(Array.from(encodeMysqlStatementClose(42)),[5,0,0,0,25,42,0,0,0]);
});
test('prepare OK and column metadata exact structure, counts and trailing rejection',()=>{
 const ok=Uint8Array.of(0,42,0,0,0,2,0,1,0,0,0,0);assert.deepEqual(parseMysqlPrepareOk(ok,{columns:2,parameters:1}),{statementId:42,columns:2,parameters:1});assert.throws(()=>parseMysqlPrepareOk(ok,{columns:1,parameters:1}));assert.throws(()=>parseMysqlPrepareOk(Uint8Array.of(...ok,0),{columns:2,parameters:1}));
 const bytes=Uint8Array.of(...s('def'),...s('fixture'),...s('notes'),...s('notes'),...s('id'),...s('id'),12,63,0,11,0,0,0,3,0,0,0,0,0);assert.deepEqual(parseMysqlPreparedColumn(bytes),column());for(let i=0;i<bytes.length;i++)assert.throws(()=>parseMysqlPreparedColumn(bytes.slice(0,i)));
});
test('binary NULL bitmap starts at bit2 and crosses bytes; unsupported NULL type still fails',()=>{
 const columns=Array.from({length:9},()=>column());const values=[1,null,3,4,5,6,null,8,null];let bits=0;values.forEach((v,i)=>{if(v===null)bits|=1<<(i+2);});const payload=[0,bits&255,bits>>8];for(const v of values)if(v!==null)payload.push(v,0,0,0);
 assert.deepEqual(parseMysqlBinaryRow(Uint8Array.from(payload),columns),values.map(v=>v===null?null:String(v)));
 assert.throws(()=>parseMysqlBinaryRow(Uint8Array.of(0,4),[column(245)]),/type/);assert.throws(()=>parseMysqlBinaryRow(Uint8Array.of(0,5),[column()]),/protocol/);assert.throws(()=>parseMysqlBinaryRow(Uint8Array.of(0,132),[column()]),/protocol/);
});
test('signed and unsigned 64-bit binary values stay exact; text NULL empty distinctions',()=>{
 const a=new Uint8Array(8);new DataView(a.buffer).setBigInt64(0,-9223372036854775808n,true);const b=new Uint8Array(8).fill(255);
 const textcol={...column(253),charset:255};assert.deepEqual(parseMysqlBinaryRow(Uint8Array.of(0,0,...a,...b,0),[column(8),column(8,32),textcol]),['-9223372036854775808','18446744073709551615','']);
 assert.deepEqual(parseMysqlBinaryRow(Uint8Array.of(0,4),[textcol]),[null]);assert.throws(()=>parseMysqlBinaryRow(Uint8Array.of(0,0,1,255),[textcol]),/value/);assert.throws(()=>parseMysqlBinaryRow(Uint8Array.of(0,0,0),[{...textcol,charset:63}]),/type/);
});
test('budget, truncated rows, noncanonical lengths and malformed bound descriptors reject',()=>{
 assert.throws(()=>encodeMysqlExecute(1,[{kind:'text',value:'x'.repeat(8193)}]),/limit/);assert.throws(()=>encodeMysqlExecute(1,[{kind:'null',value:'secret'} as never]));assert.throws(()=>parseMysqlBinaryRow(Uint8Array.of(0,0,1,2),[column()]),/protocol/);
 const textcol={...column(253),charset:255};assert.throws(()=>parseMysqlBinaryRow(Uint8Array.of(0,0,252,1,0,65),[textcol]),/protocol/);assert.throws(()=>parseMysqlBinaryRow(Uint8Array.of(0,0,0,0),[textcol]),/protocol/);
});
