import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenizeSql, lineNumbers, gutterChunks, clampEditorSplit, MAX_HIGHLIGHT_SEGMENTS } from '../src/sqlDisplay';

test('display tokenizer recognizes keywords, quoted strings, comments and numeric literals without changing SQL', () => {
  const sql = "select 'it''s WHERE', 12.5e2 -- FROM\nFROM [order items]";
  const tokens = tokenizeSql(sql);
  assert.equal(tokens.map((t) => t.text).join(''), sql);
  for (const [kind, text] of [['keyword', 'select'], ['string', "'it''s WHERE'"], ['number', '12.5e2'], ['comment', '-- FROM'], ['identifier', '[order items]']]) assert.ok(tokens.some((t) => t.kind === kind && t.text === text));
});
test('incomplete quotes/comments are inert display text and SQL HTML stays literal', () => {
  for (const [sql, kind] of [["'unfinished", 'string'], ['/* unfinished', 'comment'], ['"SELECT"', 'identifier'], ['`DROP`', 'identifier']]) assert.deepEqual(tokenizeSql(sql), [{ kind, text: sql }]);
  const sql = "SELECT '<img onerror=alert(1)>'";
  assert.equal(tokenizeSql(sql).map((t) => t.text).join(''), sql);
  assert.equal(tokenizeSql('selector from_here')[0].kind, 'plain');
});
test('highlight budget degrades to lossless plain SQL with bounded nodes', () => {
  const maximal = tokenizeSql("1'a'".repeat(10));
  assert.equal(maximal.length, MAX_HIGHLIGHT_SEGMENTS);
  assert.ok(maximal.every((t) => t.kind !== 'plain'));
  for (const sql of ['SELECT 1, '.repeat(800).slice(0, 8192), '\n'.repeat(8192), 'a'.repeat(8193)]) {
    const tokens = tokenizeSql(sql);
    assert.ok(tokens.length <= MAX_HIGHLIGHT_SEGMENTS);
    assert.equal(tokens.map((t) => t.text).join(''), sql);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, 'plain');
  }
});
test('line numbers include blank/trailing lines, normalize newline forms and chunk within host text limits', () => {
  assert.equal(lineNumbers(''), '1');
  assert.equal(lineNumbers('SELECT 1;\r\n\r\n-- end\r'), '1\n2\n3\n4');
  const sql = '\n'.repeat(8192);
  assert.equal(gutterChunks(sql).join(''), lineNumbers(sql));
  assert.ok(gutterChunks(sql).every((s) => s.length <= 8192));
  assert.ok(lineNumbers(sql).endsWith('8193'));
});
test('split uses safe session default and clamps invalid/out-of-range values', () => {
  assert.deepEqual([-1, 30, 52, 52.7, 100, NaN, Infinity].map(clampEditorSplit), [30, 30, 52, 53, 70, 52, 52]);
});
