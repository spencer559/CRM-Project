'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { readLink, formatWhen, entryLabel } = require('../src/crm-episode-links');
const key = 'sha256:' + 'a'.repeat(64);
const good = { documentKey: key, file: 'source.pdf', page: 3 };
assert.deepStrictEqual(readLink(JSON.stringify(good)), good);
for (const patch of [{ documentKey: 'old-id' }, { file: '../source.pdf' }, { file: 'C:\\source.pdf' }, { file: '' }, { page: 0 }, { page: 1.5 }, { page: '3' }]) {
  assert.equal(readLink(JSON.stringify({ ...good, ...patch })), null);
}
assert.equal(readLink('not JSON'), null);

// The label the viewer shows is the entry as the technician wrote it — no time zone applied.
assert.equal(formatWhen('2026-08-22T21:18'), '08/22/2026 09:18PM');
assert.equal(formatWhen('2026-01-05T00:07'), '01/05/2026 12:07AM');
assert.equal(formatWhen('2026-01-05T12:00'), '01/05/2026 12:00PM');
for (const bad of ['', null, 'yesterday', '2026-08-22']) assert.equal(formatWhen(bad), '');
assert.equal(entryLabel({ id: 'lep-4', querySelector: () => null, querySelectorAll: () => [] }), '#4',
  'an untouched row is still named by its number');

// Exercise the report-side bridge: active table, stale messages, dirty events, and unlinking.
let onMessage, onClick, loop = false, dirty = 0;
const sent = [], parent = { postMessage: message => sent.push(message) };
const row = (id, when, types) => {
  const r = { id };
  const prefix = id.replace('-', '');
  r.input = { value: '', closest: () => r, dispatchEvent: () => dirty++ };
  r.button = { closest: () => r, removeAttribute() { delete r.button.linked; },
    setAttribute(name) { if (name === 'data-linked') r.button.linked = true; } };
  r.querySelector = sel => sel === `[name="${prefix}-dt"]` ? { value: when || '' } : r.input;
  r.querySelectorAll = sel => sel === `[name="${prefix}-type"]` ? (types || []).map(v => ({ value: v, checked: true })) : [];
  return r;
};
const ep = row('ep-1', '2026-08-22T21:18', ['NS-VT']), lep = row('lep-1');
const marks = { value: '', dispatchEvent: () => dirty++ };
const document = {
  querySelectorAll(selector) {
    if (selector === '#ep-tbody tr') return [ep];
    if (selector === '#lep-tbody tr') return [lep];
    if (selector === '[data-episode-link]') return [ep.button, lep.button];
    if (selector === '[data-egm-link-value]') return [ep.input, lep.input];
    throw new Error(selector);
  },
  addEventListener(type, handler) { if (type === 'click') onClick = handler; },
  getElementById: id => id === 'egm-marks' ? marks : ({})
};
const window = { CRMPageSelection: require('../src/pdf-page-selection'), CRM_EMBED: true, parent, isLoopMode: () => loop, addEventListener: (_, handler) => onMessage = handler };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/crm-episode-links'), 'utf8'), {
  window, document, location: { origin: 'https://local.test' }, Event: class {}, MutationObserver: class { observe() {} }
});
function send(data, source = parent, origin = 'https://local.test') { onMessage({ data, source, origin }); }
const context = { type: 'crm:egm-available', available: true, id: 'viewer-1', documentKey: key, file: 'source.pdf' };
const assign = { type: 'crm:egm-assign', id: context.id, documentKey: key, entryId: ep.id, page: 3 };
send(context);
assert.equal(sent.at(-1).entries[0].label, '#1 08/22/2026 09:18PM NS-VT', 'the viewer names entries the way the logbook does, "#" column first');
assert.equal(lep.button.textContent, '1', 'the row number is the control, so it shows with or without a link');
send(assign, {}); send(assign, parent, 'https://other.test'); send({ ...assign, id: 'old' });
assert.equal(dirty, 0);
send(assign);
assert.equal(dirty, 1); assert.deepStrictEqual(readLink(ep.input.value), good);
assert.equal(ep.button.textContent, '1'); assert.equal(ep.button.linked, true); assert.equal(ep.button.disabled, false);
assert.equal(sent.at(-1).entries[0].page, 3);
onClick({ target: { closest: () => ep.button } });
assert.equal(sent.at(-1).type, 'crm:egm-open-link');

