#!/bin/bash
# Stage TCC-protected local stores into ~/briefing-data/staging so the node
# pipeline never has to read protected paths directly.
#
# WHY: Full Disk Access is granted to /bin/bash (the launchd job program), and
# direct children of that bash inherit it. But the node binary carries a stale
# per-binary TCC DENY (System Settings → Full Disk Access → "node", toggled
# off 2026-04-04) which overrides the bash allow for node AND everything node
# spawns. Empirically verified 2026-06-10:
#   bash → ls  (protected dir)        OK
#   bash → node fs.readdir            DENIED
#   bash → node → /bin/cp             DENIED  (deny poisons node's subtree)
# So the copies MUST happen in bash before node starts. This script is meant
# to be SOURCED from the launchd wrapper (same bash process, FDA-granted).
#
# Failure here is non-fatal by design: if a cp fails, the staged copy goes
# stale, the TS sources fall back to the original paths, and the local-health
# probe + 🛑 banner + alert email surface the problem loudly.

STAGE_DIR="$HOME/briefing-data/staging"
mkdir -p "$STAGE_DIR/reminders-stores"

# iMessage (chat.db + WAL/SHM sidecars for read consistency)
cp -f "$HOME/Library/Messages/chat.db"     "$STAGE_DIR/" 2>/dev/null
cp -f "$HOME/Library/Messages/chat.db-wal" "$STAGE_DIR/" 2>/dev/null
cp -f "$HOME/Library/Messages/chat.db-shm" "$STAGE_DIR/" 2>/dev/null

# Calendar (local enrichment DB + sidecars)
CAL_DIR="$HOME/Library/Group Containers/group.com.apple.calendar"
cp -f "$CAL_DIR/Calendar.sqlitedb"     "$STAGE_DIR/" 2>/dev/null
cp -f "$CAL_DIR/Calendar.sqlitedb-wal" "$STAGE_DIR/" 2>/dev/null
cp -f "$CAL_DIR/Calendar.sqlitedb-shm" "$STAGE_DIR/" 2>/dev/null

# Reminders (all account stores + sidecars; the TS side picks the largest)
REM_DIR="$HOME/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores"
cp -f "$REM_DIR"/Data-*.sqlite* "$STAGE_DIR/reminders-stores/" 2>/dev/null

date +%s > "$STAGE_DIR/.staged-at" 2>/dev/null
echo "[stage-protected] staged at $(date '+%H:%M:%S') — $(ls "$STAGE_DIR" 2>/dev/null | wc -l | tr -d ' ') entries"
# NOTE: no `exit` here — this file is SOURCED by the launchd wrapper; an exit
# would terminate the wrapper before the pipeline runs.
true
