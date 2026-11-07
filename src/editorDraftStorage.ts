import {createEditorDrafts,serializeEditorDrafts,parseEditorDrafts,nextEditorDraftId,type EditorDraftTab} from './editorDrafts';
export interface DraftSnapshot {connectionId:string;handleId:string;revision:number;tabs:EditorDraftTab[];activeTab:number|null;objectNames:string[];}
export type DraftStorageOutcome='saved'|'saved-stale'|'restored'|'restored-missing'|'cleared'|'cancelled'|'stale'|'missing'|'invalid'|'failed'|'unavailable';
export function createEditorDraftStorage(options:{storage:{get(key:string):Promise<unknown>;set(key:string,value:string):Promise<void>;delete(key:string):Promise<void>};snapshot:()=>DraftSnapshot|null;confirm:(kind:'restore'|'clear')=>Promise<boolean>;apply:(tabs:EditorDraftTab[],activeTab:number|null,nextId:number)=>void;}) {
  let busy=false;
  const current=(start:DraftSnapshot)=>{const now=options.snapshot();return !!now&&now.connectionId===start.connectionId&&now.handleId===start.handleId&&now.revision===start.revision;};
  return {async run(operation:'save'|'restore'|'clear'):Promise<DraftStorageOutcome>{
    if(busy)return 'unavailable';const start=options.snapshot();if(!start?.connectionId||!start.handleId)return 'unavailable';
    const key=`database.editor-drafts.v1:${encodeURIComponent(start.connectionId)}`;busy=true;
    try{
      if(operation==='save') {const raw=serializeEditorDrafts(createEditorDrafts(start.tabs,start.activeTab));await options.storage.set(key,raw);return current(start)?'saved':'saved-stale';}
      if(operation==='clear') {if(!await options.confirm('clear'))return 'cancelled';if(!current(start))return 'stale';await options.storage.delete(key);return 'cleared';}
      const loaded=parseEditorDrafts(await options.storage.get(key));if(!current(start))return 'stale';
      if(!loaded.ok)return loaded.reason==='missing'?'missing':'invalid';
      if(!await options.confirm('restore'))return 'cancelled';if(!current(start))return 'stale';
      const names=new Set(start.objectNames);let missing=false;
      const tabs=loaded.value.tabs.map(tab=>{if(tab.objectName&&!names.has(tab.objectName)){missing=true;return {id:tab.id,sql:tab.sql,parameters:tab.parameters,surface:'data' as const};}return {...tab};});
      const next=nextEditorDraftId(loaded.value);options.apply(tabs,loaded.value.activeTab,next);return missing?'restored-missing':'restored';
    }catch{return 'failed';}finally{busy=false;}
  }};
}
