import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyQueryLibrary, recordQuery, saveQuery, removeSavedQuery, clearQueryHistory, serializeQueryLibrary, parseQueryLibrary, QUERY_LIBRARY_LIMITS } from '../src/queryLibrary';
const input = { sql: 'SELECT ?', parameters: '[1]', connectionName: 'test', success: true, time: 1000 };
test('history is immutable, newest first, deduplicated within a connection and bounded', () => {
  const empty = emptyQueryLibrary(); let library = recordQuery(empty, input);
  assert.equal(empty.history.length, 0);
  library = recordQuery(library, { ...input, time: 1001, success: false });
  assert.equal(library.history.length, 1); assert.equal(library.history[0].success, false);
  library = recordQuery(library, { ...input, connectionName: 'other' });
  assert.equal(library.history.length, 2);
  for (let i = 0; i < 40; i++) library = recordQuery(library, { ...input, sql: `SELECT ${i}` });
  assert.equal(library.history.length, QUERY_LIBRARY_LIMITS.history);
  assert.equal(library.history[0].sql, 'SELECT 39');
  assert.equal(new Set(library.history.map(item => item.id)).size, library.history.length);
});
test('saved queries update by trimmed name, preserve id, delete, and reject capacity overflow', () => {
  let library = saveQuery(emptyQueryLibrary(), { name: ' Example ', sql: 'SELECT 1', parameters: '[]', time: 1 });
  const id = library.saved[0].id;
  library = saveQuery(library, { name: 'Example', sql: 'SELECT 2', parameters: '[]', time: 2 });
  assert.equal(library.saved.length, 1); assert.equal(library.saved[0].id, id);
  for (let i = 1; i < 30; i++) library = saveQuery(library, { name: String(i), sql: 'SELECT 1', parameters: '[]', time: 1 });
  assert.throws(() => saveQuery(library, { name: 'overflow', sql: 'SELECT 1', parameters: '[]', time: 1 }));
  assert.equal(removeSavedQuery(library, id).saved.length, 29);
  assert.equal(library.saved.length, 30);
  assert.equal(clearQueryHistory(recordQuery(library, input)).saved.length, 30);
});
test('roundtrip permits only query metadata; unknown credentials and results are stripped', () => {
  const library = recordQuery(saveQuery(emptyQueryLibrary(), { name: 'Query', sql: 'SELECT 1', parameters: '[]', time: 1 }), input);
  assert.deepEqual(parseQueryLibrary(serializeQueryLibrary(library)), library);
  const extra = { ...library, password: 'secret', history: [{ ...library.history[0], result: ['private'], password: 'secret' }] };
  assert.deepEqual(parseQueryLibrary(JSON.stringify(extra)), library);
  assert.equal(serializeQueryLibrary(extra).includes('secret'), false);
});
test('malformed, huge, future-version and duplicate storage fail closed', () => {
  for (const raw of [null, {}, 'null', '{', '{}', JSON.stringify({version: 2, history:[], saved:[]}), 'x'.repeat(QUERY_LIBRARY_LIMITS.bytes + 1)]) assert.deepEqual(parseQueryLibrary(raw), emptyQueryLibrary());
  const library = recordQuery(emptyQueryLibrary(), input);
  assert.deepEqual(parseQueryLibrary(JSON.stringify({ ...library, history: [library.history[0], library.history[0]] })), emptyQueryLibrary());
  assert.deepEqual(parseQueryLibrary(JSON.stringify({ ...library, history: [{ ...library.history[0], time: -1 }] })), emptyQueryLibrary());
});
test('reject rather than truncate SQL and parameters; scalars only and finite safe timestamps', () => {
  for (const patch of [{sql: ''}, {sql: 'x'.repeat(8193)}, {parameters: '{}'}, {parameters: '[{}]'}, {parameters: '[1e999]'}, {parameters: JSON.stringify(Array(33).fill(null))}, {time: NaN}, {time: 1.5}, {connectionName:'x'.repeat(129)}]) assert.throws(() => recordQuery(emptyQueryLibrary(), { ...input, ...patch }));
});
test('UTF-8 storage size is bounded independently of string length', () => {
  let library = emptyQueryLibrary();
  for (let i = 0; i < 30; i++) library = recordQuery(library, { ...input, sql: `${i}${'界'.repeat(8000)}` });
  assert.throws(() => serializeQueryLibrary(library), /storage limit/);
  assert.deepEqual(parseQueryLibrary(JSON.stringify(library)), emptyQueryLibrary());
});
