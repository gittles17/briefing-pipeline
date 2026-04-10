import { ImapFlow } from 'imapflow';
import { writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { runOsascript } from '../utils/retry-osascript';

export async function fetchLuminate(): Promise<string> {
  // Try Apple Mail first (Luminate goes to Create/Exchange account)
  const appleMail = await fetchFromAppleMail();
  if (appleMail) return appleMail;

  // Fall back to Gmail IMAP
  const gmail = await fetchFromGmail();
  if (gmail) return gmail;

  return '(no recent Luminate roundup found)';
}

async function fetchFromAppleMail(): Promise<string | null> {
  const script = `
tell application "Mail"
  set cutoff to (current date) - 7 * days
  set output to ""
  set foundMsg to missing value
  set latestDate to date "Monday, January 1, 2024 at 12:00:00 AM"

  repeat with acct in every account
    repeat with mb in every mailbox of acct
      try
        set msgs to (every message of mb whose date received is greater than cutoff and sender contains "luminate")
        repeat with msg in msgs
          try
            set subj to subject of msg
            if date received of msg > latestDate then
              set latestDate to date received of msg
              set foundMsg to msg
            end if
          end try
        end repeat
      end try
    end repeat
  end repeat

  if foundMsg is not missing value then
    set subj to subject of foundMsg
    set bod to content of foundMsg
    return "Subject: " & subj & linefeed & linefeed & bod
  else
    return ""
  end if
end tell`;

  try {
    const scriptPath = join(homedir(), 'briefing-data', 'luminate.applescript');
    await writeFile(scriptPath, script, 'utf-8');
    const stdout = await runOsascript(scriptPath);
    const result = stdout.trim();
    if (!result) return null;
    return extractLuminateHighlights(result);
  } catch {
    return null;
  }
}

async function fetchFromGmail(): Promise<string | null> {
  try {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.SMTP_USER!,
        pass: process.env.SMTP_PASS!,
      },
      logger: false,
    });

    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      let latestBody = '';

      for await (const msg of client.fetch(
        { since, from: 'luminatedata.com' },
        { envelope: true, source: true }
      )) {
        if (!msg.envelope) continue;
        const subject = msg.envelope.subject || '';

        if (subject.toLowerCase().includes('roundup') || subject.toLowerCase().includes('luminate')) {
          const raw = msg.source?.toString('utf-8') || '';
          const textMatch = raw.match(/Content-Type: text\/plain[\s\S]*?\n\n([\s\S]*?)(?:\n--|\n\n--)/);
          if (textMatch) {
            latestBody = decodeQuotedPrintable(textMatch[1]);
          }
        }
      }

      if (!latestBody) return null;
      return extractLuminateHighlights(latestBody);
    } finally {
      lock.release();
      await client.logout();
    }
  } catch {
    return null;
  }
}

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/=3D/g, '=');
}

function extractLuminateHighlights(body: string): string {
  const lines = body.split('\n');
  const highlights: string[] = [];
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (/scripted series pick ups/i.test(trimmed)) {
      currentSection = 'NEW SERIES PICKUPS';
      highlights.push(`\n${currentSection}:`);
    } else if (/unscripted series pick ups/i.test(trimmed)) {
      currentSection = 'UNSCRIPTED PICKUPS';
      highlights.push(`\n${currentSection}:`);
    } else if (/series renewals/i.test(trimmed)) {
      currentSection = 'RENEWALS';
      highlights.push(`\n${currentSection}:`);
    } else if (/series cancellations|not renewed/i.test(trimmed) && !currentSection.includes('CANCEL')) {
      currentSection = 'CANCELLATIONS';
      highlights.push(`\n${currentSection}:`);
    } else if (/tv premieres|new series premieres/i.test(trimmed)) {
      currentSection = 'PREMIERES';
      highlights.push(`\n${currentSection}:`);
    } else if (/film releases|theatrical/i.test(trimmed)) {
      currentSection = 'FILM RELEASES';
      highlights.push(`\n${currentSection}:`);
    } else if (/box office/i.test(trimmed)) {
      currentSection = 'BOX OFFICE';
      highlights.push(`\n${currentSection}:`);
    }

    const seriesMatch = trimmed.match(/^Series:\s*(.+?)(?:<|$)/);
    if (seriesMatch) {
      const seriesName = seriesMatch[1].trim();
      highlights.push(`- ${seriesName}`);
    }

    if (/^Platform:\s/i.test(trimmed) || /^Network:\s/i.test(trimmed)) {
      const platform = trimmed.split(':')[1]?.trim();
      if (platform && highlights.length > 0) {
        highlights[highlights.length - 1] += ` (${platform})`;
      }
    }

    if (/^(Greenlight|Renewal) Date:/i.test(trimmed)) {
      const date = trimmed.split(':').slice(1).join(':').trim();
      if (highlights.length > 0) {
        highlights[highlights.length - 1] += ` — ${date}`;
      }
    }

    const filmMatch = trimmed.match(/^Film:\s*(.+?)(?:<|$)/);
    if (filmMatch) {
      highlights.push(`- ${filmMatch[1].trim()}`);
    }
  }

  return highlights.join('\n') || body.substring(0, 2000);
}
