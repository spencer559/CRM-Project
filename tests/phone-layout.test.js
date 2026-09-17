/* The iPhone app: the same build as the iPad app, and one phone layout (max-width: 640px) in each
 * of the three offline pages.
 *
 * Pinned here, because none of it fails loudly when it breaks:
 *   • the Xcode project stays universal. An iPad-only build still compiles, and then simply
 *     refuses to install on the iPhone.
 *   • the Schedule's card captions (data-label) match the table headers they stand in for.
 *   • the Schedule's app shell is sized to the page, not to 100vh. In the app's web view 100vh
 *     includes the safe areas, which hid the bottom 96pt of the schedule on an iPhone 16 Pro.
 *   • the split's divider drags down the panel when the panes are stacked, and across otherwise.
 *   • the Report Generator's taller phone app bar and everything laid out under it agree.
 *
 * Run with:  node tests/phone-layout.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const repo = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
const schedule = read("site/protected/Patient_Schedule.html");
const report = read("site/protected/CRM_Report_Generator.html");
const viewer = read("site/protected/PDF_Viewer.html");
const project = read("iPad_APP/CRMiPad.xcodeproj/project.pbxproj");

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, name + " must exist");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail("Could not find the end of " + name);
}

// The body of the first `@media (max-width: 640px)` block after `from`, braces matched.
function phoneBlock(source, from) {
  const start = source.indexOf("@media (max-width: 640px)", from || 0);
  assert.notStrictEqual(start, -1, "phone media block must exist");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail("unterminated phone media block");
}

/* ---- the build ---- */

const families = project.match(/TARGETED_DEVICE_FAMILY = [^;]+;/g) || [];
assert.strictEqual(families.length, 2, "both target configurations set the device family");
families.forEach((f) => assert.strictEqual(f, 'TARGETED_DEVICE_FAMILY = "1,2";',
  "the app is universal (1 = iPhone, 2 = iPad), so one .ipa installs on either"));
const phoneOrientations = project.match(/INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = [^;]+;/g) || [];
assert.strictEqual(phoneOrientations.length, 2, "both configurations declare the iPhone orientations");
phoneOrientations.forEach((o) => assert.match(o, /= UIInterfaceOrientationPortrait;$/,
  "the phone layout is designed and verified in portrait only"));
assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.spencer\.crmdb\.ipad;/,
  "the bundle ID stays put: changing it strands the iPad's data and costs a free account an App ID");

/* ---- one breakpoint, everywhere ---- */

[["Patient_Schedule.html", schedule], ["CRM_Report_Generator.html", report], ["PDF_Viewer.html", viewer]]
  .forEach(([name, html]) => assert.ok(html.includes("@media (max-width: 640px)"), name + " has the phone layout"));
assert.match(viewer, /matchMedia\("\(max-width: 640px\)"\)/,
  "the viewer's script asks about the same breakpoint its stylesheet uses");

/* ---- Schedule: cards ---- */

