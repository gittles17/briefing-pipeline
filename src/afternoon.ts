import { config } from 'dotenv';
config({ override: true });
import { fetchReminders } from './sources/reminders';
import { fetchIMessages } from './sources/imessage';
import { fetchAppleMail } from './sources/applemail';
import { fetchICal } from './sources/ical';
import { fetchNotionProjects } from './sources/notion';
import { fetchGlossiBoard } from './sources/glossi-board';
import { generateAfternoonSync, getRecurringAlerts } from './claude';
import { sendBriefing } from './deliver';
import { fetchTeamsMessages } from './sources/teams';
import { fetchIndustryIntel } from './sources/industry-intel';
import { loadRollingContext } from './context';
import { loadActionItems } from './sources/action-items';
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

  // Fetch AppleScript sources sequentially (macOS serializes osascript)
  console.log('[afternoon] fetching calendar...');
  const calendar = await fetchICal().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[afternoon] fetching reminders...');
  const reminders = await fetchReminders().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[afternoon] fetching apple mail...');
  const email = await fetchAppleMail().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[afternoon] fetching network sources...');
  const [imessages, notionProjects, glossiBoard, rollingContext, actionItems, teamsMessages, industryIntel] = await Promise.allSettled([
    fetchIMessages(8),  // Only last 8 hours for afternoon
    fetchNotionProjects(),
    fetchGlossiBoard(),
    loadRollingContext(),
    loadActionItems(),
    fetchTeamsMessages(),
    fetchIndustryIntel(),
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
    glossiBoard: glossiBoard.status === 'fulfilled' ? glossiBoard.value : '(unavailable)',
    rollingContext: rollingContext.status === 'fulfilled' ? rollingContext.value : '',
    recurringAlerts: getRecurringAlerts(new Date(), email.status === 'fulfilled' ? email.value : ''),
    actionItems: actionItems.status === 'fulfilled' ? actionItems.value : '',
    teamsMessages: teamsMessages.status === 'fulfilled' ? teamsMessages.value : '',
    industryIntel: industryIntel.status === 'fulfilled' ? industryIntel.value : '',
    morningBriefing,
  };

  console.log('[afternoon] sources fetched — generating afternoon sync with Opus');
  const { body, subject } = await generateAfternoonSync(data);

  const wordCount = body.split(/\s+/).length;
  console.log(`[afternoon] sync generated — ${wordCount} words — sending email`);
  await sendBriefing(body, date, subject, false, 'afternoon');

  console.log('[afternoon] done');
}

run().catch(console.error);
