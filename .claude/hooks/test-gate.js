#!/usr/bin/env node
/* test-gate.js — Claude may not end a turn that broke the test suite.
 *
 * Wired in .claude/settings.json as two Claude Code hooks:
 *
 *   UserPromptSubmit → test-gate.js start   fingerprint the working tree as the turn begins
 *   Stop             → test-gate.js stop    if anything changed since, run the suite; on failure,
 *                                            block the stop and hand Claude the failing output
 *
 * Why at Stop and not after every edit: a change that spans several files is legitimately broken
 * between its edits, and the suite takes ~5s. What matters is the state the turn ends in.
 *
 * Why a snapshot at the start of the turn: a turn that only read code or answered a question must
 * cost nothing, and a turn must not be blamed for work it didn't do — the user's own uncommitted
 * edits, or another session working in this checkout. Only files that changed during the turn
 * trigger a run, and they are listed in the failure message so Claude can tell which is which.
 *
 * Fingerprints are git blob ids of file contents, not mtimes, so "this exact tree already passed"
 * can be remembered across turns and sessions, and a suite that just passed isn't run again.
 *
 * It never traps a turn: the same failing tree is reported once, a turn is blocked at most
 * MAX_BLOCKS times, and anything unexpected (no node, a hung suite, a bug here) lets the stop through
 * with a message rather than holding Claude in a loop.
 */
