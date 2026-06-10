# Briefing Pipeline — Session Behavior

## On session start

When Jonathan opens a Claude chat about the briefing pipeline, check for pending rule-maintenance proposals:

1. Read `/Users/jonathan.gitlin/briefing-data/maintenance-proposal.md`
2. If there are ANY `status: pending` proposals, surface them to Jonathan at the top of the first response. Format:

> **Pending rule-maintenance proposals: N**
> - [proposal-id]: <summary> (expires YYYY-MM-DD)
>   Options: **approve** / **keep in notes** / **drop entirely**
>
> Tell me how to handle these, or ignore and they'll auto-apply on <expiration date>.

3. If Jonathan responds with a decision in chat, run the equivalent of `applyProposal(id, outcome)` via a shell invocation: `/opt/homebrew/bin/npx tsx -e "import {applyProposal} from '/Users/jonathan.gitlin/Desktop/Brief/src/sources/proposal.ts'; applyProposal('<id>', '<outcome>')"` — or just edit maintenance-proposal.md directly to mark the proposal accordingly.

## Related files

- Rule notes: `/Users/jonathan.gitlin/briefing-data/briefing-notes.md`
- Archive: `/Users/jonathan.gitlin/briefing-data/briefing-notes-archive.md`
- Proposals: `/Users/jonathan.gitlin/briefing-data/maintenance-proposal.md`
- Regression log: `/Users/jonathan.gitlin/briefing-data/regression-log.jsonl`
- Pipeline code: `/Users/jonathan.gitlin/Desktop/Brief/src/`

## Promoted rule locations (automatic)

When a rule is approved for promotion, the system automatically calls a Sonnet model to suggest which pipeline file the rule should be hardcoded into. The suggestion is written to the `promoted_to` field in the archive immediately — Jonathan does not need to run any command.

The suggestion will be one of:
- `src/claude-missions.ts` — main assembler/validator prompts (most rules)
- `src/sources/feedback.ts` — feedback constants
- `src/sources/<specific-source>.ts` — pre-processing for a specific data source

Jonathan's only action is to reply "approve" via email or chat. The `promoted_to` field will already be populated when the archive entry is written.

## Full Disk Access (required for local data sources)

The launchd-scheduled **morning** and **afternoon** agents run via `/bin/bash -c "...npx tsx..."`. Reading macOS-protected local stores requires **Full Disk Access (FDA)**:

- Reminders — `~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores`
- iMessage — `~/Library/Messages/chat.db`
- Calendar — local `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb` (local enrichment only; not the MS Graph calendar)

Without FDA, **Reminders and iMessage drop out** and **Calendar loses its local enrichment** — and before this fix it happened *silently*.

### Granting access (one-time, manual — cannot be scripted)

System Settings → Privacy & Security → Full Disk Access → **+** → add **/bin/bash** (use **Cmd+Shift+G** to navigate to `/bin/bash`). The launchd jobs invoke `/bin/bash -c "..."`, so the grant target is the shell, not node/tsx. Granting to `/bin/bash` is **stable across `brew upgrade node`** (the node binary path changes on upgrade; `/bin/bash` does not).

### Why bash stages copies for node (the 2026-06-10 discovery)

Granting FDA to `/bin/bash` alone was NOT enough: the node binary carries a stale **per-binary TCC DENY** (added 2026-04-04, visible as "node" toggled off in the FDA pane) that **overrides** the bash allow for node *and everything node spawns* (even `/bin/cp` run from node is denied). Empirically verified via launchd probe jobs: `bash → ls` on a protected dir = OK; `bash → node fs.readdir` = DENIED; `bash → node → cp` = DENIED.

Fix: **`stage-protected.sh`** (repo root) is *sourced* by both launchd wrappers before `npx tsx` runs. Bash (FDA-granted) copies chat.db, Calendar.sqlitedb, and the Reminders stores (+ WAL/SHM sidecars) into `~/briefing-data/staging/`; the TS sources prefer a fresh (<30 min) staged copy and fall back to the protected originals (which work in interactive contexts). The local-health probe counts a fresh staged copy as healthy. Node never touches a protected path on scheduled runs — immune to `brew upgrade node` and stale TCC rows. Optional cleanup: removing the "node" (and "sqlite3") DENIED entries from the FDA pane is harmless but no longer required.

### Verify

Run `npm run check-access`. Note: it probes the **current shell context**, which usually already has FDA — so it can show all ✅ even while the scheduled launchd job is still denied. The real confirmation is the **next briefing run**: if the 🛑 banner (and the alert email) clears, the grant worked.

### Detection (if access is lost again)

- The brief shows a **🛑 banner at the top** naming the dead source(s).
- A **one-time alert email** fires on the working→broken transition. State is tracked in `~/briefing-data/source-health.json`.
- Local sources serve **age-stamped cached data** (Reminders up to 14d, iMessage 7d) instead of vanishing, so the brief degrades gracefully rather than going blank.
