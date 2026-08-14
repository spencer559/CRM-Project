/* BIOTRONIK Home-Monitoring horizontal lead inventory and diagnostics coverage. */
"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
require(path.join(__dirname, "..", "src", "engine.js"));
require(path.join(__dirname, "..", "src", "parsers", "biotronik.js"));

function line(page, y, cells) {
  return { page, y, items: cells.map(([x, str]) => ({ page, x, y, w: 20, str })) };
}

const out = global.BIOTRONIK.runMap([
  line(1, 721, [[81,"Recent"],[109,"follow-up:"],[150,"08/14/2026"],[251,"Edor"],[268,"a"],[275,"8"],[283,"DR"],[293,"-"],[296,"T"],[309,"S/N:"],[330,"1000363924"]]),
  line(1, 625, [[96,"Mode"],[475,"DDD"]]),
  line(2, 222, [[110,"Mode"],[137,"switching"],[482,"ON"]]),
  line(2, 209, [[110,"Intervention"],[169,"rate"],[190,"[bpm]"],[479,"170"]]),
  line(7, 262, [[138,"Lead"],[154,"model"],[241,"Manufacturer"],[313,"Serial"],[332,"number"],[376,"Type"],[412,"Implantation"],[481,"Channels"]]),
  line(7, 249, [[138,"SOLIA"],[159,"S"],[165,"53"],[247,"Biotronik"],[315,"8001700498"],[376,"BIPL"],[413,"11/27/2024"],[490,"RA"]]),
  line(7, 236, [[138,"SOLIA"],[159,"S"],[165,"60"],[247,"Biotronik"],[315,"8001705310"],[376,"BIPL"],[413,"11/27/2024"],[490,"RV"]]),
  line(9, 612, [[96,"Total"],[121,"number"],[159,"of"],[171,"episodes"],[479,"333"]]),
  line(18, 313, [[96,"High"],[120,"ventricular"],[171,"rate"],[192,"episodes"],[235,"[Count]"],[490,"1"]]),
  line(18, 300, [[96,"PMT"],[118,"episodes"],[160,"[Count]"],[490,"0"]]),
  line(33, 600, [[107,"20"],[153,"07/22/2026"],[191,"21:08"],[273,"00:01:26"],[394,"AT"],[472,"135"]]),
  line(33, 379, [[109,"3"],[153,"05/27/2026"],[191,"21:39"],[274,"00:00:04"],[391,"HVR"],[472,"194"]]),
  line(33, 366, [[109,"2"],[153,"12/30/2024"],[191,"23:06"],[274,"09:59:20"],[394,"AT"],[473,"69"]]),
  line(36, 417, [[96,"Battery"],[132,"status"],[483,"OK"]])
]);

const r = out.RESULT;
assert.strictEqual(r["dev-model"].v, "Edora 8 DR-T");
assert.strictEqual(r["dtype"].v, "PPM-DC");
assert.strictEqual(r["p-ms"].v, "On");
assert.strictEqual(r["p-msrate"].v, "170");
assert.strictEqual(r["bat-status"].v, "OK");
assert.strictEqual(r["ep-ahr"].v, "333");
assert.strictEqual(r["ep-hvr"].v, "1");
assert.strictEqual(r["ep-pmt"].v, "0");
assert.deepStrictEqual(out.LEADS, [
  { location:"RA", manufacturer:"Biotronik", model:"SOLIA S 53", serial:"8001700498", date:"11/27/2024" },
  { location:"RV", manufacturer:"Biotronik", model:"SOLIA S 60", serial:"8001705310", date:"11/27/2024" }
]);
assert.strictEqual(out.EPISODES.length, 3);
assert.deepStrictEqual(out.EPISODES[0].flags, ["Recent"]);
assert.deepStrictEqual(out.EPISODES[1].flags, ["Fastest"]);
assert.deepStrictEqual(out.EPISODES[2].flags, ["Longest"]);
assert.deepStrictEqual(out.EPISODES[1].types, ["Other"]);

console.log("all checks passed");
