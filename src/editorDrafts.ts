/** Explicitly opt-in persistence model. SQL and parameter text may contain private
 * data: persistence is not enabled here. No results, credentials, connection handles,
 * pending writes or execution state enter the allowlisted document.
 */
export const EDITOR_DRAFT_LIMITS = Object.freeze({ tabs: 10, sql: 8192, parameters: 8192, objectName: 256, bytes: 96 * 1024 });
export interface EditorDraftTab { id: number; sql: string; parameters: string; objectName?: string; surface?: 'data' | 'structure'; }
export interface EditorDrafts { version: 1; tabs: EditorDraftTab[]; activeTab: number | null; }
export type EditorDraftLoad = {ok: true; value: EditorDrafts} | {ok: false; reason: 'missing' | 'invalid-json' | 'unsupported-version' | 'invalid-document' | 'too-large'};
const object=(value: unknown):value is Record<string,unknown> => value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<Number.MAX_SAFE_INTEGER;
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max;
function project(raw: unknown): EditorDrafts | null {
  if(!object(raw)||raw.version!==1||!Array.isArray(raw.tabs)||raw.tabs.length>EDITOR_DRAFT_LIMITS.tabs)return null;
  const tabs:EditorDraftTab[]=[];const ids=new Set<number>();
  for(const item of raw.tabs) {
    if(!object(item)||!validId(item.id)||ids.has(item.id)||!text(item.sql,EDITOR_DRAFT_LIMITS.sql)||!text(item.parameters,EDITOR_DRAFT_LIMITS.parameters))return null;
    if(item.objectName!==undefined&&(!text(item.objectName,EDITOR_DRAFT_LIMITS.objectName)||!item.objectName.length||item.objectName.includes('\0')))return null;
    if(item.surface!==undefined&&item.surface!=='data'&&item.surface!=='structure')return null;
    if(item.surface==='structure'&&item.objectName===undefined)return null;
    ids.add(item.id);
    tabs.push({id:item.id,sql:item.sql,parameters:item.parameters,...(item.objectName!==undefined?{objectName:item.objectName}:{}),...(item.surface!==undefined?{surface:item.surface}:{})});
  }
  if(tabs.length ? !validId(raw.activeTab)||!ids.has(raw.activeTab) : raw.activeTab!==null)return null;
  return {version:1,tabs,activeTab:raw.activeTab as number|null};
}
/** Projection deliberately preserves incomplete parameter JSON: this is an editor
 * draft, never an executable request. Query dispatch must validate it independently.
 */
export function createEditorDrafts(tabs: readonly EditorDraftTab[], activeTab: number | null): EditorDrafts {
  const value=project({version:1,tabs,activeTab});if(!value)throw new Error('Invalid editor draft state; nothing was saved.');
  if(new TextEncoder().encode(JSON.stringify(value)).length>EDITOR_DRAFT_LIMITS.bytes)throw new Error('Editor drafts exceed the 96 KiB storage budget; nothing was saved.');
  return value;
}
export function serializeEditorDrafts(value: EditorDrafts): string {
  if(value.version!==1)throw new Error('Unsupported editor draft version.');
  return JSON.stringify(createEditorDrafts(value.tabs,value.activeTab));
}
/** Fail atomically and explicitly: never silently drop a bad tab or switch active id. */
export function parseEditorDrafts(raw: unknown): EditorDraftLoad {
  if(raw===undefined||raw===null)return {ok:false,reason:'missing'};
  if(typeof raw!=='string')return {ok:false,reason:'invalid-document'};
  if(raw.length>EDITOR_DRAFT_LIMITS.bytes||new TextEncoder().encode(raw).length>EDITOR_DRAFT_LIMITS.bytes)return {ok:false,reason:'too-large'};
  let decoded:unknown;try{decoded=JSON.parse(raw);}catch{return {ok:false,reason:'invalid-json'};}
  if(!object(decoded))return {ok:false,reason:'invalid-document'};
  if(decoded.version!==1)return {ok:false,reason:'unsupported-version'};
  const value=project(decoded);return value?{ok:true,value}:{ok:false,reason:'invalid-document'};
}
export function nextEditorDraftId(value: EditorDrafts): number {
  const next=Math.max(0,...value.tabs.map(tab=>tab.id))+1;
  if(!validId(next))throw new Error('Editor tab id range exhausted.');return next;
}
