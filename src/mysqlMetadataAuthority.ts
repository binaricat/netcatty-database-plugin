import type {MysqlPreparedColumn,MysqlPreparedSelect} from './mysqlPreparedProtocol';
/** Narrow fixed system-view projections. Never a caller-provided origin policy. */
export const MYSQL_METADATA_PROJECTIONS = Object.freeze({
 TABLES:Object.freeze(['TABLE_NAME','TABLE_TYPE','ENGINE']),
 COLUMNS:Object.freeze(['COLUMN_NAME','ORDINAL_POSITION','DATA_TYPE','COLUMN_TYPE','IS_NULLABLE','COLUMN_DEFAULT','EXTRA']),
 STATISTICS:Object.freeze(['INDEX_NAME','NON_UNIQUE','SEQ_IN_INDEX','COLUMN_NAME','COLLATION','INDEX_TYPE','EXPRESSION']),
});
export function isFixedMysqlMetadataPlan(o:MysqlPreparedSelect):boolean {
 const expected=MYSQL_METADATA_PROJECTIONS[o.table as keyof typeof MYSQL_METADATA_PROJECTIONS];
 return o.schema==='information_schema'&&Boolean(expected)&&JSON.stringify(o.columns)===JSON.stringify(expected)&&
  Array.isArray(o.where)&&o.where.length===(o.table==='TABLES'?1:2)&&o.where.every((p,i)=>p.column===(i?'TABLE_NAME':'TABLE_SCHEMA')&&p.value?.kind==='text'&&typeof p.value.value==='string'&&p.value.value.length>0&&p.value.value.length<=64&&!p.value.value.includes('\0'));
}
/** MySQL 8.4.7 TABLES view: TABLE_TYPE is tbl.type (ENUM); ENGINE is
 * IF(tbl.type = 'BASE TABLE', tbl.engine, NULL). Observed UTF-8 field flags
 * include BINARY_FLAG on names/ENUM, not binary charset data. Only these exact
 * observed tuples may use text decoding. Raw PREPARE/EXECUTE metadata remains
 * compared before this decoding-only normalization. COLUMNS exceptions below
 * are separately evidenced by the second real 8.4.7 capture. STATISTICS exceptions follow the third real capture. */
export function mysqlMetadataDecodeColumn(table:string,c:MysqlPreparedColumn):MysqlPreparedColumn {
 if(c.table!==table||c.originalTable!==table||c.originalName!==c.name)return c;
 if(table==='STATISTICS'&&c.schema===''&&c.charset===45&&((c.name==='INDEX_TYPE'&&c.type===253&&c.flags===129)||(c.name==='EXPRESSION'&&c.type===252&&c.flags===128)))return {...c,flags:c.flags&~128};
 if(table==='COLUMNS'&&c.charset===45&&((c.name==='DATA_TYPE'&&c.schema===''&&c.type===251&&c.flags===128)||(c.name==='COLUMN_TYPE'&&c.schema==='information_schema'&&c.type===252&&c.flags===4241)||(c.name==='COLUMN_DEFAULT'&&c.schema==='information_schema'&&c.type===252&&c.flags===144)))return {...c,flags:c.flags&~128};
 if(table!=='TABLES')return c;
 if(c.charset===45&&((c.name==='TABLE_NAME'&&c.type===253&&c.flags===20609)||(c.name==='TABLE_TYPE'&&c.type===254&&c.flags===20873)))return {...c,flags:c.flags&~(128|256)};
 return c;
}
export function mysqlMetadataExpressionOrigin(table:string,c:MysqlPreparedColumn):boolean {
 if(c.table!==table||c.originalTable!==table||c.originalName!==c.name)return false;
 if(table==='STATISTICS'&&c.schema==='')return (c.name==='NON_UNIQUE'&&c.type===8&&c.charset===63&&c.flags===129)||(c.charset===45&&((['INDEX_NAME','COLUMN_NAME','COLLATION'].includes(c.name)&&c.type===253&&c.flags===0)||(c.name==='INDEX_TYPE'&&c.type===253&&c.flags===129)||(c.name==='EXPRESSION'&&c.type===252&&c.flags===128)));
 if(table==='COLUMNS'&&c.schema===''&&c.charset===45)return ((c.name==='COLUMN_NAME'||c.name==='EXTRA')&&c.type===253&&c.flags===0)||(c.name==='IS_NULLABLE'&&c.type===253&&c.flags===1)||(c.name==='DATA_TYPE'&&c.type===251&&c.flags===128);
 return table==='TABLES'&&c.name==='ENGINE'&&c.schema===''&&c.type===253&&c.charset===45&&c.flags===0;
}
