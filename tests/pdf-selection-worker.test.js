'use strict';
const assert = require('assert');
const { PDFDocument, degrees, StandardFonts } = require('../vendor/pdf-lib.min');
const { selectPages } = require('../src/pdf-selection-worker');
const pdfjs = require('../vendor/pdf.min');
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('../vendor/pdf.worker.min');
(async function () {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 12; n++) {
    const page = source.addPage([400 + n, 600 + n]);
    page.drawText('SYNTHETIC PAGE ' + n, { x: 20, y: 200, font, size: 14 });
    if (n === 8) page.setRotation(degrees(90));
  }
  const bytes = await source.save(), before = Buffer.from(bytes);
  const result = await selectPages(bytes, [8, 2, 3, 2]);
  assert.deepEqual(Buffer.from(bytes), before, 'selection does not alter the source');
  const selected = await PDFDocument.load(result);
  assert.equal(selected.getPageCount(), 3, 'overlap prints once');
  // The caller's order is the printed order; a repeat keeps its first position, not a sorted one.
  assert.deepEqual(selected.getPages().map(p => p.getWidth()), [408, 402, 403]);
  assert.equal(selected.getPage(0).getRotation().angle, 90);
  const view = await pdfjs.getDocument({ data: result, disableFontFace: true }).promise;
  for (const [index, n] of [8, 2, 3].entries()) {
    const page = await view.getPage(index + 1);
    const text = (await page.getTextContent()).items.map(i => i.str).join('');
    assert.equal(text, 'SYNTHETIC PAGE ' + n, 'original text survives; these are not screenshots');
  }
  await view.destroy();
  await assert.rejects(selectPages(bytes, [13]), /valid PDF pages/);
  await assert.rejects(selectPages(bytes, []), /valid PDF pages/);
  console.log('PASS selected PDF content, order, rotation, page count, source preservation and bounds');
})().catch(e => { console.error(e); process.exit(1); });
