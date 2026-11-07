import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectionModalChannel } from '../src/connectionModalChannel';
test('only the opening workbench owns modal state, and release clears it', () => {
  const channel = createConnectionModalChannel<{ modal: boolean; name: string }>();
  const a = Symbol(), b = Symbol(); let changes = 0;
  const stop = channel.subscribe(() => { changes++; });
  assert.equal(channel.publish(a, { modal: false, name: 'a' }, false), false);
  assert.equal(channel.publish(a, { modal: true, name: 'a' }, true), true);
  assert.equal(channel.publish(b, { modal: true, name: 'b' }, true), false);
  assert.equal(channel.getSnapshot()?.name, 'a');
  channel.release(b); assert.equal(channel.getSnapshot()?.name, 'a');
  channel.release(a); assert.equal(channel.getSnapshot(), null);
  assert.equal(changes, 2); stop();
  assert.equal(channel.publish(b, { modal: true, name: 'b' }, true), true);
});
