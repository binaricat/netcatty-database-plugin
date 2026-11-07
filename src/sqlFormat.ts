/** Conservative SQLite whitespace formatting, not parsing, execution or selection editing.
 * Token spelling/order is immutable. Unsupported lexical constructs fail closed.
 * O(n) scanning and printing, <=8192 UTF-16 units / UTF-8 bytes, <=2048 tokens.
 */
export class SqlFormatError extends Error {constructor(readonly code:'input'|'budget'|'unsupported'|'incomplete'|'invariant'){super(`SQL format ${code}`);}}
type Token={text:string;kind:'word'|'opaque'|'number'|'parameter'|'symbol'|'line-comment'|'comment'};
const fail=(code:SqlFormatError['code']):never=>{throw new SqlFormatError(code);};
const LIMIT=8192;
function bounded(source:string){if(typeof source!=='string')fail('input');if(source.length>LIMIT||new TextEncoder().encode(source).length>LIMIT)fail('budget');if(source.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(source))fail('input');}
function lex(source:string):Token[]{
 bounded(source);const tokens:Token[]=[];let i=0,depth=0;
 const push=(start:number,kind:Token['kind'])=>{if(tokens.length>=2048)fail('budget');tokens.push({text:source.slice(start,i),kind});};
 while(i<source.length){if(/[ \t\r\n]/.test(source[i])){i++;continue;}const start=i,c=source[i],next=source[i+1];
  if(c==='-'&&next==='-'){i+=2;while(i<source.length&&source[i]!=='\r'&&source[i]!=='\n')i++;if(source[i]==='\r'){i++;if(source[i]==='\n')i++;}else if(source[i]==='\n')i++;push(start,'line-comment');continue;}
  if(c==='/'&&next==='*'){i+=2;let done=false;while(i<source.length){if(source[i]==='/'&&source[i+1]==='*')fail('unsupported');if(source[i]==='*'&&source[i+1]==='/'){i+=2;done=true;break;}i++;}if(!done)fail('incomplete');push(start,'comment');continue;}
  if(c==="'"||c==='"'||c==='`'||c==='['){const end=c==='['?']':c;i++;let done=false;while(i<source.length){if(source[i]===end){i++;if(c!=='['&&source[i]===end){i++;continue;}done=true;break;}i++;}if(!done)fail('incomplete');push(start,'opaque');continue;}
  // Blob adjacency (X'...') is semantic: keep the entire literal indivisible.
  if((c==='x'||c==='X')&&next==="'"){i+=2;const data=i;while(i<source.length&&/[0-9a-fA-F]/.test(source[i]))i++;if(source[i]!=="'"||(i-data)%2)fail('unsupported');i++;push(start,'opaque');continue;}
  if(/[A-Za-z_]/.test(c)){i++;while(i<source.length&&/[A-Za-z0-9_$]/.test(source[i]))i++;if(source[i]==="'")fail('unsupported');push(start,'word');continue;}
  if(/[0-9]/.test(c)||(c==='.'&&/[0-9]/.test(next??''))){
   if(c==='0'&&/[xX]/.test(next??'')){i+=2;const digits=i;while(i<source.length&&/[0-9a-fA-F]/.test(source[i]))i++;if(i===digits)fail('incomplete');}
   else{while(i<source.length&&/[0-9]/.test(source[i]))i++;if(source[i]==='.'){i++;while(i<source.length&&/[0-9]/.test(source[i]))i++;}if(/[eE]/.test(source[i]??'')){i++;if(/[+-]/.test(source[i]??''))i++;const digits=i;while(i<source.length&&/[0-9]/.test(source[i]))i++;if(i===digits)fail('incomplete');}}
   if(/[A-Za-z_$]/.test(source[i]??''))fail('unsupported');push(start,'number');continue;
  }
  if(c==='?'||c===':'||c==='@'||c==='$'){i++;if(c==='?'){while(i<source.length&&/[0-9]/.test(source[i]))i++;}else{if(!/[A-Za-z_]/.test(source[i]??''))fail('unsupported');while(i<source.length&&/[A-Za-z0-9_]/.test(source[i]))i++;if(c==='$'&&(source[i]==='$'||source[i]===':'||source[i]==='('))fail('unsupported');}push(start,'parameter');continue;}
  const op=['->>','->','||','<=','>=','!=','<>','==','<<','>>'].find(op=>source.startsWith(op,i));
  if(op){i+=op.length;push(start,'symbol');continue;}
  if('(),;.+-*/%=<>~&|'.includes(c)){i++;if(c==='('&&++depth>64)fail('budget');if(c===')'&&--depth<0)fail('incomplete');push(start,'symbol');continue;}
  fail('unsupported');
 }
 if(depth!==0)fail('incomplete');return tokens;
}
const clause=new Set(['SELECT','FROM','WHERE','HAVING','LIMIT','OFFSET','VALUES','SET','RETURNING','UNION','INTERSECT','EXCEPT']);
/** Returns a full-document draft; callers must explicitly apply it, never execute it. */
export function formatSqliteWhitespace(source:string):string{
 const tokens=lex(source);if(!tokens.length)return source;
 // Only ordinary SQL statement families. No procedural/trigger bodies or PRAGMA.
 const starts=new Set(['SELECT','WITH','INSERT','UPDATE','DELETE','CREATE','ALTER','DROP','EXPLAIN']);
 if(tokens.some(t=>t.kind==='word'&&['TRIGGER','PROCEDURE','FUNCTION','DELIMITER','DO'].includes(t.text.toUpperCase())))fail('unsupported');
 let statementStart=true;for(const t of tokens){if(t.kind==='comment'||t.kind==='line-comment')continue;if(statementStart&&!(t.kind==='word'&&starts.has(t.text.toUpperCase())))fail('unsupported');statementStart=t.text===';';}
 let result='',depth=0;for(let n=0;n<tokens.length;n++){const t=tokens[n],prev=tokens[n-1],upper=t.kind==='word'?t.text.toUpperCase():'';
  const newline=depth===0&&(clause.has(upper)||(upper==='ORDER'||upper==='GROUP')&&tokens[n+1]?.text.toUpperCase()==='BY'||upper==='JOIN'||prev?.text===';');
  let gap=result&&!/[\r\n]$/.test(result)?(newline?'\n':' '):'';
  if(t.text===','||t.text===';'||t.text===')'||t.text==='.'||prev?.text==='('||prev?.text==='.')gap='';
  // Preserve unary/numeric spelling by relying on the final lexical invariant.
  result+=gap+t.text;if(t.text==='(')depth++;else if(t.text===')')depth--;
  if(result.length>LIMIT)fail('budget');
 }
 bounded(result);const roundtrip=lex(result);
 if(JSON.stringify(roundtrip)!==JSON.stringify(tokens))fail('invariant');return result;
}
