/* Loaded only for Print selected. No database access; terminated after each job. */
(function () {
  'use strict';
  var lib;
  if (typeof module !== 'undefined' && module.exports) lib = require('../vendor/pdf-lib.min.js');
  else { importScripts('../vendor/pdf-lib.min.js'); lib = self.PDFLib; }
  async function selectPages(bytes, pages) {
    var source = await lib.PDFDocument.load(bytes);
    if (!Array.isArray(pages) || !pages.length || pages.some(function (p) {
      return !Number.isInteger(p) || p < 1 || p > source.getPageCount();
    })) throw new Error('Select valid PDF pages.');
    // Keep the caller's order; a Set drops repeats while holding each page's first position.
    var selected = Array.from(new Set(pages));
    var output = await lib.PDFDocument.create();
    // Copy original page objects, including their vector content, dimensions and rotation.
    var copies = await output.copyPages(source, selected.map(function (p) { return p - 1; }));
    copies.forEach(function (page) { output.addPage(page); });
    return output.save();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { selectPages: selectPages };
  else self.onmessage = function (event) {
    selectPages(event.data.bytes, event.data.pages).then(function (bytes) {
      self.postMessage({ bytes: bytes }, [bytes.buffer]);
    }).catch(function (e) { self.postMessage({ error: e.message || 'Could not prepare selected pages.' }); });
  };
})();
