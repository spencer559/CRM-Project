'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---- the toolbar shortcut menu ------------------------------------------------------------
   A DOM small enough to reason about: elements, listeners, focus, and the one <select> behaviour
   that matters here — a value only sticks when a matching option exists. */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.hidden = false; this.disabled = false; this.className = '';
    this._text = ''; this._value = ''; this.parent = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get value() { return this._value; }
  set value(v) {
    if (this.tagName !== 'SELECT') { this._value = String(v); return; }
    this._value = this.children.some(c => c.value === String(v)) ? String(v) : '';
  }
  appendChild(child) {
    this.children.push(child); child.parent = this;
    if (this.tagName === 'SELECT' && this.children.length === 1) this._value = child.value;
    return child;
  }
  replaceChildren(...kids) { this.children = []; this._value = ''; kids.forEach(k => this.appendChild(k)); return undefined; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  focus() { document.activeElement = this; }
  fire(type, ev) {
    const event = Object.assign({ target: this }, ev);
    (this.listeners[type] || []).forEach(fn => fn(event));
    (document.handlers[type] || []).forEach(fn => fn(event));
  }
  labels() { return this.children.map(c => c.textContent); }
}
const document = {
  body: new El('body'),
  activeElement: null,
  handlers: {},
  createElement: tag => new El(tag),
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter(h => h !== fn); }
};
const toolbar = new El('span');
const sandbox = { window: {}, document };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/pdf-egm-navigation.js'), 'utf8'), sandbox);

const assigned = [], removed = [];
let page = 1, restored = null, wentTo = [];
const nav = sandbox.window.CRMEgmNavigation.mount({
  doc: { numPages: 12 },
  toolbar,
  goTo: p => { wentTo.push(p); page = p; },
  position: () => ({ page, zoom: 2, x: 5, y: 6 }),
  restore: pos => { restored = pos; page = pos.page; },
  onAssign: (entryId, p) => assigned.push([entryId, p]),
  onRemove: p => removed.push(p)
});
const [trigger, back] = toolbar.children;
const menu = document.body.children[0];
const [saveRow, list, empty] = menu.children;
const [target, save] = saveRow.children;
const destinations = () => list.children.map(row => row.children[0].textContent);
assert.equal(trigger.hidden, true, 'a PDF opened without a report has nowhere to save pages');
assert.equal(menu.hidden, true);
assert.equal(toolbar.children.length, 2, 'the shortcuts cost one toolbar slot, never a second bar');

nav.setEpisodes([
  { id: 'ep-1', label: '#1 08/22/2026 09:18PM NS-VT', page: null },
  { id: 'ep-2', label: '  ', page: 4 },
  { id: 'ep-3', label: 'past the last page', page: 99 },
  { id: 'nope-1', label: 'not an entry', page: 2 }
]);
assert.equal(trigger.hidden, false);
assert.equal(trigger.textContent, 'EGM · 1', 'the saved count is the only always-visible state');
trigger.fire('click');
assert.equal(menu.hidden, false); assert.equal(document.activeElement, target);
assert.deepEqual(target.labels(), ['Unassigned page', '#1 08/22/2026 09:18PM NS-VT', 'Entry 2 · p. 4', 'past the last page'],
  'the logbook entry names the destination; a page past the end of the PDF is not a page link');
assert.deepEqual(destinations(), ['Entry 2 · p. 4']);
assert.equal(empty.hidden, true);