// A page saved without an entry persists in the report and is scoped to its source document.
send({ ...assign, entryId: null, page: 6 });
assert.equal(dirty, 2); assert.deepEqual(sent.at(-1).marks.map(m => m.page), [6]);
send({ ...assign, entryId: null, page: 6 });
assert.equal(dirty, 2, 'the same page cannot be saved twice');
send({ ...assign, entryId: null, page: 3 });
send({ ...assign, page: 6 });
assert.equal(readLink(ep.input.value).page, 6);
assert.deepEqual(sent.at(-1).marks.map(m => m.page), [3], 'assigning a page drops its anonymous copy, not the others');

loop = true; send(context); send({ ...assign, page: 3 });
assert.equal(readLink(ep.input.value).page, 6, 'a hidden table cannot accept an assignment');
send({ ...assign, entryId: lep.id, page: 3 });
assert.equal(readLink(lep.input.value).page, 3); assert.equal(lep.button.linked, true);
send({ ...context, documentKey: 'sha256:' + 'b'.repeat(64) });
assert.equal(sent.at(-1).entries[0].page, null, 'a different source cannot inherit page links');
assert.deepEqual(sent.at(-1).marks, []);
send(context);
send({ type: 'crm:egm-assign', id: context.id, documentKey: key, entryId: null, page: 6 });
send({ type: 'crm:egm-remove', id: context.id, documentKey: key, page: 6 });
assert.equal(ep.input.value, ''); assert.equal(marks.value, '');
assert.equal(ep.button.linked, undefined); assert.equal(ep.button.disabled, true);
assert.equal(readLink(lep.input.value).page, 3, 'removing one page leaves the others linked');

// Ranges, labels and per-source order survive report JSON, without touching clinical output.
loop=false; send(context);
send({...assign,pages:[3,4,5,8],label:'Episode strip'});
assert.deepEqual(readLink(ep.input.value).pages,[3,4,5,8]);
send({...assign,entryId:null,pages:[1,2],page:1,label:'Quick look'});
const named=sent.at(-1).marks.find(m=>m.label==='Quick look');
assert.ok(named.id.startsWith('mark-'));
send({type:'crm:egm-reorder',id:context.id,documentKey:key,ids:[named.id,'ep-1']});
assert.equal(readLink(ep.input.value).order,1);
assert.equal(JSON.parse(marks.value).find(m=>m.id===named.id).order,0);
send({...assign,entryId:null,savedId:named.id,pages:[1,2,3],page:1,label:'Summary'});
assert.deepEqual(sent.at(-1).marks.find(m=>m.id===named.id).pages,[1,2,3]);
assert.equal(sent.at(-1).marks.find(m=>m.id===named.id).order,0);
const storedMarks=marks.value;
marks.value=JSON.stringify(JSON.parse(storedMarks)); send(context);
assert.equal(sent.at(-1).marks.find(m=>m.id===named.id).label,'Summary');
// A named range overlapping an episode remains independent.
send({...assign,pages:[1,2,3],page:1});
assert.ok(sent.at(-1).marks.some(m=>m.id===named.id));
send({type:'crm:egm-remove',id:context.id,documentKey:key,savedId:named.id,page:1});
assert.equal(readLink(ep.input.value).page,1);
assert.ok(!sent.at(-1).marks.some(m=>m.id===named.id));
// The source page count guards the message bridge too.
send({...context,numPages:12}); const before=ep.input.value;
send({...assign,pages:[12,13]}); assert.equal(ep.input.value,before);
send({...assign,pages:[0,2]}); assert.equal(ep.input.value,before);
send({...assign,entryId:null,savedId:named.id,pages:[1],page:1,label:'stale'});
assert.ok(!sent.at(-1).marks.some(m=>m.label==='stale'));
console.log('PASS episode labels, multi-page links, named shortcuts, order, identity and removal');
