# FEATURE LIST

## Milestone 1 — Detection + Degradation (pure code, no FDA needed)
- [ ] 1.1 (Builder A) — `src/sources/local-health.ts`: preflight probe + source-health.json state + banner builder + transition detection. → assertions 1, 2, 3
- [ ] 1.2 (Builder B) — Graceful degradation: widen reminders cache TTL + age-stamp; add cache+age-stamp to imessage; light age-note to calendar cache. → assertion 4
- [ ] 1.3 (Builder, after 1.1) — `sendAlertEmail()` in deliver.ts + wire index.ts & afternoon.ts (probe → banner into graphTokenHealth slot → transition email). → assertions 2, 3
- [ ] Validator gate M1: assertions 1,2,3,4

## Milestone 2 — Grant durability + verify + docs
- [ ] 2.1 (Builder C) — `src/check-access.ts` verify helper (opens FDA pane, runs probe, PASS/FAIL) + package.json script. → assertions 5, 6
- [ ] 2.2 (Builder C) — Fix afternoon plist cd path + reload; document FDA grant in CLAUDE.md. → assertions 5, 8
- [ ] Validator gate M2: assertions 5,6,7,8

## Status: MISSION COMPLETE — both gates passed (assertions 1-8).
- M1 (detection + degradation): PASS. B1 (false calendar alert) fixed via tightened sentinel matcher + wording.
- M2 (grant durability + verify + docs): PASS. Afternoon plist path fixed + reloaded. check-access helper + CLAUDE.md docs added.
- Remaining manual step (irreducible): user grants Full Disk Access to /bin/bash in System Settings. Stopgap caches refreshed (reminders 14d window, imessage 7d) so the brief carries data even pre-grant; 🛑 banner + alert email will fire on next scheduled run until granted.
