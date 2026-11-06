import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseParameters, DraftStream, tasks } from '../src/domain';
import type { PluginAIClient, PluginAIStreamEvent } from '@netcatty/plugin-sdk';
const schema = { tables: [{ name: 'notes', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }] }] };
test('parameters stay data; bounded scalars only', () => {
  assert.deepEqual(parseParameters('["x\' OR 1=1 --", null, 3, false]'), ["x' OR 1=1 --", null, 3, false]);
  for (const value of ['{}', '[{}]', '[[]]', JSON.stringify(['x'.repeat(2049)]), JSON.stringify(Array(33).fill(1))]) assert.throws(() => parseParameters(value));
});
test('every SQL AI task is grounded, bounded and requires a schema', () => {
  for (const task of tasks) {
    const prompt = buildPrompt(task, schema, 'SELECT id FROM notes', 'explain');
    assert.match(prompt, /untrusted data/); assert.match(prompt, /unexecuted draft/); assert.match(prompt, /notes/); assert.match(prompt, new RegExp(`Task: ${task}`));
    assert.throws(() => buildPrompt(task, null, 'SELECT 1', ''), /schema/);
  }
});
function mock(events: PluginAIStreamEvent[]) {
  const calls: string[] = [];
  const ai: PluginAIClient = {
    openChat: async () => { calls.push('open'); return { chatHandle: 'chat', model: 'synthetic mock', expiresAt: 1 }; },
    startTurn: async () => { calls.push('start'); return { turnHandle: 'turn', maxOutputTokens: 2048, reservedTokens: 2048 }; },
    readTurn: async () => { calls.push('read'); return events.shift()!; },
    stopTurn: async () => { calls.push('stop'); return { ok: true }; },
    closeChat: async () => { calls.push('close'); return { ok: true }; },
  };
  return { ai, calls };
}
test('mock host streaming accumulates text and closes handles, never executes SQL', async () => {
  const { ai, calls } = mock([{ kind: 'text', sequence: 1, text: 'SELECT ' }, { kind: 'usage', sequence: 2, totalTokens: 3 }, { kind: 'text', sequence: 3, text: '1;' }, { kind: 'end', sequence: 4 }]);
  const values: string[] = []; await new DraftStream(ai).run('bounded prompt', (text) => values.push(text));
  assert.deepEqual(values, ['SELECT ', 'SELECT 1;']); assert.deepEqual(calls.slice(-2), ['stop', 'close']);
});
test('stopping while host read is pending discards late output', async () => {
  const { ai, calls } = mock([]); let resolve!: (event: PluginAIStreamEvent) => void;
  ai.readTurn = () => new Promise((r) => { resolve = r; });
  const values: string[] = []; const stream = new DraftStream(ai); const pending = stream.run('prompt', (text) => values.push(text));
  while (!resolve) await new Promise<void>((r) => setImmediate(r));
  await stream.stop(); resolve({ kind: 'text', sequence: 1, text: 'STALE' }); await pending;
  assert.deepEqual(values, []); assert.ok(calls.includes('close'));
});
test('bad sequence and excessive output close host handles', async () => {
  for (const events of [[{ kind: 'text', sequence: 1, text: 'x' }, { kind: 'text', sequence: 1, text: 'x' }], [{ kind: 'text', sequence: 1, text: 'x'.repeat(32769) }]] as PluginAIStreamEvent[][]) {
    const { ai, calls } = mock(events); await assert.rejects(new DraftStream(ai).run('prompt', () => {})); assert.ok(calls.includes('close'));
  }
});
