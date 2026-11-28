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

test('native modal visibility notifies both renderers without replacing the draft', () => {
  const channel = createConnectionModalChannel<string>();
  const owner = Symbol(); channel.publish(owner, 'draft', true);
  let changes = 0; channel.subscribe(() => { changes++; });
  assert.equal(channel.isNativeOpen(), false);
  channel.setNativeOpen(true); assert.equal(channel.isNativeOpen(), true);
  assert.equal(channel.getSnapshot(), 'draft');
  channel.setNativeOpen(false); assert.equal(channel.isNativeOpen(), false);
  assert.equal(changes, 2);
});
