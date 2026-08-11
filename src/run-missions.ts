/**
 * Run just the Missions version and send it.
 * npx tsx src/run-missions.ts
 */
import { config } from 'dotenv';
config({ override: true });

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { generateBriefingMissions } from './claude-missions';
import { getRecurringAlerts } from './claude';
import { sendBriefing } from './deliver';
import { fetchICal, fetchYesterdayCalendar } from './sources/ical';
import { fetchAppleMail } from './sources/applemail';
import { fetchReminders } from './sources/reminders';
import { fetchIMessages } from './sources/imessage';
import { fetchTLDR } from './sources/tldr';
import { fetchNotionProjects } from './sources/notion';
import { fetchIgorForecast } from './sources/igor-forecast';
import { fetchLuminate } from './sources/luminate';
import { fetchFeedback } from './sources/feedback';
import { fetchClaudeSessions } from './sources/claude-sessions';
import { fetchTeamsMessages } from './sources/teams';
import { fetchCollectionsReport } from './sources/collections';
import { fetchIndustryIntel } from './sources/industry-intel';
import { loadRollingContext } from './context';
import { loadActionItems } from './sources/action-items';

async function run() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;

  console.log(`[C: Missions] fetching sources...`);

  const calendar = await fetchICal().catch(() => '(unavailable)');
  const yesterdayCalendar = await fetchYesterdayCalendar().catch(() => '(unavailable)');
  const reminders = await fetchReminders().catch(() => '(unavailable)');
  const email = await fetchAppleMail().catch(() => '(unavailable)');
  const igorForecast = await fetchIgorForecast().catch(() => '(unavailable)');
  const luminate = await fetchLuminate().catch(() => '(unavailable)');

  const [imessages, tldr, notionProjects, feedback, rollingContext, claudeSessions, actionItems, teamsMessages, collectionsReport, industryIntel] = await Promise.allSettled([
    fetchIMessages(), fetchTLDR(), fetchNotionProjects(),
    fetchFeedback(), loadRollingContext(), fetchClaudeSessions(), loadActionItems(),
    fetchTeamsMessages(), fetchCollectionsReport(), fetchIndustryIntel(),
  ]);

  const v = (r: PromiseSettledResult<string>) => r.status === 'fulfilled' ? r.value : '';

  const data = {
    date, email, calendar, yesterdayCalendar, reminders,
    imessages: v(imessages), tldr: v(tldr), luminate,
    notionProjects: v(notionProjects),
    igorForecast, feedback: v(feedback), rollingContext: v(rollingContext),
    claudeSessions: v(claudeSessions),
    staffingSummary: await readFile(`${homedir()}/briefing-data/staffing-summary.txt`, 'utf-8').catch(() => ''),
    actionItems: v(actionItems), teamsMessages: v(teamsMessages),
    collectionsReport: v(collectionsReport),
    industryIntel: v(industryIntel),
    recurringAlerts: getRecurringAlerts(new Date(), email),
  };

  console.log('[C: Missions] generating...');
  const t = Date.now();
  const result = await generateBriefingMissions(data, isWeekend);
  console.log(`[C: Missions] done in ${((Date.now() - t) / 1000).toFixed(1)}s — ${result.body.split(/\s+/).length} words`);

  const subj = `[C: Missions] ${result.subject}`;
  await sendBriefing(result.body, date, subj, isWeekend);
  console.log('[C: Missions] ✓ sent');
}

run().catch(console.error);
