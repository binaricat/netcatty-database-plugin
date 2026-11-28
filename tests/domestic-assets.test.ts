import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectPluginBrandIcon } from '@netcatty/plugin-contract';

test('official openGauss brand asset retains verified source and explicit local usage boundary', () => {
  const entries: { id: string; sourceFile: string; sourceSha256: string; sourceUrl: string; usageStatus: string; distributionBasis: string; outputs: { file: string; sha256: string }[] }[] = JSON.parse(readFileSync('assets/domestic-icon-ledger.json', 'utf8'));
  assert.deepEqual(entries.map(e => e.id).sort(), ['opengauss']);
  const hash = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
  for (const entry of entries) {
    assert.equal(hash(entry.sourceFile), entry.sourceSha256);
    assert.match(entry.sourceUrl, /^https:\/\//);
    assert.match(entry.usageStatus, /LOCAL_NONCOMMERCIAL/);
    assert.match(entry.distributionBasis, /NOT_CLEARED_FOR_GENERAL_DISTRIBUTION/);
    assert.equal(entry.outputs.length, 2);
    for (const output of entry.outputs) {
      assert.equal(hash(output.file), output.sha256);
      assert.deepEqual(inspectPluginBrandIcon(readFileSync(output.file), output.file), { mimeType: 'image/png', width: 128, height: 128 });
    }
  }
});
