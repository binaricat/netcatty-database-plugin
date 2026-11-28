import assert from 'node:assert/strict';
import test from 'node:test';
import { translator, zhCN, type Message } from '../src/i18n';
import { ParameterError, parseParameters } from '../src/domain';

test('host zh-CN selects Chinese; English and unsupported host languages fall back to English', () => {
  assert.equal(translator('zh-CN')('New Connection'), '新建连接');
  for (const locale of ['en', 'en-US', 'zh-TW', 'fr', '', undefined]) {
    assert.equal(translator(locale)('New Connection'), 'New Connection');
  }
});

test('messages preserve interpolation slots and substitute user data exactly once', () => {
  for (const key of Object.keys(zhCN) as Message[]) {
    assert.ok(zhCN[key].trim());
    assert.deepEqual(zhCN[key].match(/\{\w+\}/g)?.sort() ?? [], key.match(/\{\w+\}/g)?.sort() ?? [], key);
  }
  assert.equal(translator('zh-CN')('Open table {name}', { name: 'Views {name} $&' }), '打开表 Views {name} $&');
  assert.equal(translator('en')('Query {id}', { id: 2 }), 'Query 2');
  assert.equal(translator('zh-CN')('Query {id}', { id: 2 }), '查询 2');
});

test('invalid JSON and invalid parameter shape produce plugin-owned localizable errors', () => {
  for (const input of ['[', '{}', '[{}]', '[1e400]']) {
    assert.throws(() => parseParameters(input), (error: unknown) => {
      assert.ok(error instanceof ParameterError);
      assert.match(translator('zh-CN')(error.messageKey), /参数/);
      return true;
    });
  }
});
