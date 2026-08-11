# KNOWLEDGE BASE — evolving

## Root cause (confirmed)
Launchd agents run `/bin/bash -c "... npx tsx ..."` without Full Disk Access. Reading TCC-protected stores throws EPERM:
- Reminders: `readdir` of `~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores` → caught → "no SQLite store found".
- iMessage: `copyFile(~/Library/Messages/chat.db)` → EPERM.
- Calendar: `copyFile(~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb)` → EPERM.
Same code works from Terminal/Claude session because that context HAS FDA. FDA cannot be granted by script (SIP) — manual one-time GUI grant to `/bin/bash` is the fix.

## Critical reuse points (from Scout)
- **Banner hook (ZERO assembler edits):** assembler already injects `data.graphTokenHealth` verbatim at the TOP of the brief (claude-missions.ts:443-446 morning, 874-877 afternoon). Append the local-source banner to that same string in index.ts / afternoon.ts. Don't touch claude-missions.ts.
- **Email:** deliver.ts `getTransporter()` is a module-level nodemailer singleton (deliver.ts:4-17), NOT exported. Add an exported `sendAlertEmail(subject, body)` that reuses it. Env: SMTP_HOST/SMTP_USER/SMTP_PASS, RECIPIENT_EMAIL.
- **Reminders cache TTL:** reminders.ts:204 `isCacheFresh(72)`; sentinel returned at reminders.ts:219.
- **Calendar caches:** ical.ts m365-calendar.txt (2h), calendar.txt (24h); SQLite fail caught at ical.ts:178 returns []. Calendar PRIMARY = Graph, healthy — SQLite is enrichment only.
- **iMessage:** NO cache today — returns '(iMessages unavailable...)' on EPERM (imessage.ts:96-100). Add a lightweight cache.
- **Sentinels:** sources return '(unavailable)' (coalesced in index.ts:184-207) or source-specific '(... unavailable ...)' strings.
- **No per-source health state exists.** Need new `~/briefing-data/source-health.json` to detect working→broken transitions (avoid re-alerting every run).
- **copyDbForReading** (utils/copy-db-for-reading.ts:15-31): throws on copyFile EPERM; callers try/catch → sentinel.

## Plist facts
- morning: com.create.morningbriefing.plist — cd `Desktop/Create/Brief` ✓ correct, StartInterval 900, RunAtLoad.
- afternoon: com.create.afternoonsync.plist — cd `Desktop/Brief` ✗ WRONG (dir doesn't exist), StartCalendarInterval 15:00. MUST fix path to `Desktop/Create/Brief`.
- Both ProgramArguments[0] = `/bin/bash` → granting FDA to /bin/bash covers both.

## Nuance: in-process probe vs Terminal probe
The runtime preflight probe runs INSIDE the launchd process → it accurately reflects that context's FDA. A verify helper run from Terminal reflects Terminal's FDA (different grant) — so the helper must clearly state it tests the CURRENT context, and the authoritative signal is the in-pipeline probe (banner/alert email).
