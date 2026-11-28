import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultQuery, selectObject } from '../src/domain';

test('schema-aware initial query avoids notes for commerce and quotes identifiers', () => {
  const object = { name: 'odd "table', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }] };
  assert.deepEqual(defaultQuery({ tables: [object] }), { sql: 'SELECT * FROM "main"."odd ""table"', parameters: '[]' });
  assert.equal(selectObject('order_totals'), 'SELECT * FROM "main"."order_totals"');
  const notes = { name: 'notes', columns: ['id', 'title', 'status'].map((name) => ({ name, type: 'TEXT', primaryKey: false })) };
  assert.deepEqual(defaultQuery({ tables: [notes] }), { sql: 'SELECT id, title, status FROM notes WHERE status = ? ORDER BY id', parameters: '["open"]' });
  assert.deepEqual(defaultQuery({ tables: [] }), { sql: 'SELECT 1', parameters: '[]' });
});
