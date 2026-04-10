import { readFile, stat, writeFile as writeFileFs } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { runOsascript } from '../utils/retry-osascript';
import { graphGet, getUserEmail, isGraphConfigured } from './graph-client';

const CACHE_PATH = join(homedir(), 'briefing-data', 'email.txt');
const M365_CACHE_PATH = join(homedir(), 'briefing-data', 'm365-email.txt');

/** Check if a file was modified within the last N hours */
async function isFresh(path: string, maxAgeHours: number): Promise<boolean> {
  try {
    const s = await stat(path);
    const ageMs = Date.now() - s.mtimeMs;
    return ageMs < maxAgeHours * 3600 * 1000;
  } catch {
    return false;
  }
}

// Spam/marketing/noise to filter out
const FILTER_OUT = [
  // Shopping & retail
  'adidas', 'anthropologie', 'cozyearth', 'spiritjersey', 'taylorstitch',
  'freshcleantees', 'freshclean', 'snakeriverfarms', 'junehomesupply',
  'fromyouflowers', 'zulily', 'rowan', 'forrowan', 'wmscoshop',
  'dynamicstriking', 'beyond-power', 'chromeindustries', 'secretlab',
  'axelarigato', 'shoplofta', 'elmandrye', 'paige.com', 'casio-usa',
  'andoutcomethewolves', 'golfdigest',
  // Food & real estate
  'redfin', 'whole foods', 'wholefoods', 'casa vega', 'casa vegas',
  'toast-restaurants.com', 'simpang asia',
  // Kids/family spam
  'greenlight', 'camp wild folk',
  // Tech/tool alerts
  'posthog', 'zapier', 'citizen.com',
  // News/sports spam
  'heavy.com', 'twentytwowords', 'wordguru', 'mlbemail', 'akc.org',
  'fitdog', 'rottentomatoes',
  // Generic newsletters from personal (not industry)
  'substack.com',
  // Generic no-reply / auto
  'donotreply', 'do-not-reply', 'donotreplymychart',
  'no-reply@accounts', 'no-reply@email.claude',
  'no-reply@outlook.mail', 'quarantine@messaging.microsoft',
  'noreply', 'marketing@', 'promo@', 'deals@', 'offers@',
  'info@marketing', 'hello@mail.',
  // Apple relay addresses (all marketing forwarded through iCloud)
  'privaterelay.appleid.com',
  // Filter our own briefing emails
  'morning briefing',
  // Auto-generated
  'concursolutions', 'autonotification',
  'reaction daily digest',
  // Internal system threads Jonathan doesn't want
  'io last call', 'io on call', 'ace spotlight',
  'la.io@createadvertising.com', 'create io',
];

// Industry newsletters to KEEP even though they look like marketing
const KEEP_LIST = [
  'luminatedata.com',
  'ankler',
  'createadvertising.com',
  'glossi.io',
  'beehiiv.com',  // some industry newsletters use beehiiv
];

