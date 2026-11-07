import test from 'node:test';import assert from 'node:assert/strict';import {PostgresScramClient} from '../src/postgresScram';
// RFC 7677 section 3 transcript inputs and SHA-256 outputs, independently checked
// with Node crypto PBKDF2/HMAC. These are offline vectors, not server acceptance.
const nonce='rOprNGfwEbeRWgbNEkqO';
const server='r='+nonce+'%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
const verifier='v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';
test('RFC 7677 SCRAM-SHA-256 transcript validates client proof and server signature',async()=>{
 const c=new PostgresScramClient('user','pencil',nonce);assert.deepEqual(c.start(),{mechanism:'SCRAM-SHA-256',message:'n,,n=user,r='+nonce});
 assert.equal(await c.receiveServerFirst(server),'c=biws,r='+nonce+'%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
 assert.equal(c.state,'server-final');c.receiveServerFinal(verifier);assert.equal(c.state,'verified');
});
test('duplicate/mandatory extensions, nonce mismatch, iteration and salt budgets fail closed',async()=>{
 for(const value of [server+',i=4096','m=extension,'+server,server.replace(nonce,'wrong'),server.replace(nonce+'%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',nonce),server.replace('4096','0'),server.replace('4096','100001'),server.replace('4096','04096'),server.replace('W22ZaJ0SNY7soEsUEjb6gQ==','!bad'),server.replace('W22ZaJ0SNY7soEsUEjb6gQ==','YQ==')]){
  const c=new PostgresScramClient('user','credential-secret',nonce);c.start();await assert.rejects(c.receiveServerFirst(value),e=>e instanceof Error&&!e.message.includes('credential-secret'));assert.equal(c.state,'failed');
 }
});
test('wrong or rejected server authentication never marks verified or echoes server secrets',async()=>{
 for(const value of ['v='+Buffer.alloc(32).toString('base64'),'v=YQ==','e=secret-password-rejected',verifier+',e=extra']){
  const c=new PostgresScramClient('user','pencil',nonce);c.start();await c.receiveServerFirst(server);assert.throws(()=>c.receiveServerFinal(value),e=>e instanceof Error&&!e.message.includes('secret-password'));assert.equal(c.state,'failed');
 }
});
test('state sequence, concurrent processing and cancellation reject',async()=>{
 const c=new PostgresScramClient('user','pencil',nonce);assert.throws(()=>c.receiveServerFinal(verifier),/state/);
 const d=new PostgresScramClient('user','pencil',nonce);d.start();const work=d.receiveServerFirst(server);d.close();await assert.rejects(work,/state/);assert.notEqual(d.state,'verified');
 const e=new PostgresScramClient('user','pencil',nonce);e.start();const one=e.receiveServerFirst(server);await assert.rejects(e.receiveServerFirst(server),/state/);await assert.rejects(one,/state/);
});
test('credential/nonce constraints, username escaping and random nonce generation',()=>{
 for(const [user,password] of [['','pencil'],['user',''],['用户','pencil'],['user','päss'],['user','x\0']])assert.throws(()=>new PostgresScramClient(user,password),/input/);
 assert.throws(()=>new PostgresScramClient('user','pencil','short'),/input/);assert.throws(()=>new PostgresScramClient('user','pencil','x,'.repeat(16)),/input/);
 assert.equal(new PostgresScramClient('u,s=e','pencil',nonce).start().message,'n,,n=u=2Cs=3De,r='+nonce);
 assert.notEqual(new PostgresScramClient('user','pencil').start().message,new PostgresScramClient('user','pencil').start().message);
});
