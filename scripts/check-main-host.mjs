import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const hostRoot = process.env.NETCATTY_HOST_ROOT;
if (!hostRoot || !path.isAbsolute(hostRoot)) throw new Error('Set NETCATTY_HOST_ROOT to the unmodified Netcatty main checkout.');
const require = createRequire(path.join(hostRoot,'package.json'));
const {createPluginHostService}=require('./electron/plugins/hostService.cjs');
const root=await mkdtemp(path.join(tmpdir(),'database-main-compat-'));
const service=createPluginHostService({app:{getAppPath:()=>hostRoot,getPath:()=>root,getVersion:()=> '0.0.0'},env:{},electron:{}});
try {
  await service.manager.initialize();
  const archive=path.resolve('dist/netcatty-database-0.1.0-alpha.4.ncpkg');
  const result=await service.manager.install(archive,{enable:false});
  const manifest=JSON.parse(await readFile('netcatty.plugin.json','utf8'));
  for (const feature of manifest.features.required) assert.ok(service.packageStore.supportedFeatures.includes(feature),`main does not support ${feature}`);
  assert.ok(service.database.getActivePlugin(manifest.id));
  assert.equal(service.database.getActivePlugin(manifest.id).enabled,false);
  console.log(JSON.stringify({status:'PASS',hostCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:hostRoot,encoding:'utf8'}).trim(),requiredFeatures:manifest.features.required,hostFeatures:service.packageStore.supportedFeatures,installed:result,scope:'Actual main PackageStore/PluginManager install with a disposable profile; no runtime, native permission or UI claim.'},null,2));
} finally { await service.manager.shutdown(); await rm(root,{recursive:true,force:true}); }
