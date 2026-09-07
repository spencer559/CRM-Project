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
const outgoing = [], reportWindow = {}, pdfWindow = { postMessage: (...args) => outgoing.push(args) };
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
console.log('PASS EGM classification and active-document bridge');
