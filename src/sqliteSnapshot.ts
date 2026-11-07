import type {Database} from 'sql.js';
export class SqliteSnapshotError extends Error {constructor(readonly code:'unbound'|'busy'|'missing'|'invalid'|'budget'|'protection'|'stale'|'storage'){super(`SQLite snapshot ${code}`);}}
/** @internal Verify protections after sql.js export closes/reopens its connection. */
export function protectSnapshotDatabase(db:Database):void {
 try {db.run('PRAGMA foreign_keys=ON; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  if(db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA query_only')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA trusted_schema')[0]?.values[0]?.[0]!==0)throw new Error();
 }catch{throw new SqliteSnapshotError('protection');}
}
export function exportProtectedSnapshot(db:Database,onFatal:()=>void):Uint8Array {
 let bytes:Uint8Array|undefined;try{bytes=db.export();return bytes;}finally{try{protectSnapshotDatabase(db);}catch(error){bytes?.fill(0);onFatal();throw error;}}
}
/** Bounded plugin-generated databases only; no external files or caller-supplied SQL. */
export function validateSnapshotDatabase(db:Database):void {
 protectSnapshotDatabase(db);
 const size=Number(db.exec('PRAGMA page_count')[0]?.values[0]?.[0])*Number(db.exec('PRAGMA page_size')[0]?.values[0]?.[0]);
 if(!Number.isSafeInteger(size)||size<100||size>512*1024)throw new SqliteSnapshotError('budget');
 if(db.exec("SELECT 1 FROM pragma_table_list WHERE schema='main' AND type IN ('virtual','shadow') LIMIT 1")[0]?.values.length||db.exec("SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1")[0]?.values.length)throw new SqliteSnapshotError('invalid');
 const tables=db.exec("SELECT name FROM sqlite_master WHERE type='table' AND lower(substr(name,1,7)) != 'sqlite_' LIMIT 33")[0]?.values??[];
 if(tables.length>32)throw new SqliteSnapshotError('budget');
 for(const [name] of tables){const statement=db.prepare('SELECT 1 FROM "'+String(name).replaceAll('"','""')+'" LIMIT 10001');let count=0;try{while(statement.step()){if(++count>10000)throw new SqliteSnapshotError('budget');}}finally{statement.free();}}
 if(db.exec('PRAGMA quick_check(1)')[0]?.values[0]?.[0]!=='ok')throw new SqliteSnapshotError('invalid');
 if(db.exec('PRAGMA foreign_key_check')[0]?.values.length)throw new SqliteSnapshotError('invalid');
}
