'use strict';
// Native main-component harness, not full-app Settings/permission-dialog qualification.
const path=require('node:path');const fs=require('node:fs');const {execFileSync}=require('node:child_process');
const host=process.env.NETCATTY_HOST_ROOT;const evidence=process.env.NETCATTY_NATIVE_EVIDENCE;
if(!host||!evidence)throw new Error('Set NETCATTY_HOST_ROOT and NETCATTY_NATIVE_EVIDENCE.');
const {createRequire}=require('node:module');const requireHost=createRequire(path.join(host,'package.json'));
const electron=requireHost('electron');
const {createPluginHostService}=requireHost('./electron/plugins/hostService.cjs');
const {registerPluginBridge}=requireHost('./electron/plugins/pluginBridge.cjs');
const {PLUGIN_PROTOCOL_SCHEME}=requireHost('./electron/plugins/constants.cjs');
fs.mkdirSync(evidence,{recursive:true});const profile=path.join(evidence,'profile');electron.app.setPath('userData',profile);
electron.protocol.registerSchemesAsPrivileged([{scheme:PLUGIN_PROTOCOL_SCHEME,privileges:{standard:true,secure:true,supportFetchAPI:true,codeCache:true}}]);
let service,owner,timer,pending=false,index=0;const frames=[];const permissions=[];
async function capture(name){if(!owner||owner.isDestroyed())return;const image=await owner.webContents.capturePage();fs.writeFileSync(path.join(evidence,name+'.png'),image.toPNG());}
async function finish(){clearInterval(timer);if(pending)await new Promise(resolve=>setTimeout(resolve,300));fs.writeFileSync(path.join(evidence,'recording.json'),JSON.stringify({scope:'Real main host component, actual installed plugin and SQLite engine. Permission decisions are injected for owned storage/views only. Not full-app native Settings/provider/database qualification.',hostCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:host,encoding:'utf8'}).trim(),permissions,frames},null,2));await service?.manager.shutdown();}
electron.app.on('window-all-closed',()=>{});
electron.app.whenReady().then(async()=>{
 service=createPluginHostService({app:electron.app,electron,appRoot:host,getLocale:()=>process.env.NETCATTY_QA_LOCALE||'en',getTheme:()=>process.env.NETCATTY_QA_THEME||'dark',requestPermissionDecision:async request=>{permissions.push({permission:request.permission,resources:request.resources});if(!['views','storage'].includes(request.permission))return {requestId:request.requestId,decision:'deny'};return {requestId:request.requestId,decision:'allow',scope:'application'};}});
 await service.manager.initialize();await service.manager.install(path.resolve(__dirname,'../../dist/netcatty-database-0.1.0-alpha.10.ncpkg'),{enable:true});
 owner=new electron.BrowserWindow({title:'Netcatty Database main acceptance',width:1440,height:1000,show:true,webPreferences:{sandbox:true,contextIsolation:true,preload:path.join(host,'electron/plugins/fixtures/hostReactPreload.cjs')}});
 owner.on('closed',()=>{void finish().then(()=>electron.app.quit());});
 registerPluginBridge(electron.ipcMain,{...service,isTrustedSender:event=>event.sender===owner.webContents&&event.senderFrame===owner.webContents.mainFrame});
 owner.webContents.on('console-message',(_event,_level,message)=>fs.appendFileSync(path.join(evidence,'console.log'),message+'\n'));
 owner.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.control&&input.alt&&input.key.toLowerCase()==='s'){event.preventDefault();void capture('screenshot-'+Date.now());}});
 await owner.loadFile(path.resolve(__dirname,'../../dist/main-host-fixture/index.html'),{query:{locale:process.env.NETCATTY_QA_LOCALE||'en',theme:process.env.NETCATTY_QA_THEME||'dark'}});
 timer=setInterval(async()=>{if(pending||owner.isDestroyed())return;pending=true;const name=`frame-${String(++index).padStart(6,'0')}`;try{await capture(name);frames.push({name:name+'.png',timestamp:new Date().toISOString()});}catch{}finally{pending=false;}},250);
 await capture('startup');
}).catch(error=>{fs.writeFileSync(path.join(evidence,'failure.log'),String(error.stack));electron.app.exit(1);});