const headers = [...schedule.slice(schedule.indexOf("<thead>"), schedule.indexOf("</thead>"))
  .matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
const render = functionSource(schedule, "render");
const rowMarkup = render.slice(render.indexOf('tr.className = "appt-row"'), render.indexOf('place(tr)'));
const cells = [...rowMarkup.matchAll(/'<td([^>]*)>/g)].map((m) => m[1]);
assert.strictEqual(cells.length, headers.length, "one cell per header column");
cells.forEach((attrs, i) => {
  const label = /data-label="([^"]*)"/.exec(attrs);
  if (!headers[i]) {
    assert.ok(!label, "column " + (i + 1) + " has no header, so its card cell has no caption");
    return;
  }
  if (/^(CRM|Files)$/.test(headers[i])) {
    assert.ok(!label, headers[i] + " is a labelled button already and needs no caption");
    return;
  }
  assert.ok(label, "the " + headers[i] + " cell carries a caption for the phone card");
  assert.strictEqual(label[1].toLowerCase(), headers[i].toLowerCase(),
    "column " + (i + 1) + "'s caption matches its header");
});

const sched = phoneBlock(schedule);
assert.match(sched, /\.twrap thead \{ display:none; \}/, "cards replace the header row");
assert.match(sched, /td\[data-label\]::before \{ content:attr\(data-label\)/, "each card field shows its caption");
assert.match(sched, /\.hdr-dropdown, \.provider-menu, \.move-menu \{\s*position:fixed; top:auto; left:8px; right:8px;/,
  "menus span the screen instead of opening off its edge");
assert.match(sched, /\.crm-panel, \.crm-panel\.split-open \{ position:fixed; inset:0;/, "the report panel covers the screen");
assert.match(sched, /\.main-scroll \{[^}]*-webkit-overflow-scrolling:auto;/,
  "iOS clips a fixed panel to a touch-scrolling ancestor, which hid the panel's Close button");
assert.match(sched, /\.crm-panel\.split-open \.crm-panel-body \{[^}]*flex-direction:column;/,
  "split view stacks the file under the form");
assert.match(sched, /\.twrap td\.time input \{ -webkit-appearance:none; appearance:none; \}/,
  "iOS ignores width on a natively drawn time field");

const bodyRule = /\n  body \{[^}]*\}/.exec(schedule)[0];
assert.match(bodyRule, /height:100%;/, "the app shell is sized to the page");
assert.doesNotMatch(bodyRule, /100vh/, "100vh includes the safe areas in the app's web view");
assert.match(schedule, /\n  html \{ height:100%; \}/, "body's 100% needs a sized root");

/* ---- Schedule: the divider, stacked and side by side ---- */

function dragDivider(direction) {
  const listeners = {};
  const style = () => ({ flex: "" });
  const divider = {
    classList: { add() {}, remove() {} },
    setPointerCapture() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; }
  };
  const body = { getBoundingClientRect: () => ({ left: 0, top: 100, width: 400, height: 600 }) };
  const frame = { style: style() }, viewerPane = { style: style() };
  const panel = {
    frame,
    tr: { querySelector: (sel) => ({ ".crm-divider": divider, ".crm-panel-body": body, ".crm-viewer": viewerPane })[sel] }
  };
  const getComputedStyle = (el) => ({ flexDirection: el === body ? direction : "row" });
  new Function("panel", "getComputedStyle", functionSource(schedule, "initPanelDivider") + "\ninitPanelDivider();")(panel, getComputedStyle);
  listeners.pointerdown({ preventDefault() {}, pointerId: 1 });
  // 30% across the panel, and 70% of the way down it: whichever axis is read decides the split.
  listeners.pointermove({ clientX: 120, clientY: 520 });
  return { frame: frame.style.flex, viewer: viewerPane.style.flex };
}
assert.deepStrictEqual(dragDivider("row"), { frame: "0 0 30%", viewer: "0 0 70%" },
  "side by side, the divider follows the pointer across");
assert.deepStrictEqual(dragDivider("column"), { frame: "0 0 70%", viewer: "0 0 30%" },
  "stacked on a phone, the divider follows the pointer down");

/* ---- Report Generator: the two-row app bar ---- */

const gen = phoneBlock(report);
const barHeight = Number((/\.app-bar \{[^}]*\bheight: (\d+)px;/.exec(gen) || [])[1]);
assert.ok(barHeight > 44, "the phone app bar is taller than the one-row bar");
assert.strictEqual(Number((/\.main \{ top: (\d+)px; \}/.exec(gen) || [])[1]), barHeight,
  "the form starts where the bar ends");
assert.strictEqual(Number((/\.db-handoff-guard \{ inset: (\d+)px 0 0; \}/.exec(gen) || [])[1]), barHeight,
  "the handoff guard covers the form, not the bar");
const toastTop = Number((/@media \(max-width:640px\)\{ #pdp-status\{ top:(\d+)px;/.exec(report) || [])[1]);
assert.ok(toastTop > barHeight, "the import toast sits below the taller bar");
assert.match(gen, /\.app-bar \.app-menu-btn svg \{ display: block; \}/,
  "the menu button is only its glyph, which the 460px rule would otherwise hide");

/* ---- the app's shim: no zooming into small fields ---- */

// Runs crm-native-shim.js in its own realm with just enough window/document to reach its
// DOMContentLoaded work, and returns the viewport content that page ends up with.
function shimViewport(isTop, content) {
  const vm = require("vm");
  const meta = { content };
  let ready = null;
  const document = {
    head: { appendChild() {} },
    createElement: () => ({}),
    querySelector: (sel) => (sel === 'meta[name="viewport"]' ? meta : null),
    addEventListener: (type, fn) => { if (type === "DOMContentLoaded") ready = fn; }
  };
  const win = { webkit: { messageHandlers: { crmNative: { postMessage() {} } } }, document };
  win.window = win;
  win.top = isTop ? win : {};
  vm.runInNewContext(read("iPad_APP/CRMiPad/crm-native-shim.js"), win);
  assert.ok(ready, "the shim does its page work on DOMContentLoaded");
  ready();
  return meta.content;
}
assert.strictEqual(shimViewport(true, "width=device-width, initial-scale=1.0"),
  "width=device-width, initial-scale=1.0, maximum-scale=1",
  "the top page stops the iPhone zooming into a focused 10px field");
assert.strictEqual(shimViewport(false, "width=device-width, initial-scale=1.0"), "width=device-width, initial-scale=1.0",
  "a frame's viewport is ignored by WebKit, so the embedded pages are left alone");
assert.strictEqual(shimViewport(true, "width=device-width, maximum-scale=2"), "width=device-width, maximum-scale=2",
  "a page that already sets a maximum keeps it");
assert.match(read("iPad_APP/CRMiPad/WebViewController.swift"), /config\.ignoresViewportScaleLimits = true/,
  "pinch zoom must survive the maximum-scale the shim adds");

/* ---- PDF Viewer ---- */

const view = phoneBlock(viewer);
assert.match(view, /body\.toc-open #pages, body\.toc-open #status \{ left: 0; \}/, "Contents opens over the page");
assert.match(viewer, /tocEl\.addEventListener\("click", function \(ev\) \{\s*if \(tocOverlays\.matches && ev\.target\.closest\("\.toc-item"\)\) toggleToc\(false\);/,
  "picking a Contents entry closes the overlay so the page it jumped to is visible");

console.log("phone-layout: all assertions passed");
