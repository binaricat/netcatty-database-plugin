const zh:Record<string,string>={
 'Original row':'原始行','Edit fields':'编辑字段','{count} columns':'{count} 列','Review change':'审阅修改','1 row':'1 行','Parameters in binding order':'按绑定顺序排列的参数','All values are shown as JSON, in placeholder order.':'按占位符顺序以 JSON 显示全部值。',

 'The row change definition is invalid. Check the selected action and fields.':'行修改定义无效，请检查所选操作和字段。',
 'This table is unsupported: triggers, cascading changes, virtual tables or incomplete metadata prevent safe single-row editing.':'此表不支持安全单行编辑：可能存在触发器、级联操作、虚拟表或不完整的元数据。',
 'Editing requires complete column metadata, at most 16 columns and no BLOB columns.':'编辑需要完整列元数据，最多 16 列且不含 BLOB 列。',
 'A complete non-null primary key is required and cannot be edited.':'需要完整且非空的主键，主键不能修改。',
 'A value violates its type, nullability or edit-size limit. Check the fields.':'某个值不符合类型、非空约束或编辑大小限制，请检查字段。',
 'This change exceeds the supported edit limit. Reduce its size or use another database client.':'此次修改超过支持的编辑限制，请减小内容或使用其他数据库客户端。',
 'The schema changed. Reload the table and prepare a new preview.':'表结构已变化，请重新加载表并生成新预览。',
 'The review is missing, changed or already consumed. Prepare a new preview before confirming.':'预览缺失、已变化或已使用，请重新生成预览后再确认。',
 'The original row changed or no longer identifies exactly one row. Reload the row before editing again.':'原始行已变化，或无法精确匹配 1 行。请重新加载此行后再编辑。',
 'Preview failed. No change was submitted.':'预览失败，未提交修改。',
 'The change could not be confirmed. Check the table state before preparing another preview.':'无法确认此次修改的结果。请检查表的当前状态后再生成新预览。',

 'Edit or delete one row':'编辑或删除单行','Change one row':'修改单行','Review first. Confirmation compares the complete original row and primary key; a conflict rolls back.':'先审阅再确认。提交时会比对完整原始行及主键；发生冲突则回滚。','Close':'关闭','Cancel':'取消',
 'This row cannot be edited here. A regular table, primary key, complete row, at most 16 columns no BLOB columns, known trigger-free metadata and values within the edit limit are required.':'此行无法在这里编辑。需要普通表、主键和完整原始行，最多 16 列、不含 BLOB 列、已确认无触发器，且值未超出编辑限制。',
 'Action':'操作','Row action':'行操作','Edit values':'编辑值','Delete this row':'删除此行','This permanently deletes exactly one row after confirmation. Check all original values below.':'确认后将永久删除此行（仅 1 行）。请检查下方全部原始值。','Primary key values are read only. Only changed fields will be updated.':'主键值只读，仅更新已修改的字段。','Primary key':'主键','Original value':'原始值','Original: {name}':'原始值：{name}','Value type':'值类型','Type: {name}':'类型：{name}','Text':'文本','Number':'数字','New value':'新值','Value: {name}':'值：{name}',
 'Preparing preview…':'正在生成预览…','Preview change':'预览修改','Confirm delete one row':'确认删除 1 行','Confirm update one row':'确认更新 1 行','SQL and parameters':'SQL 与参数','Schema revision {revision}. Editing invalidates this review.':'结构版本 {revision}。修改后此预览即失效。','No SQL is executed by preview. Confirmation requires a current review.':'预览不执行 SQL，生成与当前表单一致的预览后才可确认。','Reviewed SQL':'待确认 SQL','Reviewed parameters in binding order':'待确认参数（按绑定顺序）',
 'No changed values.':'尚未修改任何值。','Enter a valid finite number and respect NOT NULL constraints.':'请输入有效的有限数字，并遵守非空约束。','Review the SQL and every parameter before confirming.':'请审阅 SQL 和每个参数后再确认。','Preview failed. Refresh the row and try again.':'预览失败，请刷新此行后重试。','Applying the reviewed change…':'正在提交已审阅的修改…','One row changed. No additional SQL was executed.':'已修改 1 行，未执行其他 SQL。','One row changed, but workspace refresh failed. Reload the table.':'已修改 1 行，但工作区刷新失败。请重新加载表。','Change failed or the row became stale. Refresh the row and preview again.':'修改失败，或原始行已变化。请刷新此行后重新预览。',
};
export function rowMutationTranslator(locale:string){return(message:string,values:Record<string,string|number>={})=>{let text=locale.toLowerCase().startsWith('zh')?(zh[message]??message):message;for(const [key,value] of Object.entries(values))text=text.replaceAll(`{${key}}`,String(value));return text;};}
