const zh:Record<string,string>={
 'Disposable SQLite only. Select existing columns, review the exact SQL, then confirm once.':'仅用于临时 SQLite。选择已有列、审阅完整 SQL 后，再确认创建。',
 'No eligible tables. Create a regular table first.':'暂无可用表，请先创建普通表。','Index name':'索引名称','New index name':'新索引名称','Table':'表','Index table':'索引所属表','Unique index':'唯一索引','Column':'列','Order':'排序',
 'Index column {index}':'索引第 {index} 列','Index column {index} order':'索引第 {index} 列排序','Ascending (ASC)':'升序（ASC）','Descending (DESC)':'降序（DESC）',
 'Column order is significant. UNIQUE rejects duplicate values. No expressions, WHERE clauses, DROP or ALTER are executed here.':'列顺序会影响索引。唯一索引会拒绝重复值。此处不使用表达式或 WHERE 条件，也不执行 DROP 或 ALTER。',
 'Preview CREATE INDEX':'预览索引 SQL','Confirm create index':'确认创建索引','CREATE INDEX review':'索引 SQL 审阅','Reviewed CREATE INDEX SQL':'待确认的索引 SQL',
 'Preview does not create an index. Confirmation requires a current preview.':'预览不会创建索引，生成与当前表单一致的预览后才可确认。',

 'Create SQLite index':'创建 SQLite 索引','Create index':'创建索引',
 
 'Close':'关闭','Cancel':'取消','Columns · {count} / 32':'列 · {count} / 32','Add column':'添加列',
 'Remove column {index}':'移除第 {index} 列','Remove':'移除',
 
 'Preparing preview…':'正在生成预览…','SQL preview':'SQL 预览',
 'Schema revision {revision}. Any form edit invalidates this preview.':'结构版本 {revision}。修改任意表单内容后，此预览即失效。',
 
 'Preview cancelled. No CREATE was submitted.':'预览已取消，未提交创建索引操作。','Review the exact CREATE INDEX statement before confirming.':'请审阅完整创建索引语句后再确认。','Create index preview failed.':'生成创建索引预览失败。','Creating the reviewed index…':'正在按已审阅的 SQL 创建索引…',
 'Index created. Schema refreshed; no additional SQL was executed.':'索引已创建，结构已刷新；未执行其他 SQL。','Index created, but workspace refresh failed. Reopen the schema browser.':'索引已创建，但工作区刷新失败。请重新打开结构浏览器。','Create index failed. Preview again before retrying.':'创建索引失败。请重新预览后再试。',
 'Create index: {code}.':'创建索引失败：{code}。','Create index: {code}. Preview again before retrying.':'创建索引失败：{code}。请重新预览后再试。',
};
const reasons:Record<string,string>={schema:'结构元数据不可用（schema）',table:'表不可用（table）',column:'列不可用（column）',draft:'索引定义无效（draft）',identifier:'索引名、表名或列名无效（identifier）','duplicate-column':'列名重复（duplicate-column）',budget:'超出允许大小（budget）',exists:'同名对象已存在（exists）',stale:'数据库结构已变化（stale）',review:'预览不匹配或已失效（review）'};
export function createIndexTranslator(locale:string){return(message:string,values:Record<string,string|number>={})=>{let text=locale.toLowerCase().startsWith('zh')?(zh[message]??message):message;for(const [key,value] of Object.entries(values))text=text.replaceAll(`{${key}}`,String(value));return text;};}
/** Keep controller diagnostics stable for tests; localize only the rendered view. */
export function translateCreateIndexNotice(locale:string,notice:string|null):string{
 if(!notice)return '';const tr=createIndexTranslator(locale);
 const match=/^Create index: ([a-z-]+)\.( Preview again before retrying\.)?$/.exec(notice);
 if(match)return tr(match[2]?'Create index: {code}. Preview again before retrying.':'Create index: {code}.',{code:locale.toLowerCase().startsWith('zh')?(reasons[match[1]]??match[1]):match[1]});
 return tr(notice);
}