// Save the current page, unassigned and then to a chosen entry. Saving hands the document back.
assert.equal(save.textContent, 'Save page 1');
save.fire('click');
assert.deepEqual(assigned.at(-1), [null, 1], 'no chosen entry means an unassigned page');
assert.equal(menu.hidden, true);
trigger.fire('click');
target.value = 'ep-1'; target.fire('change');
assert.match(save.title, /Assign PDF page 1 to #1 08\/22\/2026 09:18PM NS-VT/);
save.fire('click');
assert.deepEqual(assigned.at(-1), ['ep-1', 1]);

// The report owns the saved pages; the viewer shows what comes back.
nav.setMarks([7, 4, 0, 40, 'x']);
assert.equal(trigger.textContent, 'EGM · 2');
trigger.fire('click');
assert.deepEqual(destinations(), ['Entry 2 · p. 4', 'Unassigned · p. 7'],
  'an assigned page is named by its episode, not listed twice');

// Jumping remembers where reading was, and Back restores it exactly.
assert.equal(back.hidden, true);
list.children[1].children[0].fire('click');
assert.deepEqual(wentTo.at(-1), 7);
assert.equal(menu.hidden, true, 'choosing a destination gets out of the way');
assert.equal(back.textContent, 'Back to p. 1'); assert.equal(back.hidden, false);
trigger.fire('click');
list.children[1].children[1].fire('click');
assert.deepEqual(removed, [7]);
assert.equal(menu.hidden, false, 'removing one page leaves the menu open for the next');
back.fire('click');
assert.deepEqual(restored, { page: 1, zoom: 2, x: 5, y: 6 }); assert.equal(back.hidden, true);
assert.equal(menu.hidden, true, 'a toolbar click outside the popover dismisses it');

// Escape and an outside click both close it.
trigger.fire('click');
document.handlers.keydown[0]({ key: 'Escape', target: menu, preventDefault() {}, stopImmediatePropagation() {} });
assert.equal(menu.hidden, true); assert.equal(document.activeElement, trigger);
trigger.fire('click');
document.handlers.click[0]({ target: document.body });
assert.equal(menu.hidden, true);

// Background republishing must not rewrite the picker while it is open and focused.
trigger.fire('click');
document.activeElement = target;
nav.setEpisodes([{ id: 'ep-9', label: 'later entry', page: 2 }]);
assert.deepEqual(target.labels(), ['Unassigned page', '#1 08/22/2026 09:18PM NS-VT', 'Entry 2 · p. 4', 'past the last page']);
assert.deepEqual(destinations(), ['later entry · p. 2', 'Unassigned · p. 4', 'Unassigned · p. 7'],
  'the destination list still follows the report, and a page loses its episode name when that entry goes');
document.activeElement = null;
nav.refresh();
assert.deepEqual(target.labels(), ['Unassigned page', 'later entry · p. 2']);
assert.equal(target.value, '', 'a stale entry choice cannot survive the entry disappearing');
nav.setEpisodes([]);
assert.deepEqual(destinations(), ['Unassigned · p. 4', 'Unassigned · p. 7'], 'a page saved without an entry outlives the entries');
nav.setMarks([]);
assert.equal(list.children.length, 0); assert.equal(empty.hidden, false);
assert.equal(trigger.textContent, 'EGM');
nav.dispose();
assert.equal(document.body.children.length, 0); assert.equal(toolbar.children.length, 0);

/* ---- the Schedule bridge, with live and obsolete frames ---------------------------------- */
const schedule = fs.readFileSync(path.join(__dirname, '../protected/Patient_Schedule.html'), 'utf8');
const begin = schedule.indexOf('  window.addEventListener("message", function (ev) {', schedule.indexOf('function notifyEgmAvailability'));
const end = schedule.indexOf('\n  });', begin) + 6;
let handler;
const outgoing = [], toReport = [], reportWindow = { postMessage: m => toReport.push(m) }, pdfWindow = { postMessage: (...args) => outgoing.push(args) };
const panel = { frame: { contentWindow: reportWindow }, tr: { querySelector: () => ({ contentWindow: pdfWindow }) }, viewDocId: 'current', egmReady: false };
let notified = 0;
const context = { window: { addEventListener: (_, cb) => { handler = cb; } }, location: { origin: 'https://local.test' }, panel,
  reportBuild: null, notifyEgmAvailability: () => notified++ };
vm.runInNewContext(schedule.slice(begin, end), context);
function send(source, type, id, origin = 'https://local.test') { handler({ source, origin, data: { type, id } }); }
send(pdfWindow, 'pdfviewer:egm-ready', 'old');
send({}, 'pdfviewer:egm-ready', 'current');
send(pdfWindow, 'pdfviewer:egm-ready', 'current', 'https://other.test');
assert.equal(notified, 0);
send(pdfWindow, 'pdfviewer:egm-ready', 'current');
assert.equal(notified, 1); assert.equal(panel.egmReady, true);
const key = 'sha256:' + 'a'.repeat(64);
function message(source, data) { handler({ source, origin: 'https://local.test', data }); }
message(pdfWindow, { type: 'pdfviewer:egm-ready', id: 'current', documentKey: key });
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'old', documentKey: key, entryId: 'ep-1', page: 3 });
message({}, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: key, entryId: 'ep-1', page: 3 });
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: 'wrong', entryId: 'ep-1', page: 3 });
assert.equal(toReport.length, 0, 'stale or unrelated viewers cannot change episode links');
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: key, entryId: 'ep-1', page: 3 });
assert.equal(toReport[0].type, 'crm:egm-assign'); assert.equal(toReport[0].page, 3);
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: key, entryId: null, page: 5 });
assert.equal(toReport[1].entryId, null, 'an unassigned save reaches the report as its own kind of assignment');
message(pdfWindow, { type: 'pdfviewer:egm-remove', id: 'current', documentKey: key, page: 3 });
assert.equal(toReport[2].type, 'crm:egm-remove');
message(reportWindow, { type: 'crm:egm-entries', id: 'old', documentKey: key, entries: [] });
assert.equal(outgoing.length, 0);
message(reportWindow, { type: 'crm:egm-entries', id: 'current', documentKey: key, entries: [{ id: 'ep-1', label: 'x', page: 3 }], marks: [5] });
assert.equal(outgoing[0][0].type, 'pdfviewer:egm-entries'); assert.deepEqual(outgoing[0][0].marks, [5]);
message(reportWindow, { type: 'crm:egm-entries', id: 'current', documentKey: key, entries: [] });
assert.deepEqual(outgoing[1][0].marks, [], 'a report with no marks field must not resurrect the last one');
let warning = '', loaded = '';
context.setWsStatus = text => warning = text;
context.panelViewFile = name => { loaded = name; panel.egmReady = false; panel.pendingEgmLink = null; panel.viewFileName = name; };
const selector = { value: '', options: [{ value: 'source.pdf' }, { value: 'other.pdf' }] };
panel.tr.querySelector = sel => sel === '[data-panel-view]' ? selector : sel === '.crm-panel' ? { classList: { contains: () => true } } : { contentWindow: pdfWindow };
panel.viewFileName = 'source.pdf';
message(reportWindow, { type: 'crm:egm-open-link', link: { documentKey: key, file: 'source.pdf', page: 3 } });
assert.equal(outgoing[2][0].type, 'pdfviewer:egm-jump');
message(reportWindow, { type: 'crm:egm-open-link', link: { documentKey: 'sha256:' + 'b'.repeat(64), file: 'source.pdf', page: 3 } });
assert.match(warning, /changed/); assert.equal(outgoing.length, 3);
message(reportWindow, { type: 'crm:egm-open-link', link: { documentKey: key, file: 'missing.pdf', page: 3 } });
assert.match(warning, /no longer/);
message(reportWindow, { type: 'crm:egm-open-link', link: { documentKey: key, file: 'other.pdf', page: 5 } });
assert.equal(loaded, 'other.pdf'); assert.equal(panel.pendingEgmLink.page, 5);
message(pdfWindow, { type: 'pdfviewer:egm-ready', id: 'current', documentKey: key });
assert.equal(outgoing[3][0].page, 5); assert.equal(panel.pendingEgmLink, null);
console.log('PASS EGM shortcut menu and active-document bridge');
