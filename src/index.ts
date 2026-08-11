import { config } from 'dotenv';
config({ override: true });
import { fetchTLDR } from './sources/tldr';
import { fetchReminders } from './sources/reminders';
import { fetchIMessages } from './sources/imessage';
import { fetchAppleMail } from './sources/applemail';
import { fetchLuminate } from './sources/luminate';
import { fetchICal, fetchYesterdayCalendar } from './sources/ical';
import { fetchNotionProjects } from './sources/notion';
import { fetchIgorForecast } from './sources/igor-forecast';
import { getRecurringAlerts } from './claude';
import { generateBriefingMissions } from './claude-missions';
import { sendBriefing, sendAlertEmail } from './deliver';
import { fetchFeedback } from './sources/feedback';
import { fetchClaudeSessions } from './sources/claude-sessions';
import { fetchTeamsMessages } from './sources/teams';
import { fetchCollectionsReport } from './sources/collections';
import { fetchIndustryIntel } from './sources/industry-intel';
import { fetchReplyEngineStatus } from './sources/reply-engine-status';
import { fetchAurisStatus } from './sources/auris-status';
import { getGraphTokenHealth } from './sources/graph-client';
import { loadRollingContext, archiveBriefing, saveContext } from './context';
import { loadActionItems, updateActionItems } from './sources/action-items';
import { trackRuleUsage } from './sources/rule-usage';
import { processProposalReplies } from './sources/proposal-replies';
import { getNextProposal, autoApplyExpired } from './sources/proposal';
import { probeProtectedAccess, evaluateLocalHealth, commitHealthState } from './sources/local-health';
import { runSelfHeal, type SelfHealReport } from './sources/self-heal';
import { withTimeout } from './utils/with-timeout';
import { readFile, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';

const execAsync = promisify(execFile);

/** Export macOS Contacts to TSV for iMessage name resolution */
async function refreshContacts(): Promise<void> {
  const tsv = `${homedir()}/briefing-data/contacts.tsv`;
  try {
    const script = `
      set output to ""
      repeat with dbPath in {"${homedir()}/Library/Application Support/AddressBook/Sources/"}
      end repeat
      return output
    `;
    // Use sqlite3 directly — faster and more reliable than AppleScript
    const dbs = await execAsync('bash', ['-c',
      `find "$HOME/Library/Application Support/AddressBook/Sources" -name "AddressBook-v22.abcddb" 2>/dev/null`
    ]);
    const dbPaths = dbs.stdout.trim().split('\n').filter(Boolean);
    const lines: string[] = [];
    for (const db of dbPaths) {
      try {
        const { stdout: phones } = await execAsync('sqlite3', [db,
          "SELECT ZFULLNUMBER, COALESCE(ZFIRSTNAME,'') || ' ' || COALESCE(ZLASTNAME,'') FROM ZABCDPHONENUMBER JOIN ZABCDRECORD ON ZABCDPHONENUMBER.ZOWNER = ZABCDRECORD.Z_PK WHERE ZFULLNUMBER IS NOT NULL AND (ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL);"
        ]);
        const { stdout: emails } = await execAsync('sqlite3', [db,
          "SELECT ZADDRESS, COALESCE(ZFIRSTNAME,'') || ' ' || COALESCE(ZLASTNAME,'') FROM ZABCDEMAILADDRESS JOIN ZABCDRECORD ON ZABCDEMAILADDRESS.ZOWNER = ZABCDRECORD.Z_PK WHERE ZADDRESS IS NOT NULL AND (ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL);"
        ]);
        for (const line of [...phones.split('\n'), ...emails.split('\n')]) {
          if (line.includes('|')) {
            lines.push(line.replace('|', '\t'));
          }
        }
      } catch {}
    }
    if (lines.length > 0) {
      const { writeFile } = await import('fs/promises');
      await writeFile(tsv, lines.join('\n'), 'utf-8');
      console.log(`[contacts] exported ${lines.length} contacts`);
    }
  } catch (err: any) {
    console.log(`[contacts] refresh failed: ${err.message}`);
  }
}

/**
 * Loads the oldest pending maintenance proposal and renders it as a markdown
 * section for insertion into the morning briefing prompt.
 *
 * Returns an empty string if there are no pending proposals.
 * Subject format: [maintenance:<id>] approve  /  [maintenance:<id>] keep  /  [maintenance:<id>] drop
 */
async function renderPendingProposal(): Promise<string> {
  try {
    const proposal = await getNextProposal();
    if (!proposal) return '';

    const smtpUser = process.env.SMTP_USER ?? '';
    const id = proposal.id;

    // Build the usage summary from rationale (rationale contains "applied N times in last 30 days")
    const firingMatch = proposal.rationale.match(/applied (\d+) times? in the last (\d+) days?/i);
    const firingNote = firingMatch
      ? `Fired ${firingMatch[1]}x in last ${firingMatch[2]} days.`
      : '';

    // Determine what kind of proposal this is
    const ruleList = proposal.ruleIds.join(', ');
    const typeLabel = proposal.type === 'promote'
      ? `Promote rule \`${ruleList}\` to hardcoded prompt`
      : `Merge rules \`${ruleList}\``;

    const summary = `${typeLabel}`;

    // mailto links — subject prefixed with [maintenance:<id>] so reply parser can match
    const encode = (s: string) => encodeURIComponent(s);
    const approveSubj = encode(`[maintenance:${id}] approve`);
    const keepSubj    = encode(`[maintenance:${id}] keep`);
    const dropSubj    = encode(`[maintenance:${id}] drop`);

    const approveLink = `mailto:${smtpUser}?subject=${approveSubj}&body=${encode('approve')}`;
    const keepLink    = `mailto:${smtpUser}?subject=${keepSubj}&body=${encode('keep')}`;
    const dropLink    = `mailto:${smtpUser}?subject=${dropSubj}&body=${encode('drop')}`;

    const lines: string[] = [
      `## Rule Maintenance`,
      `- **${summary}** — ${proposal.rationale}${firingNote ? ' ' + firingNote : ''}`,
      `  Reply: [approve](${approveLink}) / [keep in notes](${keepLink}) / [drop entirely](${dropLink})`,
    ];

    // Also surface any recent auto-applied/auto-skipped proposals from last 3 days
    const { getRecentlyApplied } = await import('./sources/proposal');
    const recentAuto = await getRecentlyApplied(['auto-applied', 'auto-skipped'], 3);
    for (const entry of recentAuto) {
      const undoSubj  = encode(`undo [maintenance:${entry.id}]`);
      const undoLink  = `mailto:${smtpUser}?subject=${undoSubj}&body=${encode('undo')}`;
      const outcomeLabel = entry.outcome === 'auto-applied' ? 'Auto-applied' : 'Auto-skipped (needs review)';
      lines.push(`- **${outcomeLabel}:** ${entry.description} — [undo](${undoLink})`);
    }

    return lines.join('\n');
  } catch (err: any) {
    console.log(`[proposal-render] ${err.message}`);
    return '';
  }
}

async function run() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  const isWeekend = [0, 6].includes(now.getDay()); // 0=Sun, 6=Sat

  console.log(`[briefing] starting — ${date}${isWeekend ? ' (weekend mode)' : ''}`);

  // SELF-HEAL: repair the environment BEFORE anything is fetched (rebuild a
  // Node-ABI-mismatched better-sqlite3, clear stale locks, prune temp dirs,
  // repair a corrupt graph token, re-stage protected DBs). Fully fault-isolated.
  // The report feeds the health alert so we only escalate what heal couldn't fix.
  let healReport: SelfHealReport | null = null;
  try {
    healReport = await runSelfHeal();
  } catch (err: any) {
    console.log(`[self-heal] wiring error: ${err?.message || 'unknown'}`);
  }

  // Process any pending proposal replies Jonathan sent (non-blocking, errors logged)
  processProposalReplies().catch(err => console.log('[proposal-replies]', err.message));

  // Expire any stale proposals before rendering (so they never surface in briefing)
  await autoApplyExpired().catch(err => console.log('[proposal-expired]', err.message));

  // Refresh contacts for iMessage name resolution
  await refreshContacts();

  // Reminders and Igor are AppleScript-based and osascript serializes on macOS,
  // so we keep them sequential. Everything else (Graph API + network calls +
  // local file reads) runs in one parallel batch.
  console.log('[briefing] fetching reminders (AppleScript, sequential)...');
  const reminders = await withTimeout(fetchReminders(), 120000, 'reminders').then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[briefing] fetching igor forecast (AppleScript, sequential)...');
  const igorForecast = await withTimeout(fetchIgorForecast(), 120000, 'igor-forecast').then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[briefing] fetching remaining sources in parallel...');
  const [calendar, yesterdayCalendar, email, luminate, imessages, tldr, notionProjects, feedback, rollingContext, claudeSessions, actionItems, teamsMessages, collectionsReport, industryIntel, replyEngineStatus, aurisStatus] = await Promise.allSettled([
    withTimeout(fetchICal(), 120000, 'calendar'),
    withTimeout(fetchYesterdayCalendar(), 120000, 'yesterday-calendar'),
    withTimeout(fetchAppleMail(), 120000, 'applemail'),
    withTimeout(fetchLuminate(), 120000, 'luminate'),
    withTimeout(fetchIMessages(), 120000, 'imessage'),
    withTimeout(fetchTLDR(), 120000, 'tldr'),
    withTimeout(fetchNotionProjects(), 120000, 'notion'),
    withTimeout(fetchFeedback(), 90000, 'feedback'),
    withTimeout(loadRollingContext(), 60000, 'rolling-context'),
    withTimeout(fetchClaudeSessions(), 60000, 'claude-sessions'),
    withTimeout(loadActionItems(), 60000, 'action-items'),
    withTimeout(fetchTeamsMessages(), 120000, 'teams'),
    withTimeout(fetchCollectionsReport(), 120000, 'collections'),
    withTimeout(fetchIndustryIntel(), 120000, 'industry-intel'),
    withTimeout(fetchReplyEngineStatus(), 60000, 'reply-engine'),
    withTimeout(fetchAurisStatus(), 120000, 'auris'),
  ]);

  const data = {
    date,
    email: email.status === 'fulfilled' ? email.value : '(unavailable)',
    calendar: calendar.status === 'fulfilled' ? calendar.value : '(unavailable)',
    yesterdayCalendar: yesterdayCalendar.status === 'fulfilled' ? yesterdayCalendar.value : '(unavailable)',
    reminders: reminders.status === 'fulfilled' ? reminders.value : '(unavailable)',
    imessages: imessages.status === 'fulfilled' ? imessages.value : '(unavailable)',
    tldr: tldr.status === 'fulfilled' ? tldr.value : '(unavailable)',
    luminate: luminate.status === 'fulfilled' ? luminate.value : '(unavailable)',
    notionProjects: notionProjects.status === 'fulfilled' ? notionProjects.value : '(unavailable)',
    igorForecast: igorForecast.status === 'fulfilled' ? igorForecast.value : '(unavailable)',
    feedback: feedback.status === 'fulfilled' ? feedback.value : '',
    rollingContext: rollingContext.status === 'fulfilled' ? rollingContext.value : '',
    recurringAlerts: getRecurringAlerts(new Date(), email.status === 'fulfilled' ? email.value : ''),
    claudeSessions: claudeSessions.status === 'fulfilled' ? claudeSessions.value : '',
    staffingSummary: await readFile(`${homedir()}/briefing-data/staffing-summary.txt`, 'utf-8').catch(() => ''),
    actionItems: actionItems.status === 'fulfilled' ? actionItems.value : '',
    teamsMessages: teamsMessages.status === 'fulfilled' ? teamsMessages.value : '',
    collectionsReport: collectionsReport.status === 'fulfilled' ? collectionsReport.value : '',
    industryIntel: industryIntel.status === 'fulfilled' ? industryIntel.value : '',
    replyEngineStatus: replyEngineStatus.status === 'fulfilled' ? replyEngineStatus.value : '',
    aurisStatus: aurisStatus.status === 'fulfilled' ? aurisStatus.value : '',
    graphTokenHealth: await getGraphTokenHealth().catch(() => ''),
  };

  // Rule maintenance proposals are NOT surfaced in the daily brief anymore —
  // Jonathan didn't want the noise at the top. They still accumulate in
  // ~/briefing-data/maintenance-proposal.md and the 14-day auto-apply logic
  // still runs in the background.
  const pendingProposal = '';

  // Local-health: probe TCC-protected stores, surface a banner in the System
  // Alert slot, alert on state transitions, then persist state. Fully
  // fault-isolated — any error here must NEVER break the briefing run.
  try {
    const probe = await probeProtectedAccess();
    const health = await evaluateLocalHealth(probe, {
      reminders: data.reminders,
      imessage: data.imessages,
      calendar: data.calendar,
    });

    if (health.banner) {
      data.graphTokenHealth = [data.graphTokenHealth, health.banner].filter(Boolean).join('\n\n');
    }

    if (health.transitions.length) {
      const broke = health.transitions.filter(t => t.kind === 'broke').map(t => t.source);
      const recovered = health.transitions.filter(t => t.kind === 'recovered').map(t => t.source);
      let subject: string;
      if (broke.length && recovered.length) {
        subject = '⚠️ Briefing data source change';
      } else if (broke.length) {
        subject = `🛑 Briefing data source down: ${broke.join(', ')}`;
      } else {
        subject = `✅ Briefing data source recovered: ${recovered.join(', ')}`;
      }

      const bodyLines = [
        ...health.transitions.map(t => `- ${t.source}: ${t.kind}`),
        '',
        health.banner,
      ];

      // Include what self-heal automatically attempted this run, so the alert
      // names the real cause instead of blanket-blaming FDA. If self-heal fixed
      // the ABI issue, the fetches already recovered and this alert won't fire.
      if (healReport) {
        bodyLines.push('', 'Auto-heal this run:');
        for (const a of healReport.actions) {
          const mark = a.outcome === 'healed' ? '✓ fixed' : a.outcome === 'failed' ? '✗ could not fix' : '· ok';
          bodyLines.push(`  ${mark} — ${a.detail}${a.note ? ` (${a.note})` : ''}`);
        }
      }

      bodyLines.push(
        '',
        'If a source is STILL down after auto-heal, the likely cause is Full Disk Access revoked for the scheduled job — grant it to /bin/bash in System Settings → Privacy & Security, then run `npm run check-access`. (macOS blocks scripting this grant, so it is the one thing auto-heal cannot do.)',
      );

      await sendAlertEmail(subject, bodyLines.join('\n'));
    }

    await commitHealthState(health.degraded);
  } catch (err: any) {
    console.log(`[local-health] wiring error: ${err?.message || 'unknown'}`);
  }

  console.log('[briefing] sources fetched — generating briefing with Missions pipeline');
  const { body: briefing, subject } = await generateBriefingMissions({ ...data, pendingProposal }, isWeekend);

  const wordCount = briefing.split(/\s+/).length;
  // SKIP_SEND: verify the full pipeline (fetch → workers → assembler → validator)
  // completes and produces real content, WITHOUT delivering an email. Used for
  // testing the pipeline end-to-end. The rendered brief is written to disk so it
  // can be inspected.
  if (process.env.SKIP_SEND) {
    const outPath = `${homedir()}/briefing-data/_test-brief.md`;
    await writeFile(outPath, `# ${subject}\n\n${briefing}`, 'utf-8');
    console.log(`[briefing] SKIP_SEND set — ${wordCount} words — NOT sending. Wrote ${outPath}`);
  } else {
    console.log(`[briefing] briefing validated and condensed — ${wordCount} words — sending email`);
    await sendBriefing(briefing, date, subject, isWeekend);
  }

  // Archive and extract context for tomorrow (non-blocking)
  console.log('[briefing] saving context');
  await Promise.allSettled([
    archiveBriefing(briefing, date),
    saveContext(briefing),
    updateActionItems(briefing, data.email, data.reminders),
    trackRuleUsage(briefing, 'morning').catch(err => console.log('[rule-usage]', err.message)),
  ]);

  console.log('[briefing] done');
}

run().catch(console.error);
