# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The project brief is shared with other coding agents, so it lives in `AGENTS.md` and is imported below.
Edit it there, not here, so the tools can't drift apart. This file only adds what's specific to Claude
Code.

@AGENTS.md

## Claude Code only

**Test gate hook.** `.claude/settings.json` runs `.claude/hooks/test-gate.js`. It snapshots the working
tree when a prompt arrives. When Claude stops, if files changed during the turn, it runs `npm test` and
blocks the stop with the failure output if the suite fails. When blocked, fix the failure. If it comes
from changes not made in this turn (the user's own work, or another session in this checkout), end the
turn and say so rather than editing around it. It complements the git pre-commit hook in `AGENTS.md`:
this one catches a broken turn even when nothing gets committed.

**Memory.** Anything another agent would also need (a decision, a rejected alternative, a known gap)
goes in the repo docs, not only in auto-memory, because this project is also worked on with ChatGPT/Codex.
Keep memory for what's specific to this Mac or to Claude.
