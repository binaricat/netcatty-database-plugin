import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { openSettings, goPluginsTab, clickBrowsePlugins, dump } from '/workspace/netcatty-smoke-harness/plugin-e2e/_helpers.mjs';
const exec = promisify(execFile);
const ID = 'com.binaricat.netcatty-database';
export default async ({ app, win, shot, log, OUT }) => {
  let sw, cdp; const evidence = { checks: [], synthetic: true, realProvider: false, packageSha256: createHash('sha256').update(fs.readFileSync(process.env.NC_NCPKG)).digest('hex') };
  const video = spawn('ffmpeg', ['-y','-f','x11grab','-video_size','1440x900','-framerate','8','-i',process.env.DISPLAY,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',path.join(OUT,'database-workbench.mp4')], { stdio: 'ignore' });
  const pass = (label) => { evidence.checks.push(label); log('CHECK PASS', label); };
  const allow = async () => {
    for (const page of app.windows()) {
      const prompt = page.locator('[data-host-security-surface]');
      if (await prompt.isVisible().catch(() => false)) {
        const text = await prompt.innerText();
        if (!/synthetic SQLite|Netcatty Database/i.test(text)) throw new Error('Unexpected permission prompt');
        await page.screenshot({ path: path.join(OUT, `permission-${evidence.checks.length}-${Date.now()}.png`) });
        await prompt.getByRole('button', { name: /^Allow/ }).click(); pass('host permission approved for synthetic operation');
      }
    }
  };
  const until = async (fn, label, ms = 20000) => { const end=Date.now()+ms; while(Date.now()<end){await allow();const r=await fn();if(r)return r;await win.waitForTimeout(200);}throw new Error(`Timeout: ${label}`); };
  const native = async (title, imageName, accept) => {
    const id=await until(async()=> (await exec('xdotool',['search','--onlyvisible','--name',`^${title}$`]).catch(()=>null))?.stdout.trim().split('\n')[0],title,15000);
    await exec('xdotool',['windowfocus','--sync',id]);
    await exec('ffmpeg',['-y','-f','x11grab','-video_size','1440x900','-i',process.env.DISPLAY,'-frames:v','1',path.join(OUT,imageName)]);
    await exec('xdotool',['key','--clearmodifiers', accept ? 'Tab' : 'Escape']);
    if(accept) await exec('xdotool',['key','--clearmodifiers','Return']);
  };
  const shadow = async (op='read', arg='') => {
    const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});let target;
    const walk=n=>{if((n.attributes||[]).includes('data-plugin-remote-surface'))for(const c of n.children||[])if(c.shadowRoots?.length)target=c.shadowRoots[0];for(const c of [...n.children||[],...n.shadowRoots||[]])walk(c);};walk(root);if(!target)return null;
    const {object}=await cdp.send('DOM.resolveNode',{backendNodeId:target.backendNodeId});
    try {const r=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,returnByValue:true,arguments:[{value:op},{value:arg}],functionDeclaration:`function(op,arg){if(op==='read')return {text:this.textContent,sql:this.querySelector('textarea[aria-label="SQL statement"]')?.value,rows:[...this.querySelectorAll('tbody tr')].map(n=>n.textContent),buttons:[...this.querySelectorAll('button')].map(n=>({text:n.textContent,disabled:n.disabled})),images:[...this.querySelectorAll('img')].map(n=>({width:n.naturalWidth,src:n.src.slice(0,22)}))};const e=op==='button'?[...this.querySelectorAll('button')].find(n=>n.textContent===arg):this.querySelector(arg);if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};}`});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}finally{await cdp.send('Runtime.releaseObject',{objectId:object.objectId});}
  };
  const click=async(op,arg)=>{const b=await shadow(op,arg);if(!b)throw new Error('Missing remote control '+arg);await win.mouse.click(b.x,b.y);};
  const fill=async(sel,value)=>{await click('selector',sel);await win.keyboard.press('Control+A');await win.keyboard.insertText(value);await win.keyboard.press('Tab');};
  try {
    sw=await openSettings(app,win,log);if(process.env.NC_DATABASE_DARK==='1'){await sw.getByRole('tab',{name:'Appearance',exact:true}).click();await sw.getByRole('button',{name:'Dark',exact:true}).first().click();await win.waitForTimeout(700);pass('dark host theme selected through Settings');}if(!await goPluginsTab(sw,log)||!await clickBrowsePlugins(sw,log))throw new Error('Plugin settings unavailable');
    await sw.getByRole('button',{name:/Import.*ncpkg/i}).click();
    const chooser=await until(async()=> (await exec('xdotool',['search','--onlyvisible','--name','^Import plugin package$']).catch(()=>null))?.stdout.trim().split('\n')[0],'native file chooser');
    await exec('xdotool',['windowfocus','--sync',chooser]);await exec('xdotool',['key','--clearmodifiers','ctrl+l']);
    await exec('xdotool',['type','--clearmodifiers','--delay','1','--',process.env.NC_NCPKG]);await win.waitForTimeout(500);
    await exec('ffmpeg',['-y','-f','x11grab','-video_size','1440x900','-i',process.env.DISPLAY,'-frames:v','1',path.join(OUT,'native-package-chooser.png')]);
    const geo=(await exec('xdotool',['getwindowgeometry','--shell',chooser])).stdout;
    await exec('xdotool',['mousemove','--window',chooser,String(Number(geo.match(/^WIDTH=(\d+)$/m)[1])-50),String(Number(geo.match(/^HEIGHT=(\d+)$/m)[1])-24)]);await exec('xdotool',['click','1']);
    await until(()=>sw.locator(`[data-plugin-card="${ID}"]`).isVisible(),'installed package');pass('local ncpkg imported through native chooser');await sw.screenshot({path:path.join(OUT,'plugin-imported.png')});
    await sw.keyboard.press('Escape');await sw.getByRole('switch',{name:/Enable Netcatty Database/}).click();
    await until(()=>sw.getByRole('switch',{name:/Disable Netcatty Database/}).isVisible(),'enabled');pass('ordinary browser plugin enabled');await sw.close();sw=null;
    await win.locator('[data-section="top-tabs"] [data-tab-id="vault"]').click();await win.getByText('Database',{exact:true}).first().click();
    cdp=await win.context().newCDPSession(win);await until(async()=> (await shadow())?.text.includes('Database workbench'),'workbench');
    let state=await shadow();evidence.initial=state;
    if(!state.buttons.find(b=>b.text==='Run read query')?.disabled)throw new Error('Query enabled without connection');
    await until(async()=> { const current=await shadow(); return current?.images.length===3 && current.images.every(i=>i.width>0); },'all official icons decoded');evidence.decodedIcons=(await shadow()).images;
    if(await win.locator('[data-plugin-vault-page] iframe, [data-plugin-vault-page] webview').count())throw new Error('Embedded UI');pass('host DOM, official decoded icons, no-source query disabled');await shot('database-disconnected');
    if(process.env.NC_DATABASE_DEFAULT_OFF==='1') {if(!state.buttons.find(b=>b.text==='Open synthetic SQLite')?.disabled)throw new Error('Default-off feature unexpectedly available');pass('default-off capability negotiated unavailable');evidence.result='PASS';return true;}
    await click('button','Open synthetic SQLite');await until(async()=> (await shadow())?.text.includes('PK · id'),'actual schema');pass('real fixture opened and actual schema read');await shot('database-schema');
    await click('button','Run read query');await until(async()=> (await shadow())?.rows.length===2,'bound select rows');pass('real parameterized SQLite returned two open notes');await shot('database-read');
    await fill('textarea[aria-label="SQL statement"]','DELETE FROM notes');await fill('input[aria-label="SQL parameters"]','[]');await click('button','Run read query');await until(async()=> (await shadow())?.text.includes('Statement rejected'),'readonly denial');pass('read-mode delete denied by SQLite authorizer');await shot('database-readonly-denied');
    await click('button','Review write…');await native('Review synthetic SQLite write','native-write-cancel.png',false);await until(async()=> (await shadow())?.text.includes('Write was not approved'),'cancelled write');pass('native write review cancelled without mutation');
    await fill('textarea[aria-label="SQL statement"]','UPDATE notes SET title = ? WHERE id = ?');await fill('input[aria-label="SQL parameters"]','["Synthetic smoke update",1]');await click('button','Review write…');await native('Review synthetic SQLite write','native-write-review.png',true);
    await until(async()=> (await shadow())?.text.includes('1 changes'),'approved exact write');pass('native exact SQL and parameters approved; one actual change');
    await fill('textarea[aria-label="SQL statement"]','SELECT id, title, status FROM notes ORDER BY id');await fill('input[aria-label="SQL parameters"]','[]');await click('button','Run read query');await until(async()=> (await shadow())?.rows.some(r=>r.includes('Synthetic smoke update')),'read changed row');pass('readback confirms reviewed write only');await shot('database-write-readback');
    await click('button','Cancel / discard fixture');await until(async()=> (await shadow())?.text.includes('No database connected'),'fixture closed');pass('cancel closes fixture and disables queries');await shot('database-closed');
    evidence.result='PASS';return true;
  }catch(error){evidence.result='FAIL';evidence.error=error.stack||String(error);log(evidence.error);if(cdp)evidence.last=await shadow().catch(()=>null);await shot('database-failure').catch(()=>{});if(sw)await sw.screenshot({path:path.join(OUT,'settings-failure.png')}).catch(()=>{});await dump(win,log,'failure');return false;}
  finally {fs.writeFileSync(path.join(OUT,'database-evidence.json'),JSON.stringify(evidence,null,2));await cdp?.detach().catch(()=>{});video.kill('SIGINT');await new Promise(r=>video.once('exit',r));}
};
