'use strict';
/* A failed report rebuild must not destroy the editor that still holds the work. These run the
   Schedule's real closePanel/relocateSlotFiles against injected collaborators — no database, no
   browser, no fixtures — so the failure path is characterized rather than inferred. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../protected/Patient_Schedule.html'), 'utf8');
function extract(name) {
  const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match, name + ' should be extractable');
  return match[0];
}

let destroyed, scans, adopted, statuses, moves, finalizeReply, answer, moveRefusal;
const context = {
  panel: null, wsRoot: 'root', curDate: '2026-08-22', preSlot: {},
  finalizePanel(cb) { cb.apply(null, finalizeReply); },
  confirm: () => answer,
  setWsStatus: (msg, cls) => statuses.push(msg + ' [' + (cls || '') + ']'),
  destroyPanel() { destroyed++; context.panel = null; },
  scanSlots() { scans++; },
  adoptWorkingCopy(cb) { adopted++; cb(); },
  WS: { moveSlot(root, date, from, to) {
    moves.push([date, from, to].join('|'));
    return moveRefusal ? Promise.reject(new Error(moveRefusal)) : Promise.resolve(true);
  } }
};
vm.runInNewContext(extract('closePanel') + '\n' + extract('relocateSlotFiles'), context);
const { closePanel, relocateSlotFiles } = context;
function reset(panel, reply, confirmAnswer) {
  destroyed = 0; scans = 0; adopted = 0; statuses = []; moves = []; moveRefusal = null;
  context.panel = panel; context.preSlot = {};
  finalizeReply = reply; answer = confirmAnswer;
}
const openPanel = (slot = 'old', shared = false) => ({ date: '2026-08-22', slot, sharedWorkspace: shared });

// Nothing open: closing is a no-op that still runs its continuation.
reset(null, [true, '']);
let ran = 0;
closePanel(() => ran++);
assert.equal(ran, 1); assert.equal(destroyed, 0);

// A clean finalize behaves exactly as before, including the adopt-then-scan order.
reset(openPanel(), [true, '']);
closePanel(() => ran++);
assert.equal(destroyed, 1); assert.equal(adopted, 1); assert.equal(scans, 1); assert.equal(ran, 2);
assert.deepEqual(statuses, [], 'a successful close says nothing');

// A shared workspace skips the adopt but still closes.
reset(openPanel('old', true), [true, '']);
closePanel();
assert.equal(destroyed, 1); assert.equal(adopted, 0); assert.equal(scans, 1);

// THE FIX: a failed rebuild the user declines to discard leaves everything standing.
reset(openPanel(), [true, 'Report generation timed out'], false);
let refusedWith = null;
closePanel(() => ran++, e => { refusedWith = e; });
assert.equal(destroyed, 0, 'the editor must survive a failed rebuild');
assert.notEqual(context.panel, null);
assert.equal(ran, 2, 'the continuation must not run while the panel is still open');
assert.equal(adopted, 0); assert.equal(scans, 0);
assert.equal(refusedWith, 'Report generation timed out');
assert.match(statuses.join(' '), /still open so you can retry/);
assert.match(statuses.join(' '), /\[warn\]/);

// Confirming the discard closes, and says plainly that the rebuild did not happen.
reset(openPanel(), [true, 'Report generation timed out'], true);
closePanel(() => ran++);
assert.equal(destroyed, 1); assert.equal(ran, 3);
assert.match(statuses.join(' '), /Closed without rebuilding/);

/* ---- relocating a slot's files may never outrun the editor that writes into it ---- */
// moveSlot resolves asynchronously, and the baseline is only advanced once it has, so these await.
const settle = () => new Promise((r) => setTimeout(r, 0));
async function relocations() {
  // No editor open: the move happens straight away.
  reset(null, [true, '']);
  relocateSlotFiles('0', 'old', 'new');
  await settle();
  assert.deepEqual(moves, ['2026-08-22|old|new']); assert.equal(context.preSlot['0'], 'new');

  // An editor on a different slot cannot be holding these files.
  reset(openPanel('other'), [true, '']);
  relocateSlotFiles('0', 'old', 'new');
  await settle();
  assert.deepEqual(moves, ['2026-08-22|old|new']); assert.equal(destroyed, 0);

  // An editor on THIS slot: the move waits for the close, then runs.
  reset(openPanel(), [true, '']);
  relocateSlotFiles('0', 'old', 'new');
  assert.equal(destroyed, 1, 'the close must happen before the move starts');
  await settle();
  assert.deepEqual(moves, ['2026-08-22|old|new']); assert.equal(context.preSlot['0'], 'new');

  // An editor on THIS slot whose close is refused: no move at all, and the baseline still points at
  // the folder the files are really in, so the next edit can retry from there.
  reset(openPanel(), [true, 'Report generation timed out'], false);
  context.preSlot['0'] = 'old';
  relocateSlotFiles('0', 'old', 'new');
  await settle();
  assert.equal(destroyed, 0);
  assert.deepEqual(moves, [], 'files must not move out from under an editor that is still writing');
  assert.equal(context.preSlot['0'], 'old', 'the baseline must keep naming the real folder');
  assert.match(statuses.join(' '), /patient files stay at old/);

  // A move the STORE refuses — an occupied destination — must not advance the baseline either.
  // Pointing it at the empty new folder would orphan the files still sitting in the old one.
  reset(null, [true, '']);
  context.preSlot['0'] = 'old';
  moveRefusal = 'another appointment already has files at new';
  relocateSlotFiles('0', 'old', 'new');
  await settle();
  assert.equal(context.preSlot['0'], 'old', 'a refused move leaves the baseline naming the real folder');
  assert.match(statuses.join(' '), /Could not move files old . new: another appointment/);

  console.log('PASS failed rebuild keeps the editor, and blocks the slot move behind it');
}
relocations().catch((e) => { console.error(e); process.exit(1); });
