'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { readLink } = require('../src/crm-episode-links');
const key = 'sha256:' + 'a'.repeat(64);
const good = { documentKey: key, file: 'source.pdf', page: 3 };
assert.deepStrictEqual(readLink(JSON.stringify(good)), good);
for (const patch of [{ documentKey: 'old-id' }, { file: '../source.pdf' }, { file: 'C:\\source.pdf' }, { file: '' }, { page: 0 }, { page: 1.5 }, { page: '3' }]) {
  assert.equal(readLink(JSON.stringify({ ...good, ...patch })), null);
}
assert.equal(readLink('not JSON'), null);

// Exercise the report-side bridge: active table, stale messages, dirty events, and unlinking.
let onMessage, onClick, loop = false, dirty = 0;
const sent = [], parent = { postMessage: message => sent.push(message) };
const row = id => {
  const r = { id };
  r.input = { value: '', closest: () => r, dispatchEvent: () => dirty++ };
  r.button = { closest: () => r, setAttribute() {} };
  r.querySelector = () => r.input;
  return r;
};
const ep = row('ep-1'), lep = row('lep-1');
const menuButton = { addEventListener() {} };
const document = {
  querySelectorAll(selector) {
    if (selector === '#ep-tbody tr') return [ep];
    if (selector === '#lep-tbody tr') return [lep];
    if (selector === '[data-episode-link]') return [ep.button, lep.button];
    if (selector === '[data-egm-link-value]') return [ep.input, lep.input];
    if (selector === '[data-view-egms]') return [menuButton];
    throw new Error(selector);
  },
  addEventListener(type, handler) { if (type === 'click') onClick = handler; },
  getElementById: () => ({})
};
const window = { CRM_EMBED: true, parent, isLoopMode: () => loop, addEventListener: (_, handler) => onMessage = handler };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/crm-episode-links'), 'utf8'), {
  window, document, location: { origin: 'https://local.test' }, Event: class {}, MutationObserver: class { observe() {} }
});
function send(data, source = parent, origin = 'https://local.test') { onMessage({ data, source, origin }); }
const context = { type: 'crm:egm-available', available: true, id: 'viewer-1', documentKey: key, file: 'source.pdf' };
const assign = { type: 'crm:egm-assign', id: context.id, documentKey: key, entryId: ep.id, page: 3 };
send(context);
send(assign, {}); send(assign, parent, 'https://other.test'); send({ ...assign, id: 'old' });
assert.equal(dirty, 0);
send(assign);
assert.equal(dirty, 1); assert.deepStrictEqual(readLink(ep.input.value), good);
assert.equal(ep.button.textContent, 'p. 3'); assert.equal(ep.button.hidden, false);
assert.equal(sent.at(-1).entries[0].page, 3);
onClick({ target: { closest: () => ep.button } });
assert.equal(sent.at(-1).type, 'crm:egm-open-link');
loop = true; send(context); send(assign);
assert.equal(dirty, 1, 'a hidden table cannot accept an assignment');
send({ ...assign, entryId: lep.id });
assert.equal(dirty, 2); assert.equal(lep.button.textContent, 'p. 3');
send({ ...context, documentKey: 'sha256:' + 'b'.repeat(64) });
assert.equal(sent.at(-1).entries[0].page, null, 'a different source cannot inherit page links');
send(context);
send({ type: 'crm:egm-remove', id: context.id, documentKey: key, page: 3 });
assert.equal(ep.input.value, ''); assert.equal(lep.input.value, '');
assert.equal(dirty, 4); assert.equal(ep.button.hidden, true); assert.equal(lep.button.hidden, true);
console.log('PASS episode link validation, assignment, source identity and removal');
