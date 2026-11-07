/** Bounded lexical inspection, not a SQL parser. Quoted text stays an opaque
 * token so it cannot become a keyword or join two unrelated keyword sequences. */
export function sqliteSchemaTokens(sql:string):string[]{
 if(typeof sql!=='string'||new TextEncoder().encode(sql).length>8192||sql.includes('\0'))throw new Error('Invalid schema SQL');
 const tokens:string[]=[];let i=0;const push=(token:string)=>{if(tokens.length>=2048)throw new Error('Schema token budget');tokens.push(token);};
 while(i<sql.length){const char=sql[i];
  if(/[\t\n\r\f ]/.test(char)){i++;continue;}
  // SQLite line comments end at LF or EOF; bare CR remains comment content.
  if(sql.startsWith('--',i)){i+=2;while(i<sql.length&&sql[i]!=='\n')i++;continue;}
  if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);if(end<0)throw new Error('Unclosed schema comment');i=end+2;continue;}
  if(char==='"'||char==="'"||char==='`'||char==='['){const close=char==='['?']':char;i++;let closed=false;while(i<sql.length){if(sql[i]===close){if(char!=='['&&sql[i+1]===close){i+=2;continue;}i++;closed=true;break;}i++;}if(!closed)throw new Error('Unclosed schema quote');push('#quoted');continue;}
  if(/[A-Za-z_\u0080-\uFFFF]/.test(char)){const start=i++;while(i<sql.length&&/[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i]))i++;push(sql.slice(start,i).toUpperCase());continue;}
  if(/[0-9]/.test(char)){const start=i++;while(i<sql.length&&/[A-Za-z0-9_.]/.test(sql[i]))i++;push(sql.slice(start,i));continue;}
  if('(),.;+-*/%<>=!~|&?:@$'.includes(char)){push(char);i++;continue;}
  throw new Error('Unexpected schema token');
 }
 return tokens;
}
export function schemaTokenSequence(tokens:readonly string[],...sequence:string[]):boolean{return sequence.length>0&&tokens.some((_,index)=>sequence.every((token,offset)=>tokens[index+offset]===token));}
