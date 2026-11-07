import test from 'node:test';import assert from 'node:assert/strict';import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executeMysqlPreparedRead,executeMysqlMetadataPreparedRead} from '../src/mysqlPreparedRead';import {encodeMysqlPacket} from '../src/mysqlProtocol';
import {isFixedMysqlMetadataPlan} from '../src/mysqlMetadataAuthority';
const str=(s:string)=>{const b=new TextEncoder().encode(s);return [b.length,...b];};
const opts=()=>({schema:'information_schema',table:'TABLES',columns:['TABLE_NAME','TABLE_TYPE','ENGINE'],where:[{column:'TABLE_SCHEMA',value:{kind:'text' as const,value:'fixture'}}]});
const eof=()=>Uint8Array.of(254,0,0,3,32),ok=(n:number)=>Uint8Array.of(0,0,0,n&255,n>>8,0,0);
function col(name:string,type:number,flags:number,schema='information_schema',table='TABLES',charset=45){return Uint8Array.of(...str('def'),...str(schema),...str(table),...str(table),...str(name),...str(name),12,charset,0,20,0,0,0,type,flags&255,flags>>8,0,0,0);}
const columns=()=>[col('TABLE_NAME',253,20609),col('TABLE_TYPE',254,20873),col('ENGINE',253,0,'')];
function fixture(change?:(c:Uint8Array[],execute:boolean)=>void){let closed=0;const queue:Uint8Array[]=[];const writes:number[]=[];const c={readable:{read:async()=>queue.shift()??null,cancel(){}},writable:{cancel(){},write:async(w:Uint8Array)=>{writes.push(w[4]);let packets:Uint8Array[];if(w[4]===25)return;
 if(w[4]===22||w[4]===23){const cs=columns();change?.(cs,w[4]===23);packets=w[4]===22?[Uint8Array.of(0,42,0,0,0,3,0,1,0,0,0,0),col('?',253,128,'',''),eof(),...cs,eof()]:[Uint8Array.of(3),...cs,eof(),Uint8Array.of(0,0,...str('notes'),...str('BASE TABLE'),...str('InnoDB')),eof()];}
 else packets=[ok(new TextDecoder().decode(w.slice(5)).startsWith('START')?8195:2)];queue.push(new Uint8Array(packets.flatMap((p,i)=>[...encodeMysqlPacket(p,i+1)])));}},close:async()=>{closed++;}} as unknown as PluginByteConnection;return {c,writes,get closed(){return closed;}};}
test('only fixed full projections and text-bound scope predicates authorize metadata route',()=>{
 assert.equal(isFixedMysqlMetadataPlan(opts()),true);
 for(const patch of [{schema:'fixture'},{columns:['ENGINE']},{columns:['ENGINE','TABLE_TYPE','TABLE_NAME']},{where:[]},{where:[{column:'TABLE_SCHEMA',value:{kind:'int64',value:'1'}}]},{where:[{column:'TABLE_NAME',value:{kind:'text',value:'fixture'}}]}])assert.equal(isFixedMysqlMetadataPlan({...opts(),...patch} as never),false);
});
test('exact observed UTF8 name/ENUM flags and computed ENGINE origin decode only in metadata lane',async()=>{
 const f=fixture();const r=await executeMysqlMetadataPreparedRead(f.c,opts());assert.deepEqual(r.rows,[['notes','BASE TABLE','InnoDB']]);assert.deepEqual(f.writes,[3,22,23,25,3]);assert.equal(f.closed,0);
 const ordinary=fixture();await assert.rejects(executeMysqlPreparedRead(ordinary.c,opts()),/protocol/);assert.equal(ordinary.closed,1);
});
test('unknown flags/type/charset/origins or prepare-execute changes fail closed',async()=>{
 for(const change of [
  (c:Uint8Array[])=>{c[0]=col('TABLE_NAME',253,20609,'mysql');},
  (c:Uint8Array[])=>{c[0]=col('TABLE_NAME',253,20609,'information_schema','other');},
  (c:Uint8Array[])=>{c[0]=col('TABLE_NAME',253,20609,'information_schema','TABLES',63);},
  (c:Uint8Array[])=>{c[0]=col('TABLE_NAME',253,20609|2048);},
  (c:Uint8Array[])=>{c[1]=col('TABLE_TYPE',254,20873|2);},
  (c:Uint8Array[])=>{c[2]=col('ENGINE',253,0,'mysql');},
  (c:Uint8Array[],execute:boolean)=>{if(execute)c[2]=col('ENGINE',253,0);},
 ]){const f=fixture(change);await assert.rejects(executeMysqlMetadataPreparedRead(f.c,opts()),/protocol/);assert.equal(f.closed,1);}
});
test('invalid metadata authority rejected before any wire write',async()=>{
 const f=fixture();await assert.rejects(executeMysqlMetadataPreparedRead(f.c,{...opts(),columns:['ENGINE']}),/input/);assert.deepEqual(f.writes,[]);
});