export async function fetchAppleMail(hoursBack = 18): Promise<string> {
  // Try live Graph API first (always fresh, works unattended)
  if (isGraphConfigured()) {
    try {
      const userEmail = getUserEmail();
      const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();

      // Fetch inbox
      const inbox = await graphGet(`/users/${userEmail}/messages`, {
        '$filter': `receivedDateTime ge ${cutoff}`,
        '$top': '50',
        '$select': 'subject,sender,bodyPreview,receivedDateTime,importance,hasAttachments',
        '$orderby': 'receivedDateTime desc',
      });

      // Fetch sent items (last 72h for cross-referencing)
      const sentCutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
      const sent = await graphGet(`/users/${userEmail}/mailFolders/sentItems/messages`, {
        '$filter': `sentDateTime ge ${sentCutoff}`,
        '$top': '30',
        '$select': 'subject,toRecipients,bodyPreview,sentDateTime',
        '$orderby': 'sentDateTime desc',
      });

      const lines: string[] = [];

      for (const msg of inbox.value || []) {
        const sender = msg.sender?.emailAddress;
        const from = sender ? `${sender.name} <${sender.address}>` : 'Unknown';
        const imp = msg.importance === 'high' ? ' [HIGH IMPORTANCE]' : '';
        const attach = msg.hasAttachments ? ' [HAS ATTACHMENTS]' : '';
        const preview = (msg.bodyPreview || '').replace(/\r?\n/g, ' ').slice(0, 300);
        lines.push(`[Create] From: ${from} — ${msg.subject}${preview ? ` | ${preview}` : ''}${attach}${imp}`);
      }

      for (const msg of sent.value || []) {
        const to = (msg.toRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ');
        const preview = (msg.bodyPreview || '').replace(/\r?\n/g, ' ').slice(0, 200);
        lines.push(`[Create / Sent] From: Jonathan Gitlin — ${msg.subject}${preview ? ` | ${preview}` : ''}`);
      }

      if (lines.length > 0) {
        console.log(`[email] Graph API: ${inbox.value?.length || 0} inbox + ${sent.value?.length || 0} sent`);
        // Write to M365 cache so other sources can cross-reference
        await writeFileFs(M365_CACHE_PATH, lines.join('\n'), 'utf-8').catch(() => {});
        return groupEmailThreads(filterEmails(lines.join('\n')));
      }
    } catch (err: any) {
      console.log(`[email] Graph API failed: ${err.message?.slice(0, 100)} — falling through`);
    }
  }

  // Strategy: use M365 cache ONLY if it's fresh (< 2 hours old).
  // If stale, fall through to Apple Mail which fetches live data.
  // This prevents a stale M365 cache from masking overnight emails.
  const m365Fresh = await isFresh(M365_CACHE_PATH, 2);

  if (m365Fresh) {
    try {
      const m365 = await readFile(M365_CACHE_PATH, 'utf-8');
      if (m365.trim()) {
        console.log('[email] using fresh M365 cache (< 2h old)');
        return groupEmailThreads(filterEmails(m365.trim()));
      }
    } catch {}
  } else {
    console.log('[email] M365 cache is stale or missing — falling through to Apple Mail');
  }

  // Try pre-run export cache — also check freshness
  const cacheFresh = await isFresh(CACHE_PATH, 2);
  if (cacheFresh) {
    try {
      const cached = await readFile(CACHE_PATH, 'utf-8');
      if (cached.trim()) {
        console.log('[email] using fresh email cache');
        return groupEmailThreads(filterEmails(cached.trim()));
      }
    } catch {}
  }

  // Fall back to AppleScript (reads inbox + deleted/archived folders)
  const script = `
tell application "Mail"
  set cutoff to (current date) - ${hoursBack} * hours
  set output to ""

  -- Get inbox messages
  try
    set msgs to (every message of inbox whose date received is greater than cutoff)
    repeat with msg in msgs
      try
        set s to sender of msg
        set subj to subject of msg
        set acctName to name of account of mailbox of msg
        set msgBody to ""
        try
          set msgBody to content of msg
          if length of msgBody > 500 then
            set msgBody to text 1 thru 500 of msgBody
          end if
        end try
        set hasAttach to ""
        try
          if (count of mail attachments of msg) > 0 then
            set attachNames to ""
            repeat with att in mail attachments of msg
              set attName to name of att
              set attachNames to attachNames & attName & ", "
              -- Save Maya's collections CSV/Excel for parsing
              if s contains "maya" and (subj contains "Collection" or subj contains "Cash Position") then
                if attName ends with ".csv" or attName ends with ".xlsx" or attName ends with ".xls" then
                  set savePath to (POSIX path of (path to home folder)) & "briefing-data/collections-report"
                  if attName ends with ".csv" then
                    set savePath to savePath & ".csv"
                  else
                    set savePath to savePath & ".xlsx"
                  end if
                  try
                    save att in POSIX file savePath
                  end try
                end if
              end if
            end repeat
            set hasAttach to " [ATTACHMENTS: " & attachNames & "]"
          end if
        end try
        set output to output & "[" & acctName & "] From: " & s & " — " & subj
        if msgBody is not "" then
          set output to output & " | " & msgBody
        end if
        set output to output & hasAttach & linefeed
      end try
    end repeat
  end try

  -- Get sent messages from each account
  repeat with acct in every account
    set acctName to name of acct
    repeat with mb in every mailbox of acct
      try
        set mbName to name of mb
        if mbName is "Sent Messages" or mbName is "Sent Items" or mbName is "Sent Mail" or mbName is "Sent" then
          set sentCutoff to (current date) - 72 * hours
          set msgs to (every message of mb whose date received is greater than sentCutoff)
          repeat with msg in msgs
            try
              set subj to subject of msg
              set recips to ""
              try
                repeat with r in to recipients of msg
                  set recips to recips & address of r & ", "
                end repeat
              end try
              set msgBody to ""
              try
                set msgBody to content of msg
                if length of msgBody > 300 then
                  set msgBody to text 1 thru 300 of msgBody
                end if
              end try
              set output to output & "[" & acctName & " / Sent] To: " & recips & " — " & subj
              if msgBody is not "" then
                set output to output & " | " & msgBody
              end if
              set output to output & linefeed
            end try
          end repeat
        end if
      end try
    end repeat
  end repeat

  -- Get trash/deleted/archived messages from each account
  repeat with acct in every account
    set acctName to name of acct
    repeat with mb in every mailbox of acct
      try
        set mbName to name of mb
        if mbName is "Deleted Messages" or mbName is "Deleted Items" or mbName is "Trash" or mbName is "Archive" or mbName is "All Mail" then
          set msgs to (every message of mb whose date received is greater than cutoff)
          repeat with msg in msgs
            try
              set s to sender of msg
              set subj to subject of msg
              set output to output & "[" & acctName & " / " & mbName & "] From: " & s & " — " & subj & linefeed
            end try
          end repeat
        end if
      end try
    end repeat
  end repeat

  return output
end tell`;

  const scriptPath = join(homedir(), 'briefing-data', 'mail.applescript');
  await writeFileFs(scriptPath, script, 'utf-8');

  try {
    const stdout = await runOsascript(scriptPath);
    return groupEmailThreads(filterEmails(stdout));
  } catch {
    return '(email unavailable — run mail export first)';
  }
}

function groupEmailThreads(filtered: string): string {
  const lines = filtered.split('\n').filter(Boolean);

  // Normalize subject for grouping: strip Re:, Fwd:, RE:, FW: prefixes
  function normalizeSubject(line: string): string {
    // Extract subject part (after " — " delimiter)
    const match = line.match(/— (.+?)(?:\s*\||$)/);
    if (!match) return line;
    return match[1]
      .replace(/^(Re|RE|Fwd|FW|Fw):\s*/g, '')
      .replace(/^(Re|RE|Fwd|FW|Fw):\s*/g, '') // double strip for "Re: Re:"
      .trim()
      .toLowerCase();
  }

  // Group by normalized subject
  const groups = new Map<string, string[]>();
  const groupOrder: string[] = [];

  for (const line of lines) {
    const key = normalizeSubject(line);
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key)!.push(line);
  }

  // Format output: single emails stay as-is, multi-email threads get grouped
  const output: string[] = [];
  for (const key of groupOrder) {
    const threadLines = groups.get(key)!;
    if (threadLines.length === 1) {
      output.push(threadLines[0]);
    } else {
      // Mark as thread with count
      output.push(`[THREAD: ${threadLines.length} messages] ${threadLines[0]}`);
      for (let i = 1; i < threadLines.length; i++) {
        output.push(`  ↳ ${threadLines[i]}`);
      }
    }
  }

  return output.join('\n');
}

function filterEmails(raw: string): string {
  const lines = raw.split('\n').filter(Boolean);

  const filtered = lines.filter(line => {
    const lower = line.toLowerCase();

    // Always keep emails from known important sources
    if (KEEP_LIST.some(k => lower.includes(k))) return true;

    // Filter out spam/noise
    if (FILTER_OUT.some(f => lower.includes(f))) return false;

    // Keep Exchange (Create) emails by default — they're work
    if (lower.startsWith('[exchange]')) return true;

    // Keep Google (Glossi) emails by default
    if (lower.startsWith('[google]')) return true;

    // For personal accounts, filter more aggressively
    // Only keep if it looks like a real person (has a real name, not a brand)
    return true;
  });

  // Map account names to context tags
  const mapped = filtered.map(line => {
    return line
      .replace('[Exchange]', '[Create]')
      .replace('[Google]', '[Glossi]')
      .replace('[iCloud]', '[Personal]')
      .replace('[gitlin.jonathan@gmail.com]', '[Personal]');
  });

  return mapped.join('\n') || '(no important emails)';
}
