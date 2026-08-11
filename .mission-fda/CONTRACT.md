# VALIDATION CONTRACT — FDA Permanent Fix

Mission: Permanently fix the launchd briefing agents' Full Disk Access failure and guarantee it can never silently recur.

## Assertions (testable, black-box where possible)

1. **Preflight check exists.** A module probes read access to each protected store on every run — Reminders group container, `~/Library/Messages/chat.db`, `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb` — and returns a structured per-source `OK | DENIED` result.

2. **No silent omission.** When any local source is DENIED or returns its `(unavailable)` sentinel, the brief renders a 🛑 banner at the top naming the affected source(s) and the age of any fallback used. The section is never silently dropped.

3. **Transition alert.** On a working→broken transition for any local source, a one-time alert email is sent reusing the existing SMTP config. It does NOT re-send every run while still broken (state-tracked). It sends a recovery note on broken→working.

4. **Graceful degradation.** Local sources serve best-available cache stamped with its age ("as of N days/hours ago") rather than vanishing. The reminders cache fallback window is widened from 72h so a future FDA loss degrades slowly and visibly.

5. **Durable grant target.** The morning + afternoon launchd plists are configured so a single Full Disk Access grant to `/bin/bash` restores all three sources. A verify helper opens the correct System Settings pane and reports whether the grant is currently effective.

6. **Verifiable.** Running the verify helper prints PASS/FAIL per protected source. Re-runnable (idempotent), safe to run anytime.

7. **No cloud regression.** Graph (email/calendar/teams), Notion, collections, igor-forecast, Anthropic Missions, and SMTP delivery all still work exactly as before. Calendar still merges Graph (primary) + SQLite-enrichment (when available).

8. **Documented.** The FDA grant + verify procedure is written into CLAUDE.md so it is never re-diagnosed from scratch.

## Status
LOCKED — 2026-06-09
