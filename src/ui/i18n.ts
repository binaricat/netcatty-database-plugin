/**
 * Clean bilingual localization helpers (English & Simplified Chinese) for the DBX Workbench.
 * Automatically tracks Netcatty's `context.environment.locale`.
 */

const ZH: Record<string, string> = {
  // General & chrome
  'Database': '数据库',
  'Connections': '连接',
  'New': '新建',
  'New Connection': '新建连接',
  'Edit Connection': '编辑连接',
  'New Query': '新建查询',
  'Open SQLite': '打开 SQLite',
  'Open Local SQLite File': '打开本地 SQLite 文件',
  'Launch Sample SQLite': '启动示例 SQLite',
  'Connect': '连接',
  'Disconnect': '断开连接',
  'Connected': '已连接',
  'Connecting...': '正在连接...',
  'Disconnected': '未连接',
  'Refresh': '刷新',
  'Search': '搜索',
  'Search connections or objects...': '搜索连接或对象...',
  'Search engines...': '搜索数据库引擎...',
  'Close': '关闭',
  'Cancel': '取消',
  'Save': '保存',
  'Save & Connect': '保存并连接',
  'Test Connection': '测试连接',
  'Testing...': '测试中...',
  'Apply': '应用',
  'Clear': '清除',
  'Commit': '提交',
  'Discard': '放弃',
  'Delete': '删除',
  'Duplicate': '复制',
  'Edit': '编辑',
  'Back': '返回',
  'Next': '下一步',
  'Copy': '复制',
  'Copied': '已复制',
  'Export': '导出',
  'Import': '导入',
  'Loading...': '加载中...',
  'No results': '暂无结果',

  // Welcome
  'Database Workbench': '数据库工作台',
  'Connect to PostgreSQL, MySQL, MariaDB, SQLite, ClickHouse, Redis, and MongoDB directly inside Netcatty.': '在 Netcatty 中直接连接 PostgreSQL、MySQL、MariaDB、SQLite、ClickHouse、Redis 与 MongoDB。',
  'Saved Connections': '已保存的连接',
  'Create a connection or open a local SQLite database to start querying.': '新建连接或打开本地 SQLite 文件即可开始查询。',
  'Configure any of 22 engines with TLS & SSH tunnels': '支持 22 种引擎、TLS/STARTTLS 与 Vault SSH 隧道',
  'Inspect and edit any .db / .sqlite file locally': '在本地查看并编辑 .db / .sqlite 数据库文件',
  'Explore pre-seeded customers, products, and orders': '体验内置的客户、商品与订单示例库',

  // Connection Drawer
  'Select Database Engine': '选择数据库引擎',
  'All': '全部',
  'Relational': '关系型',
  'NoSQL': 'NoSQL',
  'Analytics': '分析型',
  'Domestic': '国产数据库',
  'Local': '本地文件',
  'Ready': '可用',
  'Catalog': '仅目录',
  'Import from URI / DSN': '从 URI / DSN 快速导入',
  'Parse': '解析',
  'Name': '连接名称',
  'Folder / Group': '分组文件夹',
  'Color Tag': '颜色标签',
  'Host': '主机地址',
  'Port': '端口',
  'Database / Schema': '数据库',
  'Auth Source': '认证库 (AuthSource)',
  'Redis DB Index': 'Redis 库索引',
  'Username': '用户名',
  'Password': '密码',
  'Stored encrypted in Netcatty Secrets': '加密保存在 Netcatty 密钥库',
  'TLS / Encryption': 'TLS / 加密传输',
  'Off': '关闭',
  'Prefer STARTTLS': '优先 STARTTLS',
  'Require STARTTLS': '强制 STARTTLS',
  'Direct TLS': '直连 TLS',
  'Allow self-signed certificate (prompts for fingerprint approval)': '允许自签名证书（首次连接需确认指纹）',
  'Netcatty Vault SSH Tunnel': 'Netcatty Vault SSH 隧道',
  'Pick Vault SSH Host': '选择 Vault SSH 主机',
  'Change Host': '更换主机',
  'Revoke Binding': '撤销持久绑定',
  'Durable tunnel bound': '已绑定持久隧道',
  'SQLite Source': 'SQLite 数据源',
  'Sample Shop Database (In-Memory)': '示例商城数据库（内存）',
  'Empty In-Memory Database': '空白内存数据库',
  'Local .db / .sqlite File': '本地 .db / .sqlite 文件',
  'Choose SQLite File...': '选择 SQLite 文件...',

  // Explorer & Context menus
  'Tables': '数据表',
  'Views': '视图',
  'Functions & Procedures': '函数与存储过程',
  'Triggers': '触发器',
  'Collections': '集合',
  'Columns': '列',
  'Indexes': '索引',
  'Foreign Keys': '外键',
  'Open Data': '查看数据',
  'Design Structure': '设计表结构',
  'View ER Diagram': '查看 ER 关系图',
  'Copy Name': '复制名称',
  'Generate SELECT': '生成 SELECT 语句',
  'View DDL': '查看建表 DDL',
  'Export Table': '导出表数据',
  'Dump Schema SQL': '导出结构 SQL',
  'Truncate Table': '清空表数据',
  'Drop Object': '删除对象',
  'Export URI': '复制连接 URI',
  'Create Table': '新建数据表',
  'Open Redis Browser': '打开 Redis 浏览器',
  'Schema Diff': '结构对比',

  // SQL Query Tab
  'Run': '运行',
  'Run Selection': '运行选中',
  'Format': '格式化',
  'Explain': '执行计划',
  'Analyze': '分析计划',
  'Auto Tx': '自动提交',
  'Manual Tx': '手动事务',
  'Begin': '开启事务',
  'Rollback': '回滚',
  'Open .sql': '打开 .sql',
  'Save .sql': '保存 .sql',
  'History': '历史',
  'Snippets': '代码片段',
  'AI Assistant': 'AI 助手',
  'Messages': '消息',
  'Explain Plan': '执行计划',
  'Export CSV': '导出 CSV',
  'Export JSON': '导出 JSON',
  'Export Markdown': '导出 Markdown',
  'Export SQL INSERT': '导出 SQL INSERT',
  'Export XLSX': '导出 Excel (XLSX)',
  'Copy CSV to Clipboard': '复制 CSV 到剪贴板',
  'Copy JSON to Clipboard': '复制 JSON 到剪贴板',

  // Table Data Tab
  'Filter WHERE clause...': '输入 WHERE 过滤条件...',
  'Add Row': '新增行',
  'Delete Selected': '删除选中',
  'Preview SQL': '预览 SQL',
  'Pending changes': '待提交变更',
  'Inspect / Edit Cell': '查看 / 编辑单元格',
  'Copy Value': '复制单元格值',
  'Copy Row as JSON': '复制整行为 JSON',
  'Copy Row as SQL INSERT': '复制整行为 SQL INSERT',
  'Set NULL': '设为 NULL',
  'Duplicate Row': '复制行',
  'Delete Row': '删除行',
  'Save .sqlite': '保存 .sqlite',

  // Structure Tab
  'Add Column': '新增列',
  'Add Index': '新增索引',
  'Preview ALTER DDL': '预览 ALTER DDL',
  'Apply Changes': '执行变更',
  'Rename Table': '重命名表',

  // ER Diagram
  'ER Diagram': 'ER 关系图',
  'Filter tables...': '筛选数据表...',
  'Dump SQL': '导出 SQL',

  // Redis
  'Tree': '树形',
  'Flat': '平铺',
  'New Key': '新建键',
  'Server Info': '服务信息',
  'CLI Console': 'CLI 控制台',
  'Persist (Remove TTL)': '永久保留 (移除 TTL)',
  'Rename': '重命名',

  // MongoDB
  'Find': '查询 (Find)',
  'Aggregate': '聚合 (Aggregate)',
  'Insert Doc': '插入文档',
  'Documents': '文档',
  'Table': '表格',
  'JSON': 'JSON',

  // Drawers
  'AI SQL Assistant': 'AI SQL 助手',
  'Generate': '生成 SQL',
  'Optimize': '优化 SQL',
  'Fix Error': '修复错误',
  'Insert into Editor': '插入到编辑器',
  'Query History & Snippets': '查询历史与代码片段',
  'Cell & Row Inspector': '单元格与行检查器',
  'SQL Preview': 'SQL 预览',
  'Import Data': '导入数据',
};

export function createUiTranslator(locale?: string): (key: string, vars?: Record<string, string | number>) => string {
  const isZh = (locale ?? 'en').toLowerCase().startsWith('zh');
  return (key: string, vars?: Record<string, string | number>): string => {
    let text = isZh ? (ZH[key] ?? key) : key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  };
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatTtl(ttlMs: number): string {
  if (ttlMs === -1) return '∞';
  if (ttlMs < 0) return 'expired';
  const secs = Math.floor(ttlMs / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d`;
}
