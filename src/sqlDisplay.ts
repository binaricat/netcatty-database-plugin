// Display-only lexical hints. Execution and SQL validation remain with the host.
export type SqlToken = { kind: 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'identifier'; text: string };
export const MAX_SQL_LENGTH = 8192;
export const MAX_HIGHLIGHT_SEGMENTS = 20;
export const DEFAULT_EDITOR_SPLIT = 52;
export const MIN_EDITOR_SPLIT = 30;
export const MAX_EDITOR_SPLIT = 70;
export function clampEditorSplit(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_EDITOR_SPLIT, Math.max(MIN_EDITOR_SPLIT, Math.round(value))) : DEFAULT_EDITOR_SPLIT;
}
const keywords = new Set('SELECT FROM WHERE ORDER BY GROUP HAVING LIMIT OFFSET AS JOIN LEFT RIGHT INNER OUTER CROSS ON AND OR NOT NULL IS IN LIKE BETWEEN DISTINCT UNION ALL WITH RECURSIVE CASE WHEN THEN ELSE END ASC DESC INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER EXISTS TRUE FALSE PRAGMA RETURNING'.split(' '));
export function tokenizeSql(sql: string): SqlToken[] {
  // Bounded input and bounded output; overflow falls back without losing text.
  if (sql.length > MAX_SQL_LENGTH) return [{ kind: 'plain', text: sql }];
  const pattern = /--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|\b(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?)\b|[a-z_$][\w$]*|[^\w'"`[/-]+|./gi;
  const tokens: SqlToken[] = [];
  for (const match of sql.matchAll(pattern)) {
    const text = match[0];
    const kind: SqlToken['kind'] = text.startsWith('--') || text.startsWith('/*') ? 'comment' : text.startsWith("'") ? 'string' : /^["`[]/.test(text) ? 'identifier' : /^\d/.test(text) ? 'number' : keywords.has(text.toUpperCase()) ? 'keyword' : 'plain';
    const last = tokens.at(-1);
    if (last?.kind === kind) last.text += text;
    else tokens.push({ kind, text });
    if (tokens.length > MAX_HIGHLIGHT_SEGMENTS) return [{ kind: 'plain', text: sql }];
  }
  return tokens;
}
export function sqlLines(sql: string): string[] { return sql.split(/\r\n|\r|\n/); }
export function lineNumbers(sql: string): string { return sqlLines(sql).map((_, i) => i + 1).join('\n'); }
// Each remote text value must fit 8192, even for 8193 empty lines of SQL.
export function gutterChunks(sql: string): string[] { return lineNumbers(sql).match(/[\s\S]{1,8192}/g) ?? ['1']; }