"use strict";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_BLOCKS = 3;
const SUITE_TIMEOUT_MS = 150 * 1000;      // the hook itself is given 180s in settings.json
const OUTPUT_LIMIT = 12000;               // characters of test output handed back to Claude
// Changes to these can't affect a test, so they never trigger a run.
const IGNORED = [/\.md$/i, /^docs\//, /^site\/assets\//, /\.xcassets\//];

const mode = process.argv[2];

function git(root, args, input) {
  const r = spawnSync("git", ["-C", root].concat(args), { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("git " + args[0] + " failed: " + (r.stderr || "").trim());
  return r.stdout;
}

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) { return {}; }
}

// The repo this session works in. Anything that isn't this project (no tests/run.js) is left alone —
// notably a parent directory that resolves to some other repo.
function projectRoot(input) {
  const start = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let root;
  try { root = git(start, ["rev-parse", "--show-toplevel"]).trim(); } catch (e) { return null; }
  return fs.existsSync(path.join(root, "tests", "run.js")) ? root : null;
}

// path → blob id for every tracked or untracked-but-not-ignored file that could affect a test.
function snapshot(root) {
  const paths = git(root, ["ls-files", "-z", "-co", "--exclude-standard"]).split("\0")
    .filter((p) => p && !IGNORED.some((re) => re.test(p)))
    .filter((p) => { try { return fs.statSync(path.join(root, p)).isFile(); } catch (e) { return false; } });
  const unique = Array.from(new Set(paths)).sort();
  const files = {};
  if (!unique.length) return files;
  const ids = git(root, ["hash-object", "--stdin-paths"], unique.join("\n") + "\n").trim().split("\n");
  unique.forEach((p, i) => { files[p] = ids[i]; });
  return files;
}

function fingerprint(files) {
  const h = crypto.createHash("sha256");
  for (const p of Object.keys(files).sort()) h.update(files[p] + " " + p + "\n");
  return h.digest("hex").slice(0, 32);
}

function changedFiles(before, after) {
  const out = [];
  for (const p of Object.keys(after)) {
    if (!(p in before)) out.push("A " + p);
    else if (before[p] !== after[p]) out.push("M " + p);
  }
  for (const p of Object.keys(before)) if (!(p in after)) out.push("D " + p);
  return out.sort((a, b) => a.slice(2).localeCompare(b.slice(2)));
}

// Per-project state outside the repo, so it never shows up in git or in a worktree.
function stateDir(root) {
  const dir = path.join(os.tmpdir(), "claude-test-gate",
    crypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; } }
function writeJson(file, value) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
function turnFile(dir, input) {
  return path.join(dir, "turn-" + String(input.session_id || "nosession").replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}

function emit(obj) { process.stdout.write(JSON.stringify(obj)); }

// The runner prints one PASS/FAIL line per file, then each failure's own output, then a summary.
// Claude needs the failures, not fifty PASS lines.
function failureReport(output) {
  const text = output.split("\n").filter((l) => !/^\S+\.test\.js\s*PASS\s*$/.test(l)).join("\n").trim();
  if (text.length <= OUTPUT_LIMIT) return text;
  const head = Math.floor(OUTPUT_LIMIT * 0.6), tail = OUTPUT_LIMIT - head;
  return text.slice(0, head) + "\n\n[… " + (text.length - OUTPUT_LIMIT) + " characters cut …]\n\n" + text.slice(-tail);
}

function start(input) {
  const root = projectRoot(input);
  if (!root) return;
  const dir = stateDir(root);
  // Anything printed here would be added to Claude's context, so this stays silent.
  writeJson(turnFile(dir, input), { base: snapshot(root), blocks: 0, lastFailed: null, at: Date.now() });
}

function stop(input) {
  const root = projectRoot(input);
  if (!root) return;
  const dir = stateDir(root);
  const turnPath = turnFile(dir, input);
  const turn = readJson(turnPath);
  // No snapshot means the turn started before this hook existed (or its state was cleared): there is
  // no way to tell this turn's changes from anyone else's, so don't guess.
  if (!turn || !turn.base) return;

  const files = snapshot(root);
  const changed = changedFiles(turn.base, files);
  if (!changed.length) return;

  const fp = fingerprint(files);
  const greenPath = path.join(dir, "green.json");
  const green = readJson(greenPath);
  if (green && green.fp === fp) return;    // exactly these bytes already passed

  if (turn.lastFailed === fp) {
    // Claude has already seen this failure and stopped without changing anything since — it has
    // decided not to (or can't) fix it. Make sure the user sees it rather than blocking again.
    emit({ systemMessage: "Test gate: npm test is still failing on this turn's changes (Claude was shown the output)." });
    return;
  }

  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, "tests", "run.js")], {
    cwd: root, encoding: "utf8", timeout: SUITE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const output = (r.stdout || "") + (r.stderr || "");

  if (r.error || r.status === null) {
    const why = r.error && r.error.code === "ETIMEDOUT" ? "timed out after " + SUITE_TIMEOUT_MS / 1000 + "s"
      : (r.error ? r.error.message : "was killed by " + r.signal);
    emit({ systemMessage: "Test gate: the test suite " + why + ", so this turn's changes are untested." });
    return;
  }

  const summary = (output.trim().split("\n").pop() || "").trim();
  if (r.status === 0) {
    writeJson(greenPath, { fp, at: Date.now() });
    turn.lastFailed = null;
    writeJson(turnPath, turn);
    emit({ systemMessage: "Test gate: npm test " + summary + " (" + secs + "s)" });
    return;
  }

  turn.lastFailed = fp;
  turn.blocks = (turn.blocks || 0) + 1;
  writeJson(turnPath, turn);
  if (turn.blocks > MAX_BLOCKS) {
    emit({ systemMessage: "Test gate: npm test is still failing (" + summary + ") after " + MAX_BLOCKS +
      " attempts to fix it this turn; letting the turn end." });
    return;
  }

  const listed = changed.slice(0, 40).map((c) => "  " + c).join("\n") +
    (changed.length > 40 ? "\n  … and " + (changed.length - 40) + " more" : "");
  emit({
    decision: "block",
    reason: [
      "The test gate ran `npm test` because files changed during this turn, and it failed (" + summary + ").",
      "",
      "Files changed since the user's last message:",
      listed,
      "",
      failureReport(output),
      "",
      "Fix the failure before finishing; rerun a single file with `node tests/<name>.test.js`.",
      "If a failing test is explained by changes you did not make this turn (the user's own work, or another " +
        "session in this checkout), do not edit around it: end the turn and tell the user which test fails and why.",
      "If a test is asserting old behavior that this turn deliberately changed, update the test to the new " +
        "behavior rather than weakening it, and say so."
    ].join("\n")
  });
}

try {
  const input = readInput();
  if (mode === "start") start(input);
  else if (mode === "stop") stop(input);
} catch (e) {
  // A broken gate must never hold a turn hostage. Say so at Stop; stay silent at prompt submit.
  if (mode === "stop") emit({ systemMessage: "Test gate error (tests not run): " + (e && e.message || e) });
}
process.exit(0);
