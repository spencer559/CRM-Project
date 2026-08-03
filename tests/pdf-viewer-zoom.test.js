"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const viewer = fs.readFileSync(path.join(__dirname, "..", "app", "PDF_Viewer.html"), "utf8");

assert.match(viewer, /var ZOOM_STEPS = \[1, 1\.25, 1\.5, 2, 2\.5, 3\]/,
  "zoom should be bounded and retain Fit as its first/default step");
assert.match(viewer, /scroll-snap-type: y mandatory/,
  "zoom must retain the one-page snap scroller");
assert.match(viewer, /var scale = Math\.min\([^;]+\) \* zoom;/,
  "PDF pages should be rerendered as vectors at the selected zoom");
assert.match(viewer, /var dprCap = \(EMBED \? 2\.25 : 3\) \/ zoom;/,
  "zoomed canvases need a bounded backing resolution to control memory");
assert.match(viewer, /\.text-layer span/,
  "text spans should remain excluded from drag-to-pan so values stay selectable");
assert.match(viewer, /if \(ev\.ctrlKey \|\| ev\.metaKey\)/,
  "standard keyboard zoom shortcuts should be supported");
assert.match(viewer, /stepZoom\(ev\.deltaY < 0 \? 1 : -1\)/,
  "Ctrl/Cmd-wheel should use the viewer's bounded zoom steps");
assert.match(viewer, /var zoomWheelLocked = false/,
  "trackpad zoom events should be throttled independently of ordinary page-wheel navigation");
assert.match(viewer, /s\.canvas\.style\.visibility = "hidden";[\s\S]{0,400}?s\.task\.canvas\.cancel/,
  "a canvas must be hidden before an in-progress PDF.js paint is cancelled");
assert.match(viewer, /oldCanvas\.replaceWith\(freshCanvas\); s\.canvas = freshCanvas/,
  "a rapidly re-entered page must not reuse a canvas whose prior paint is still settling");

console.log("PASS pdf-viewer-zoom");
