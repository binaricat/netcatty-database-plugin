import React from 'react';
import {createRoot} from 'react-dom/client';
import {PluginHostDrawnPage} from '@host-page';
import {I18nProvider} from '@host-i18n';
const attach=Element.prototype.attachShadow;
Element.prototype.attachShadow=function(init) {const root=attach.call(this,init);(window as unknown as {testPluginShadow:ShadowRoot}).testPluginShadow=root;return root;};
const query=new URLSearchParams(location.search);
const locale=query.get('locale')==='zh-CN'?'zh-CN':'en';
const dark=query.get('theme')!=='light';
const tokens=dark?{'--background':'225 15% 11%','--foreground':'210 20% 94%','--muted':'225 12% 17%','--muted-foreground':'215 12% 65%','--border':'220 12% 25%','--primary':'212 88% 60%','--primary-foreground':'0 0% 100%'}:{'--background':'0 0% 100%','--foreground':'222 20% 15%','--muted':'210 20% 96%','--muted-foreground':'215 15% 43%','--border':'215 20% 86%','--primary':'212 88% 48%','--primary-foreground':'0 0% 100%'};
for(const [name,value]of Object.entries(tokens))document.documentElement.style.setProperty(name,value);
document.documentElement.style.height='100%';document.body.style.cssText='margin:0;height:100%;background:hsl(var(--background));color:hsl(var(--foreground));font-family:system-ui';
document.getElementById('root')!.style.cssText='height:100%;display:flex;flex-direction:column';
const hidden=()=>()=>{};
function Fixture(){return <I18nProvider locale={locale}><header style={{padding:'10px 20px',borderBottom:'1px solid hsl(var(--border))',fontSize:12}}>Netcatty main 4a55492 · Native host-component acceptance · Isolated synthetic profile</header><section style={{flex:1,minHeight:0,position:'relative',display:'flex'}}><PluginHostDrawnPage pluginId="com.binaricat.netcatty-database" viewId="com.binaricat.netcatty-database.workbench" version="0.1.0-alpha.4" slot="vault-page" active context={{'netcatty.surface':'vault-page'}} subscribeHidden={hidden} unavailable={()=>{document.body.dataset.failure='true';}} loadingLabel="Loading installed database plugin…" /></section></I18nProvider>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
