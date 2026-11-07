const zh:Record<string,string>={
 'Create SQLite table':'创建 SQLite 表','Create table':'创建表',
 'Disposable SQLite only. Define columns, preview the exact SQL, then confirm once.':'仅用于临时 SQLite。定义列、预览完整 SQL 后，再确认创建。',
 'Close':'关闭','Cancel':'取消','Table name':'表名','New table name':'新表名称','Columns · {count} / 32':'列 · {count} / 32','Add column':'添加列','Name':'名称','Type':'类型',
 'Column {index} name':'第 {index} 列名称','Column {index} type':'第 {index} 列类型','Column {index} primary key':'第 {index} 列主键','Column {index} nullable':'第 {index} 列允许为空','Primary key':'主键','Nullable':'允许为空','Remove column {index}':'移除第 {index} 列','Remove':'移除',
 'At most one primary key. Selecting it clears the previous primary key and forces NOT NULL. No defaults, expressions, foreign keys, DROP or ALTER are executed here.':'最多设置一个主键。选择新主键会取消原主键，并强制该列非空（NOT NULL）。此处不设置默认值、表达式或外键，也不执行 DROP 或 ALTER。',
 'Preparing preview…':'正在生成预览…','Preview CREATE TABLE':'预览建表 SQL','Confirm create table':'确认创建表','CREATE TABLE review':'建表 SQL 审阅','SQL preview':'SQL 预览',
 'Schema revision {revision}. Any form edit invalidates this preview.':'结构版本 {revision}。修改任意表单内容后，此预览即失效。',
 'Preview does not create a table. Confirmation is unavailable until a current preview exists.':'预览不会创建表。生成与当前表单一致的预览后，才可确认创建。','Reviewed CREATE TABLE SQL':'待确认的建表 SQL',
 'Preview cancelled. No CREATE was submitted.':'预览已取消，未提交建表操作。','Review the exact CREATE statement before confirming.':'请审阅完整建表语句后再确认。','Create table preview failed.':'生成建表预览失败。','Creating the reviewed table…':'正在按已审阅的 SQL 创建表…',
 'Table created. Schema refreshed; no additional SQL was executed.':'表已创建，结构已刷新；未执行其他 SQL。','Table created, but workspace refresh failed. Reopen the schema browser.':'表已创建，但工作区刷新失败。请重新打开结构浏览器。','Create table failed. Preview again before retrying.':'建表失败。请重新预览后再试。',
 'Create table: {code}.':'建表失败：{code}。','Create table: {code}. Preview again before retrying.':'建表失败：{code}。请重新预览后再试。',
};
const reasons:Record<string,string>={draft:'表定义无效（draft）',identifier:'表名或列名无效（identifier）','duplicate-column':'列名重复（duplicate-column）','primary-key':'主键约束无效（primary-key）',budget:'超出允许大小（budget）',exists:'同名对象已存在（exists）',stale:'数据库结构已变化（stale）',review:'预览不匹配或已失效（review）'};
export function createTableTranslator(locale:string){return(message:string,values:Record<string,string|number>={})=>{let text=locale.toLowerCase().startsWith('zh')?(zh[message]??message):message;for(const [key,value] of Object.entries(values))text=text.replaceAll(`{${key}}`,String(value));return text;};}
/** Keep controller diagnostics stable for tests; localize only the rendered view. */
export function translateCreateTableNotice(locale:string,notice:string|null):string{
 if(!notice)return '';const tr=createTableTranslator(locale);
 const match=/^Create table: ([a-z-]+)\.( Preview again before retrying\.)?$/.exec(notice);
 if(match)return tr(match[2]?'Create table: {code}. Preview again before retrying.':'Create table: {code}.',{code:locale.toLowerCase().startsWith('zh')?(reasons[match[1]]??match[1]):match[1]});
 return tr(notice);
}
