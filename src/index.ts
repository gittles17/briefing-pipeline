import { config } from 'dotenv';
config({ override: true });
import { fetchTLDR } from './sources/tldr';
import { fetchReminders } from './sources/reminders';
import { fetchIMessages } from './sources/imessage';
import { fetchAppleMail } from './sources/applemail';
import { fetchLuminate } from './sources/luminate';
import { fetchICal, fetchYesterdayCalendar } from './sources/ical';
import { fetchNotionProjects } from './sources/notion';
import { fetchGlossiBoard } from './sources/glossi-board';
import { fetchIgorForecast } from './sources/igor-forecast';
import { generateBriefing, getRecurringAlerts, validateAndCondense } from './claude';
import { sendBriefing } from './deliver';
import { fetchFeedback } from './sources/feedback';
import { fetchClaudeSessions } from './sources/claude-sessions';
import { fetchTeamsMessages } from './sources/teams';
import { fetchGlossiCashflow } from './sources/glossi-cashflow';
import { fetchCollectionsReport } from './sources/collections';
import { fetchIndustryIntel } from './sources/industry-intel';
import { loadRollingContext, archiveBriefing, saveContext } from './context';
import { loadActionItems, updateActionItems } from './sources/action-items';
import { readFile } from 'fs/promises';
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

async function run() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  const isWeekend = [0, 6].includes(now.getDay()); // 0=Sun, 6=Sat

  console.log(`[briefing] starting — ${date}${isWeekend ? ' (weekend mode)' : ''}`);

  // Refresh contacts for iMessage name resolution
  await refreshContacts();

  // Fetch AppleScript sources sequentially — macOS serializes osascript calls,
  // so running them in parallel causes each to wait for the others and timeout.
  // Calendar and Reminders are the slowest (~60-90s each on Mac Studio).
  console.log('[briefing] fetching calendar...');
  const calendar = await fetchICal().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[briefing] fetching yesterday calendar...');
  const yesterdayCalendar = await fetchYesterdayCalendar().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[briefing] fetching reminders...');
  const reminders = await fetchReminders().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[briefing] fetching apple mail...');
  const email = await fetchAppleMail().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[briefing] fetching igor forecast...');
  const igorForecast = await fetchIgorForecast().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[briefing] fetching luminate...');
  const luminate = await fetchLuminate().then(v => ({ status: 'fulfilled' as const, value: v })).catch(() => ({ status: 'rejected' as const, reason: new Error('failed') }));

  console.log('[briefing] fetching network sources...');
  const [imessages, tldr, notionProjects, glossiBoard, feedback, rollingContext, claudeSessions, actionItems, teamsMessages, glossiCashflow, collectionsReport, industryIntel] = await Promise.allSettled([
    fetchIMessages(),
    fetchTLDR(),
    fetchNotionProjects(),
    fetchGlossiBoard(),
    fetchFeedback(),
    loadRollingContext(),
    fetchClaudeSessions(),
    loadActionItems(),
    fetchTeamsMessages(),
    fetchGlossiCashflow(),
    fetchCollectionsReport(),
    fetchIndustryIntel(),
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
    glossiBoard: glossiBoard.status === 'fulfilled' ? glossiBoard.value : '(unavailable)',
    igorForecast: igorForecast.status === 'fulfilled' ? igorForecast.value : '(unavailable)',
    feedback: feedback.status === 'fulfilled' ? feedback.value : '',
    rollingContext: rollingContext.status === 'fulfilled' ? rollingContext.value : '',
    recurringAlerts: getRecurringAlerts(new Date(), email.status === 'fulfilled' ? email.value : ''),
    claudeSessions: claudeSessions.status === 'fulfilled' ? claudeSessions.value : '',
    staffingSummary: await readFile(`${homedir()}/briefing-data/staffing-summary.txt`, 'utf-8').catch(() => ''),
    actionItems: actionItems.status === 'fulfilled' ? actionItems.value : '',
    teamsMessages: teamsMessages.status === 'fulfilled' ? teamsMessages.value : '',
    glossiCashflow: glossiCashflow.status === 'fulfilled' ? glossiCashflow.value : '',
    collectionsReport: collectionsReport.status === 'fulfilled' ? collectionsReport.value : '',
    industryIntel: industryIntel.status === 'fulfilled' ? industryIntel.value : '',
  };

  console.log('[briefing] sources fetched — generating briefing with Opus');
  const { body: briefing, subject } = await generateBriefing(data, isWeekend);

  const wordCount = briefing.split(/\s+/).length;
  console.log(`[briefing] briefing validated and condensed — ${wordCount} words — sending email`);
  await sendBriefing(briefing, date, subject, isWeekend);

  // Archive and extract context for tomorrow (non-blocking)
  console.log('[briefing] saving context');
  await Promise.allSettled([
    archiveBriefing(briefing, date),
    saveContext(briefing),
    updateActionItems(briefing, data.email, data.reminders),
  ]);

  console.log('[briefing] done');
}

run().catch(console.error);
