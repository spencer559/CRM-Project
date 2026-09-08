'use strict';
const assert = require('assert');
const P = require('../src/pdf-page-selection');
assert.deepEqual(P.parse('1-3, 3, 8, 10–12', 12), [1, 2, 3, 8, 10, 11, 12]);
assert.equal(P.format([1, 2, 3, 8, 10, 11, 12]), '1–3, 8, 10–12');
for (const bad of ['', '0', '-1', '3-1', '1.5', '13', '1,', '1--3', '1-999999999', '2x']) {
  assert.equal(P.parse(bad, 12), null, bad);
}
assert.deepEqual(P.sequence([8, 2, 3, 2], 12), [8, 2, 3], 'sequence keeps the caller order and first position');
assert.equal(P.sequence([8, 13], 12), null, 'sequence enforces the same bounds as normalize');
assert.equal(P.sequence([], 12), null, 'sequence rejects an empty selection');
assert.deepEqual(P.normalize([8, 2, 3, 2], 12), [2, 3, 8], 'normalize still sorts for stored ranges');
assert.equal(P.format([8, 2, 3]), '8, 2–3', 'the summary reads in print order');
assert.deepEqual(P.pagesOf({ page: 4 }, 12), [4], 'legacy single pages stay usable');
assert.equal(P.pagesOf({ pages: [3, 13], page: 3 }, 12), null, 'never silently print a partial invalid range');
console.log('PASS page ranges, normalization, physical bounds, and legacy selections');
