import React, { useEffect, useRef, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import type { DatabaseSchemaResult } from './databaseTypes';
import type { Translate } from './i18n';
import { AgentSession } from './agentSession';
import { buildPrompt, extractSqlDraft, tasks, type Task } from './domain';

type Props = {
  context: PluginContext; schema: DatabaseSchemaResult | null; sql: string; label: string;
  engine?: string; dialect?: string; disabled: boolean; insert: (draft: string) => void; t: Translate;
};
/** Optional, conversation-only Agent UI. No host calls until an explicit button click.
 * Integration must not declare ai.agent.actions in the plugin manifest.
 */
export function AgentAssistant({context,schema,sql,label,engine='sqlite',dialect='SQLite',disabled,insert,t}: Props) {
  const controller = useRef<AgentSession | null>(null);
  if (!controller.current) controller.current = new AgentSession(context.agent,{actionsPermissionDeclared:false});
  const session = controller.current;
  const epoch = useRef(0), locked = useRef(false);
  const [busy,setBusy] = useState(false), [connected,setConnected] = useState(false);
  const [backends,setBackends] = useState<Awaited<ReturnType<AgentSession['discover']>>>([]);
  const [backend,setBackend] = useState('');
  const [chats,setChats] = useState<Awaited<ReturnType<AgentSession['listChats']>>>([]);
  const [chatPage,setChatPage] = useState(0);
  const [history,setHistory] = useState<Awaited<ReturnType<AgentSession['history']>>>({items:[],omitted:0});
  const [historyPage,setHistoryPage] = useState(0);
  const [task,setTask] = useState<Task>('generate'), [draftTask,setDraftTask] = useState<Task>('generate');
  const [request,setRequest] = useState(''), [draft,setDraft] = useState('');
  const [status,setStatus] = useState(''), [error,setError] = useState('');
  useEffect(()=>()=>{++epoch.current;void session.close();},[session]);
  const enabled = context.enabledFeatures.has('ai.agent-sessions');
  async function action(work:(current:()=>boolean)=>Promise<void>) {
    if (locked.current || disabled || !enabled) return;
    locked.current=true;setBusy(true);setError('');const generation=++epoch.current;
    const current=()=>generation===epoch.current;
    try { await work(current); }
    catch(e) { if(current())setError((e instanceof Error?e.message:String(e)).slice(0,1024)); }
    finally { if(current()){locked.current=false;setBusy(false);setConnected(session.state==='ready');} }
  }
  async function close() {
    ++epoch.current;locked.current=false;setBusy(false);setConnected(false);setDraft('');setHistory({items:[],omitted:0});setError('');
    setStatus(t('Agent session closed.'));await session.close();
  }
  async function open(conversationRef?:string) {
    await action(async current=>{
      const opened=await session.open(backend,conversationRef);if(!current())return;
      setConnected(true);setStatus(opened.backendLabel);setDraft('');
      const entries=await session.history();if(current()){setHistory(entries);setHistoryPage(Math.max(0,entries.items.length-1));}
    });
  }
  const page=Math.min(chatPage,Math.max(0,Math.ceil(chats.length/8)-1));
  const hpage=Math.min(historyPage,Math.max(0,history.items.length-1));
  const message=history.items[hpage];
  const insertable=extractSqlDraft(draft,draftTask);
  return <div className="ai-content">
    <p className="hint">{t('Agent conversation only: tools are disabled.')}</p>
    <p className="hint">{t('This sends schema metadata, connection label, editor SQL and your request to the selected host Agent. No result rows. Conversation history is stored by the host.')}</p>
    {!enabled && <p role="status">{t('Agent unavailable on this host.')}</p>}
    <div className="results-heading"><button className="secondary toolbar-button" disabled={!enabled||busy||connected||disabled} onClick={()=>void action(async current=>{const items=await session.discover();if(current()){setBackends(items);setBackend(items.find(b=>b.status==='supported'&&b.reason==='ready')?.backendRef??'');}})}>{t('Check Agent backends')}</button>
    <button className="secondary toolbar-button" disabled={!enabled||busy||disabled} onClick={()=>void action(async current=>{const items=await session.listChats();if(current()){setChats(items);setChatPage(0);}})}>{t('Refresh conversations')}</button></div>
    {backends.length ? <label>{t('Agent backend')}<select aria-label={t('Agent backend')} value={backend} disabled={busy||connected} onChange={e=>setBackend(e.currentTarget.value)}><option value="">{t('Unavailable')}</option>{backends.map(b=><option key={b.backendRef} value={b.backendRef} disabled={b.status!=='supported'||b.reason!=='ready'}>{b.label} · {b.status} · {b.reason}</option>)}</select></label>:<p>{t('No Agent backend checked.')}</p>}
    <button className="secondary toolbar-button" disabled={!backend||busy||connected||disabled} onClick={()=>void open()}>{t('New Agent conversation')}</button>
    {!connected && chats.slice(page*8,page*8+8).map(chat=><button key={chat.conversationRef} className="secondary toolbar-button" disabled={!backend||busy||disabled} onClick={()=>void open(chat.conversationRef)}>{t('Resume conversation')} · {chat.title.slice(0,128)} · {chat.backend}</button>)}
    {!connected&&chats.length>8&&<div className="results-heading"><button className="secondary" disabled={page===0} onClick={()=>setChatPage(page-1)}>{t('Previous')}</button><span>{page+1}/{Math.ceil(chats.length/8)}</span><button className="secondary" disabled={(page+1)*8>=chats.length} onClick={()=>setChatPage(page+1)}>{t('Next')}</button></div>}
    {connected&&<><section aria-label={t('Agent conversation history')}><p>{t('History preview; long messages are shortened.')} · {history.omitted} omitted</p>{message&&<pre>{message.role}: {message.text.slice(0,1500)}{message.text.length>1500?'…':''}</pre>}<div className="results-heading"><button className="secondary" disabled={hpage===0} onClick={()=>setHistoryPage(hpage-1)}>{t('Previous')}</button><span>{history.items.length?hpage+1:0}/{history.items.length}</span><button className="secondary" disabled={hpage+1>=history.items.length} onClick={()=>setHistoryPage(hpage+1)}>{t('Next')}</button></div></section>
    <label>{t('SQL assistance task')}<select aria-label={t('SQL assistance task')} value={task} disabled={busy} onChange={e=>{const value=tasks.find(x=>x===e.currentTarget.value);if(value)setTask(value);}}>{tasks.map(value=><option key={value} value={value}>{t(value)}</option>)}</select></label>
    <label>{t('Your request')}<textarea aria-label={t('Your request')} value={request} maxLength={1500} disabled={busy} onChange={e=>setRequest(e.currentTarget.value)} /></label>
    <button className="secondary toolbar-button" disabled={busy||disabled||!schema?.tables.length} onClick={()=>void action(async current=>{
      const prompt=buildPrompt(task,schema,sql,request,label,engine,dialect);setDraft('');setDraftTask(task);let text='';
      const end=await session.send(prompt,event=>{if(!current())return;if(event.kind==='text'){text+=event.text;setDraft(text);}});
      if(!current())return;setStatus(end.reason);
      // Only completed responses may become insertable drafts.
      if(end.reason!=='completed')setDraft('');
      const entries=await session.history();if(current()){setHistory(entries);setHistoryPage(Math.max(0,entries.items.length-1));}
    })}>{t('Send to Agent')}</button></>}
    <button className="secondary toolbar-button" disabled={!busy&&!connected} onClick={()=>void close()}>{busy?t('Stop'):t('Close Agent conversation')}</button>
    <p role="status">{status}</p>{error&&<p role="alert">{error}</p>}
    <pre aria-label={t('Agent response')}>{draft}</pre>
    <button className="secondary toolbar-button" disabled={busy||disabled||Boolean(error)||!insertable} onClick={()=>{if(insertable)insert(insertable);}}>{t('Insert draft into editor')}</button>
  </div>;
}
