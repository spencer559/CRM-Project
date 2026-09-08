"use strict";
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../protected/Patient_Schedule.html'), 'utf8');
function extract(name) {
  const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match, name);
  return match[0];
}
async function run() {
  // A timeout warns but does not navigate. Only a successful browser commit allows handoff.
  for (const mode of ['success', 'failure']) {
    let finish, fail, timeout;
    const flush = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const location = { href: '' }, warnings = [];
    const navigate = new Function('flushPending', 'setTimeout', 'clearTimeout', 'location', 'setStatus',
      extract('navigateToReportGenerator') + '; return navigateToReportGenerator;')(
      () => flush, fn => { timeout = fn; return 1; }, () => {}, location, msg => warnings.push(msg));
    navigate('CRM_Report_Generator.html');
    timeout();
    assert.strictEqual(location.href, '', 'timeout navigated before saving');
    assert.ok(warnings[0].includes('Still saving'));
    if (mode === 'success') finish(); else fail(new Error('quota exceeded'));
    await flush.catch(() => {});
    await Promise.resolve();
    assert.strictEqual(location.href, mode === 'success' ? 'CRM_Report_Generator.html' : '');
    if (mode === 'failure') assert.ok(warnings.some(msg => msg.includes('Could not open report')));
  }
  // Warnings are outside the menu and disappear after a successful save.
  const elements = { fileStatus: {}, storageDot: { style: {} }, saveWarning: { hidden: true } };
  const status = new Function('$', extract('setStatus') + '; return setStatus;')(id => elements[id]);
  status('File save failed', 'warn');
  assert.strictEqual(elements.saveWarning.hidden, false);
  assert.strictEqual(elements.saveWarning.textContent, 'File save failed');
  status('Saved to schedule.crmdb', 'ok');
  assert.strictEqual(elements.saveWarning.hidden, true);
  /* The Database dot answers "is this connected and healthy?", not "where does the work live?".
     The Schedule stages edits and publishes on a 30s cadence, so `edited`/`saving` are the normal
     state for most of any minute — colouring them like a problem made a perfectly connected
     database look dropped for half a minute after every keystroke. */
  const dotMap = source.slice(source.indexOf('var SAVE_STATE_DOT'), source.indexOf('function renderSaveState'));
  for (const healthy of ['edited', 'saving', 'file']) {
    assert.ok(new RegExp(healthy + ': "var\\(--green\\)"').test(dotMap),
      healthy + ' is ordinary healthy operation and must not read as a warning');
  }
  assert.match(dotMap, /browser: "var\(--amber\)"/, 'work the portable file lacks is worth amber');
  assert.match(dotMap, /failed: "var\(--red\)"/);
  assert.match(dotMap, /blocked: "var\(--red\)"/);
  assert.ok(!/closed:/.test(dotMap), 'no database open falls through to the muted default');

  console.log('PASS schedule-save-failure');
}
run().catch(e => { console.error(e); process.exit(1); });
