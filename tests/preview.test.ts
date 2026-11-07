import test from 'node:test';
import assert from 'node:assert/strict';
import { previewSummary } from '../src/preview';
test('preview reports actual displayed bounds and clipped cells separately from host truncation', () => {
  assert.deepEqual(previewSummary({ columns: ['a','b'], rows: [[null, '']], truncated: false }), { shownRows: 1, totalRows: 1, shownColumns: 2, totalColumns: 2, clippedCells: 0, hostTruncated: false });
  assert.deepEqual(previewSummary({ columns: Array(9).fill('a'), rows: Array.from({length:100},()=>Array(9).fill('x'.repeat(300))), truncated:true }), { shownRows:20,totalRows:100,shownColumns:8,totalColumns:9,clippedCells:160,hostTruncated:true });
});
