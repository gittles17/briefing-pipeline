import { config } from 'dotenv';
config({ override: true });
import { fetchReminders } from './sources/reminders';
import { fetchIMessages } from './sources/imessage';
import { fetchAppleMail } from './sources/applemail';
import { fetchICal } from './sources/ical';
import { fetchNotionProjects } from './sources/notion';
import { getRecurringAlerts } from './claude';
import { generateAfternoonSyncMissions } from './claude-missions';
import { sendBriefing, sendAlertEmail } from './deliver';
import { fetchTeamsMessages } from './sources/teams';
import { fetchIndustryIntel } from './sources/industry-intel';
import { fetchReplyEngineStatus } from './sources/reply-engine-status';
import { fetchAurisStatus } from './sources/auris-status';
import { getGraphTokenHealth } from './sources/graph-client';
import { fetchFeedback } from './sources/feedback';
import { loadRollingContext } from './context';
import { loadActionItems } from './sources/action-items';
import { trackRuleUsage } from './sources/rule-usage';
import { probeProtectedAccess, evaluateLocalHealth, commitHealthState } from './sources/local-health';
import { runSelfHeal } from './sources/self-heal';
import { withTimeout } from './utils/with-timeout';
import { readFile } from 'fs/promises';
import { homedir } from 'os';

async function run() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  const isWeekend = [0, 6].includes(now.getDay());

  // Skip weekends — afternoon sync is workday only
  if (isWeekend) {
    console.log('[afternoon] weekend — skipping afternoon sync');
    return;
  }

  console.log(`[afternoon] starting — ${date}`);

  // SELF-HEAL pre-flight (same as morning): repair the environment before any
  // fetch runs. Fault-isolated — never breaks the sync.
  await runSelfHeal().catch(err => console.log('[self-heal] wiring error:', err?.message || 'unknown'));

  // Reminders is AppleScript-based (cache-first but may fall through) — run
  // sequentially first to avoid osascript contention. Everything else (Graph
  // API + network + local) runs in one parallel batch.
  console.log('[afternoon] fetching reminders (AppleScript, sequential)...');
  const reminders = await fetchReminders().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[afternoon] fetching remaining sources in parallel...');
  const [calendar, email, imessages, notionProjects, rollingContext, actionItems, teamsMessages, industryIntel, feedback, replyEngineStatus, aurisStatus] = await Promise.allSettled([
    withTimeout(fetchICal(), 120000, 'calendar'),
    withTimeout(fetchAppleMail(), 120000, 'applemail'),
    withTimeout(fetchIMessages(8), 120000, 'imessage'),  // Only last 8 hours for afternoon
    withTimeout(fetchNotionProjects(), 120000, 'notion'),
    withTimeout(loadRollingContext(), 60000, 'rolling-context'),
    withTimeout(loadActionItems(), 60000, 'action-items'),
    withTimeout(fetchTeamsMessages(), 120000, 'teams'),
    withTimeout(fetchIndustryIntel(), 120000, 'industry-intel'),
    withTimeout(fetchFeedback(), 90000, 'feedback'),
    withTimeout(fetchReplyEngineStatus(), 60000, 'reply-engine'),
    withTimeout(fetchAurisStatus(), 120000, 'auris'),
  ]);

  // Load this morning's briefing for context
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let morningBriefing = '';
  try {
    morningBriefing = await readFile(`${homedir()}/briefing-data/archive/${todayKey}.md`, 'utf-8');
  } catch {}

  const data = {
    date,
    email: email.status === 'fulfilled' ? email.value : '(unavailable)',
    calendar: calendar.status === 'fulfilled' ? calendar.value : '(unavailable)',
    reminders: reminders.status === 'fulfilled' ? reminders.value : '(unavailable)',
    imessages: imessages.status === 'fulfilled' ? imessages.value : '(unavailable)',
    notionProjects: notionProjects.status === 'fulfilled' ? notionProjects.value : '(unavailable)',
    rollingContext: rollingContext.status === 'fulfilled' ? rollingContext.value : '',
    recurringAlerts: getRecurringAlerts(new Date(), email.status === 'fulfilled' ? email.value : ''),
    actionItems: actionItems.status === 'fulfilled' ? actionItems.value : '',
    teamsMessages: teamsMessages.status === 'fulfilled' ? teamsMessages.value : '',
    industryIntel: industryIntel.status === 'fulfilled' ? industryIntel.value : '',
    feedback: feedback.status === 'fulfilled' ? feedback.value : '',
    replyEngineStatus: replyEngineStatus.status === 'fulfilled' ? replyEngineStatus.value : '',
    aurisStatus: aurisStatus.status === 'fulfilled' ? aurisStatus.value : '',
    graphTokenHealth: await getGraphTokenHealth().catch(() => ''),
    morningBriefing,
  };

  // Local-health: probe TCC-protected stores, surface a banner in the System
  // Alert slot, alert on state transitions, then persist state. Morning and
  // afternoon share the SAME source-health.json — the transition logic only
  // alerts on state change, so a source down all day won't double-alert. Fully
  // fault-isolated — any error here must NEVER break the afternoon run.
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
        '',
        'Remediation: grant Full Disk Access to /bin/bash in System Settings → Privacy & Security, then run `npm run check-access`.',
      ];

      await sendAlertEmail(subject, bodyLines.join('\n'));
    }

    await commitHealthState(health.degraded);
  } catch (err: any) {
    console.log(`[local-health] wiring error: ${err?.message || 'unknown'}`);
  }

  console.log('[afternoon] sources fetched — generating afternoon sync with Missions pipeline');
  const { body, subject } = await generateAfternoonSyncMissions(data);

  const wordCount = body.split(/\s+/).length;
  console.log(`[afternoon] sync generated — ${wordCount} words — sending email`);
  await sendBriefing(body, date, subject, false, 'afternoon');

  // Track rule usage after send (non-blocking)
  trackRuleUsage(body, 'afternoon').catch(err => console.log('[rule-usage]', err.message));

  console.log('[afternoon] done');
}

run().catch(console.error);
