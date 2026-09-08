/* The whole reorder-to-print round trip, across both modules and the Schedule bridge shape.
 *
 * The unit tests cover each half; this one exists because the ordering bug lived in the seam.
 * A shortcut's position is chosen in the viewer, persisted by the report, and published back —
 * so a regression anywhere in that loop prints the pages in physical order and nothing else
 * notices. The workflow below is the real one: three named ranges, one dragged to the front.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const KEY = 'sha256:' + 'a'.repeat(64);

/* ---- report side ---- */
let onReportMessage;
const published = [];
const host = { postMessage: function (m) { published.push(m); if (m.type === 'crm:egm-entries') { nav.setMarks(m.marks); nav.setEpisodes(m.entries); } } };
const epRow = { id: 'ep-1', querySelectorAll: () => [] };
epRow.input = { value: '', closest: () => epRow, dispatchEvent() {} };
epRow.button = { closest: () => epRow, removeAttribute() {}, setAttribute() {} };
epRow.querySelector = sel => sel === '[name="ep1-dt"]' ? { value: '' } : epRow.input;
const marksField = { value: '', dispatchEvent() {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/crm-episode-links'), 'utf8'), {
  window: { CRMPageSelection: require('../src/pdf-page-selection'), CRM_EMBED: true, parent: host,
    isLoopMode: () => false, addEventListener: (_, h) => onReportMessage = h },
  document: {
    querySelectorAll(sel) {
      if (sel === '#ep-tbody tr') return [epRow];
      if (sel === '#lep-tbody tr') return [];
      if (sel === '[data-episode-link]') return [epRow.button];
      if (sel === '[data-egm-link-value]') return [epRow.input];
      throw new Error(sel);
    },
    addEventListener() {},
    getElementById: id => id === 'egm-marks' ? marksField : {}
  },
  location: { origin: 'https://local.test' }, Event: class {}, MutationObserver: class { observe() {} }
});

/* ---- viewer side ---- */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.hidden = false; this.disabled = false; this.className = '';
    this.classList = { add() {}, remove() {} }; this._text = ''; this._value = ''; this.parent = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get value() { return this._value; }
  set value(v) {
    if (this.tagName !== 'SELECT') { this._value = String(v); return; }
    this._value = this.children.some(c => c.value === String(v)) ? String(v) : '';
  }
  appendChild(c) { this.children.push(c); c.parent = this; if (this.tagName === 'SELECT' && this.children.length === 1) this._value = c.value; return c; }
  replaceChildren(...k) { this.children = []; this._value = ''; k.forEach(x => this.appendChild(x)); }
  querySelectorAll() { return []; }
  contains() { return true; }
  closest() { return this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  getAttribute(n) { return this.attrs[n]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  focus() { viewerDoc.activeElement = this; }
  setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false; }
  getBoundingClientRect() { return { top: 0, bottom: 1000, left: 0, right: 400 }; }
  fire(t, ev) {
    const e = Object.assign({ target: this }, ev);
    (this.listeners[t] || []).forEach(f => f(e));
    (viewerDoc.handlers[t] || []).forEach(f => f(e));
  }
}
const viewerDoc = {
  body: new El('body'), activeElement: null, handlers: {},
  createElement: t => new El(t),
  addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
  removeEventListener(t, f) { this.handlers[t] = (this.handlers[t] || []).filter(h => h !== f); },
  elementFromPoint: () => null
};
const toolbar = new El('span');
const box = { window: { CRMPageSelection: require('../src/pdf-page-selection') }, document: viewerDoc };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/pdf-egm-navigation.js'), 'utf8'), box);

// Patient_Schedule relays viewer messages to the report by swapping the prefix and keeping the payload.
function relay(type, extra) {
  onReportMessage({ source: host, origin: 'https://local.test',
    data: Object.assign({ type: 'crm:' + type, id: 'viewer-1', documentKey: KEY }, extra) });
}
const printed = [];
const nav = box.window.CRMEgmNavigation.mount({
  doc: { numPages: 40 }, toolbar, goTo() {}, position: () => ({ page: 1, zoom: 1, x: 0, y: 0 }), restore() {},
  onAssign: (entryId, page, selection) => relay('egm-assign', Object.assign({ entryId: entryId, page: page }, selection)),
  onRemove: (page, savedId) => relay('egm-remove', { page: page, savedId: savedId }),
  onReorder: ids => relay('egm-reorder', { ids: ids }),
  onPrint: pages => { printed.push(pages); return Promise.resolve(); }
});
relay('egm-available', { available: true, file: 'source.pdf', numPages: 40 });

const menu = viewerDoc.body.children[0];
const [saveRow, nameWrap, rangeRow, , list, , printRow] = menu.children;
const [target, save] = saveRow.children;
const nameInput = nameWrap.children[1], range = rangeRow.children[0].children[1];
const labels = () => list.children.map(r => r.children[2].textContent);
function addShortcut(label, pages) { target.value = ''; nameInput.value = label; range.value = pages; save.fire('click'); }

addShortcut('Parameters', '1-5');
addShortcut('Histograms', '9');
addShortcut('Final report', '26-32');
assert.deepEqual(labels(), ['Parameters · p. 1–5', 'Histograms · p. 9', 'Final report · p. 26–32'],
  'new shortcuts start in page order');

// Drag the last shortcut onto the first row, the way a technician puts the report up front.
const handle = list.children[2].children[0];
handle.fire('pointerdown', { button: 0, clientY: 100, pointerId: 1, preventDefault() {} });
viewerDoc.elementFromPoint = () => ({ closest: () => list.children[0] });
handle.fire('pointermove', { clientY: 0, clientX: 0, pointerId: 1 });
handle.fire('pointerup', { clientY: 0, clientX: 0, pointerId: 1, type: 'pointerup' });

assert.deepEqual(labels(), ['Final report · p. 26–32', 'Parameters · p. 1–5', 'Histograms · p. 9'],
  'the dragged shortcut leads the list');
assert.deepEqual(JSON.parse(marksField.value).map(m => [m.label, m.order]),
  [['Parameters', 1], ['Histograms', 2], ['Final report', 0]],
  'the report stores the new position, so it survives a reload');
assert.equal(printRow.children[0].title, '26–32, 1–5, 9', 'the summary previews the print order');

printRow.children[1].fire('click');
Promise.resolve().then(() => {
  assert.deepEqual(printed[0], [26, 27, 28, 29, 30, 31, 32, 1, 2, 3, 4, 5, 9],
    'print follows the arranged order, not the page numbers');
  console.log('PASS EGM reorder survives the report round trip and drives the printed page order');
});