test('COLUMNS exact captured tuples allow UTF8 expressions but retain unsigned integer decoding',async()=>{
 const {mysqlMetadataDecodeColumn:decode,mysqlMetadataExpressionOrigin:origin}=await import('../src/mysqlMetadataAuthority');
 const {parseMysqlBinaryRow}=await import('../src/mysqlPreparedProtocol');
 const captured=[['COLUMN_NAME',253,45,0,''],['ORDINAL_POSITION',3,63,20513,'information_schema'],['DATA_TYPE',251,45,128,''],['COLUMN_TYPE',252,45,4241,'information_schema'],['IS_NULLABLE',253,45,1,''],['COLUMN_DEFAULT',252,45,144,'information_schema'],['EXTRA',253,45,0,'']] as const;
 const fields=captured.map(([name,type,charset,flags,schema])=>({name,type,charset,flags,schema,table:'COLUMNS',originalTable:'COLUMNS',originalName:name}));
 for(const c of fields){assert.equal(origin('COLUMNS',c),c.schema==='');const normalized=decode('COLUMNS',c);assert.equal(normalized.flags,c.name==='ORDINAL_POSITION'?20513:c.flags&~128);assert.equal(c.flags,captured.find(tuple=>tuple[0]===c.name)![3]);}
 // Seven columns use two bitmap bytes; COLUMN_DEFAULT (bit 7) is NULL.
 const row=Uint8Array.of(0,128,0,...str('id'),255,255,255,255,...str('int'),...str('int unsigned'),...str('NO'),...str(''));
 assert.deepEqual(parseMysqlBinaryRow(row,fields.map(c=>decode('COLUMNS',c))),['id','4294967295','int','int unsigned','NO',null,'']);
 assert.throws(()=>parseMysqlBinaryRow(row,fields)); // Ordinary codec unchanged.
 for(const c of fields.filter(c=>c.schema==='')){
  assert.equal(origin('COLUMNS',{...c,schema:'mysql'}),false);
  assert.equal(origin('COLUMNS',{...c,charset:63}),false);
  assert.equal(origin('COLUMNS',{...c,flags:c.flags|2048}),false);
  assert.equal(origin('STATISTICS',c),false);
 }
 for(const c of fields.filter(c=>['DATA_TYPE','COLUMN_TYPE','COLUMN_DEFAULT'].includes(c.name))){
  for(const bad of [{...c,flags:c.flags|2048},{...c,charset:63},{...c,schema:'mysql'},{...c,name:'other'}])assert.equal(decode('COLUMNS',bad),bad);
  assert.equal(decode('STATISTICS',c),c);
 }
});

test('STATISTICS captured expressions decode with exact authority; NON_UNIQUE signed64 already supported',async()=>{
 const {mysqlMetadataDecodeColumn:decode,mysqlMetadataExpressionOrigin:origin}=await import('../src/mysqlMetadataAuthority');
 const {parseMysqlBinaryRow}=await import('../src/mysqlPreparedProtocol');
 const captured=[['INDEX_NAME',253,45,0,''],['NON_UNIQUE',8,63,129,''],['SEQ_IN_INDEX',3,63,20515,'information_schema'],['COLUMN_NAME',253,45,0,''],['COLLATION',253,45,0,''],['INDEX_TYPE',253,45,129,''],['EXPRESSION',252,45,128,'']] as const;
 const fields=captured.map(([name,type,charset,flags,schema])=>({name,type,charset,flags,schema,table:'STATISTICS',originalTable:'STATISTICS',originalName:name}));
 // Existing integer codec consumes signed LONGLONG without text-flag normalization.
 assert.equal(decode('STATISTICS',fields[1]),fields[1]);
 assert.deepEqual(parseMysqlBinaryRow(Uint8Array.of(0,0,1,0,0,0,0,0,0,0),[fields[1]]),['1']);
 const row=Uint8Array.of(0,0,1,...str('PRIMARY'),0,0,0,0,0,0,0,0,1,0,0,0,...str('id'),...str('A'),...str('BTREE'));
 assert.deepEqual(parseMysqlBinaryRow(row,fields.map(c=>decode('STATISTICS',c))),['PRIMARY','0','1','id','A','BTREE',null]);
 assert.throws(()=>parseMysqlBinaryRow(row,fields));
 for(const c of fields){assert.equal(origin('STATISTICS',c),c.schema==='');
  for(const bad of [{...c,schema:'mysql'},{...c,charset:46},{...c,flags:c.flags|2048},{...c,name:'other'}])assert.equal(origin('STATISTICS',bad),false);
  if(c.name==='INDEX_TYPE'||c.name==='EXPRESSION'){
   assert.equal(decode('STATISTICS',{...c,schema:'mysql'}).flags,c.flags);
   assert.equal(decode('STATISTICS',{...c,flags:c.flags|2048}).flags,c.flags|2048);
   assert.equal(decode('TABLES',c),c);
  }
 }
});
