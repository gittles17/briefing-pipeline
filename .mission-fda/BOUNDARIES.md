# BOUNDARIES

## Do NOT modify
- Any cloud-source logic that is currently healthy: `graph-client.ts`, `notion.ts`, `collections.ts`, `igor-forecast.ts`, `teams.ts`, `industry-intel.ts`, `claude-missions.ts` worker/assembler prompts (except the minimal hook needed to inject the unavailability banner), `deliver.ts` send mechanism (REUSE it, don't rewrite it).
- The Anthropic Missions pipeline phases.
- `.env`, credentials, token files.

## Do NOT delete anything
- Org rule: never delete files/data without explicit approval. Append/extend only. If something looks removable, report it — do not remove it.

## Do NOT attempt
- Granting Full Disk Access programmatically. It is impossible without disabling SIP. The grant is a documented manual step. Workers must NOT try `tccutil`, MDM profiles, or SIP changes.
- Disabling SIP, editing TCC.db directly, or any privilege escalation.

## Constraints
- Match surrounding code style (TS, the existing logging `[source] msg` convention, fallback-chain pattern).
- New runtime files live under `src/` or `src/sources/` or `src/utils/`. Mission state lives under `.mission-fda/`.
- Reuse the existing SMTP transport from `deliver.ts` for any alert email — do not introduce a new mail mechanism.
- If blocked or scope exceeds the feature, STOP and report back to the orchestrator.
