import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root=path.resolve(import.meta.dirname,'../..');
const host=path.resolve(root,'../netcatty-database-host');
const output=process.argv[2];
const packaged=process.argv[3];
if(!output?.startsWith('/workspace/agent-tools/database/t303-native-ui-polish/')||!packaged?.startsWith('/workspace/agent-tools/database/t303-native-ui-polish/'))throw Error('Only T303 evidence directories are accepted');
fs.mkdirSync(output,{recursive:true});for(const d of ['home','config','data','cache'])fs.mkdirSync(path.join(output,d),{recursive:true});
const require=createRequire(host+'/package.json');const asar=require('@electron/asar');
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(r,...args)=>execFileSync('git',['-C',r,...args],{encoding:'utf8'}).trim();
const archive=packaged+'/resources/app.asar';
const checks=[];
for(const file of ['dist/index.html',...fs.readdirSync(host+'/dist/assets').filter(f=>/\.(js|css)$/.test(f)).map(f=>'dist/assets/'+f),...git(host,'ls-files','electron','domain').split('\n').filter(f=>/\.cjs$/.test(f)&&!f.includes('.test.')&&!f.includes('/fixtures/'))]){
 let content;try{content=asar.extractFile(archive,file);}catch{if(file.startsWith('dist/')||file.startsWith('domain/plugin'))throw Error('Required packaged resource missing: '+file);continue;}
 checks.push({file,sha256:hash(fs.readFileSync(host+'/'+file)),packagedSha256:hash(content)});
}
if(checks.some(c=>c.sha256!==c.packagedSha256))throw Error('Current source/package mismatch');
const {build}=require('esbuild');await build({absWorkingDir:root,entryPoints:['src/index.tsx'],outfile:output+'/fresh-browser.js',bundle:true,format:'esm',platform:'browser',target:'es2022',loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof'});
const freshBundle=hash(fs.readFileSync(output+'/fresh-browser.js'));if(freshBundle!==hash(fs.readFileSync(root+'/dist/package/browser.js')))throw Error('Plugin bundle is stale');
const {validateTarget}=await import(root+'/node_modules/@netcatty/plugin-cli/dist/index.js');
const pkg=root+'/dist/netcatty-database-0.1.0-alpha.1.ncpkg';const [stage,packed]=await Promise.all([validateTarget(root+'/dist/package'),validateTarget(pkg)]);if(stage.contentSha256!==packed.contentSha256)throw Error('Plugin package differs from current staging');fs.copyFileSync(pkg,output+'/netcatty-database-0.1.0-alpha.1.ncpkg');
fs.writeFileSync(output+'/provenance.json',JSON.stringify({time:new Date().toISOString(),freshBundleSha256:freshBundle,packageContentSha256:packed.contentSha256,repos:[root,host].map(r=>({path:r,sha:git(r,'rev-parse','HEAD'),status:git(r,'status','--porcelain'),diffSha256:hash(git(r,'diff','HEAD'))})),hostArchiveSha256:hash(fs.readFileSync(archive)),checks,packageSha256:hash(fs.readFileSync(pkg))},null,2));
console.log(`PASS packaged-current checks=${checks.length}`);
