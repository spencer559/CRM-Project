'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const nav = require('../src/pdf-egm-navigation.js');
for (const heading of ['Stored EGM', 'IEGM', 'Episode Details: 42', 'Electrograms', 'Episode Recording', 'EGM strips']) {
  assert.equal(nav.classifyHeading(heading), 'recording', heading);
}
for (const heading of ['Arrhythmia Episode List', 'Episode Summary', 'Episode Logbook']) assert.equal(nav.classifyHeading(heading), 'summary');
for (const text of ['EGM available', 'EGM storage is enabled', 'No EGMs available', 'Review the EGM recordings', 'EGM recordings .... 12', 'Contents', 'Episode count: 8']) {
  assert.equal(nav.classifyHeading(text), null, text);
}
const item = (str, x, y, width = str.length * 6) => ({ str, transform: [1, 0, 0, 1, x, y], width });
const fragmented = Array.from('Stored EGM', (c, i) => item(c, i * 6, 100));
assert.equal(nav.classifyPage(fragmented)[0].kind, 'recording', 'per-character PDF text should reassemble');
assert.equal(nav.classifyPage([item('Episode', 0, 100), item('Details', 55, 100)])[0].kind, 'recording');
assert.deepEqual(nav.classifyPage([item('Contents', 0, 200), ...fragmented]), [], 'a contents page is not an EGM destination');
assert.deepEqual(nav.classifyPage([]), [], 'an image-only page is not evidence of absence or a recording');

// Exercise the actual Schedule bridge with live/obsolete frames and document IDs.
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
send({}, 'crm:view-egms'); assert.equal(outgoing.length, 0);
send(reportWindow, 'crm:view-egms');
assert.equal(outgoing.length, 1); assert.equal(outgoing[0][0].id, 'current');
panel.egmReady = false; send(reportWindow, 'crm:view-egms'); assert.equal(outgoing.length, 1);
const key = 'sha256:' + 'a'.repeat(64);
function message(source, data) { handler({ source, origin: 'https://local.test', data }); }
message(pdfWindow, { type: 'pdfviewer:egm-ready', id: 'current', documentKey: key });
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'old', documentKey: key, entryId: 'ep-1', page: 3 });
message({}, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: key, entryId: 'ep-1', page: 3 });
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: 'wrong', entryId: 'ep-1', page: 3 });
assert.equal(toReport.length, 0, 'stale or unrelated viewers cannot change episode links');
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: key, entryId: 'ep-1', page: 3 });
assert.equal(toReport[0].type, 'crm:egm-assign'); assert.equal(toReport[0].page, 3);
message(pdfWindow, { type: 'pdfviewer:egm-remove', id: 'current', documentKey: key, page: 3 });
assert.equal(toReport[1].type, 'crm:egm-remove');
message(reportWindow, { type: 'crm:egm-entries', id: 'old', documentKey: key, entries: [] });
assert.equal(outgoing.length, 1);
message(reportWindow, { type: 'crm:egm-entries', id: 'current', documentKey: key, entries: [{ id: 'ep-1', page: 3 }] });
assert.equal(outgoing[1][0].type, 'pdfviewer:egm-entries');
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
console.log('PASS EGM classification and active-document bridge');
