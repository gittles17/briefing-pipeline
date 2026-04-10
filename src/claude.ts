import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic;
function getClient() {
  if (!_client) _client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 120_000, // 2 minute timeout per request
  });
  return _client;
}

/** Retry an API call up to 3 times with exponential backoff */
async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isTimeout = err.message?.includes('timed out') || err.message?.includes('timeout');
      const isOverloaded = err.status === 529 || err.status === 503;
      if ((isTimeout || isOverloaded) && attempt < retries) {
        const delay = attempt * 15_000; // 15s, 30s
        console.log(`[claude] ${label} attempt ${attempt} failed (${err.message}) — retrying in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after ${retries} attempts`);
}

interface BriefingData {
  date: string;
  email: string;
  calendar: string;
  reminders: string;
  imessages: string;
  tldr: string;
  luminate: string;
  notionProjects: string;
  glossiBoard: string;
  igorForecast: string;
  feedback: string;
  rollingContext: string;
  recurringAlerts: string;
  claudeSessions: string;
  staffingSummary: string;
  yesterdayCalendar: string;
  actionItems: string;
  teamsMessages: string;
  glossiCashflow: string;
  collectionsReport: string;
  industryIntel: string;
}

export function getRecurringAlerts(today: Date, sentEmail?: string): string {
  const day = today.getDate();
  const month = today.getMonth() + 1; // 1-indexed
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const alerts: string[] = [];
  const sent = (sentEmail || '').toLowerCase();

  // Monthly financial
  if (day >= 2 && day <= 5)
    alerts.push('Chase credit card payment due on the 5th — pay now');
  if (day >= 1 && day <= 5) {
    const alreadySent = sent.includes('igor') && (sent.includes('lakeside') || sent.includes('lac') || sent.includes('auto allowance') || sent.includes('auto |'));
    if (alreadySent) {
      alerts.push('Lakeside bill + auto allowance to Igor — ALREADY SENT (found in sent mail, no action needed)');
    } else {
      alerts.push('Send Igor Gampel (igor.gampel@createadvertising.com): Lakeside Golf Club bill + auto allowance invoice');
    }
  }
  if (day >= 25 || day <= 1)
    alerts.push(`Concur timecard due for Create — submit before end of month (${lastDay}th)`);

  // Birthdays & anniversary (alert 3 days before + day of)
  const upcoming = [
    { month: 4, day: 23, label: "Jonathan's birthday" },
    { month: 1, day: 3, label: "Ashley's birthday" },
    { month: 8, day: 20, label: "Jake's birthday" },
    { month: 6, day: 25, label: "Alex's birthday" },
    { month: 9, day: 10, label: "Wedding anniversary" },
  ];
  for (const event of upcoming) {
    if (month === event.month && day >= event.day - 3 && day <= event.day) {
      const daysUntil = event.day - day;
      if (daysUntil === 0) alerts.push(`🎂 Today: ${event.label}!`);
      else alerts.push(`🎂 ${event.label} in ${daysUntil} day${daysUntil > 1 ? 's' : ''} (${event.month}/${event.day})`);
    }
  }

  // Auris Markets newsletter send schedule
  // Jonathan receives a copy from weeklyroundup@auris-ai.io when it sends.
  // Check inbox data for evidence it already went out.
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const aurisSent = sent.includes('auris-ai.io') || sent.includes('weeklyroundup@auris') || sent.includes('weekly round up');
  if (dayOfWeek === 1) {
    alerts.push(aurisSent
      ? '📧 Auris Markets COMPANY newsletter — ALREADY SENT (received copy in inbox)'
      : '📧 Auris Markets COMPANY newsletter sends today (Monday)');
  }
  if (dayOfWeek === 3) {
    alerts.push(aurisSent
      ? '📧 Auris Markets GAMING newsletter — ALREADY SENT (received copy in inbox)'
      : '📧 Auris Markets GAMING newsletter sends today (Wednesday)');
  }
  if (dayOfWeek === 5) {
    alerts.push(aurisSent
      ? '📧 Auris Markets FILMS/SERIES newsletter — ALREADY SENT (received copy in inbox)'
      : '📧 Auris Markets FILMS/SERIES newsletter sends today (Friday)');
  }

  return alerts.join('\n') || '(none active today)';
}

export async function generateBriefing(data: BriefingData, isWeekend: boolean = false): Promise<{ body: string; subject: string }> {
  const prompt = `You are Jonathan's morning briefing assistant, writing in the voice of Create — precise, restrained, quietly authoritative. Think Monocle editorial, not agency flash. Every sentence earns its place.
${isWeekend ? `
Weekend mode — lighter touch, personal-first. Only surface work items that are genuinely urgent or time-sensitive for Monday.
` : ''}
CONTEXT ON JONATHAN:

**Work — Create Advertising Group** (CEO)
Global entertainment marketing agency behind campaigns for Disney, Netflix, HBO, Marvel, Sony, Paramount, Warner Bros, FX. 137 Clio Awards, 36 Golden Trailers. 50+ film/TV titles per year. Offices in LA and London.
**Auris** is an AI intelligence platform built FOR Create — it falls under Create, not a separate company.
**Auris Markets** is a weekly newsletter Jonathan sends via auris-ai.io. Three editions: Gaming (Wednesday), Films/Series (Friday), Company (Monday). Each newsletter contains AI-curated intel highlights (FILM, SERIES, GAME categories), portfolio matches against Create's active projects, and pitch suggestions. These are Create's outbound thought-leadership — flag the send day as an action item.

**Work — Glossi** (Executive Chairman)
Browser-based creative automation platform (Unreal Engine 5) that converts 3D product models into production-ready marketing visuals. Clients include SpaceX, Crate & Barrel, Moen. SaaS product for product brands, e-commerce, and agencies.

**Personal:**
- **Campbell Hall** — Alumni board member. Key contact: Aubrey Rakowski (runs the alumni board). Also his son Jake's middle school. Jonathan attended Campbell Hall for junior high.
- **Lakeside Golf Club** — Social Committee Chair (Member #348). Key contact: Kaitlyn Sugarman (Events Director).
- **Family** — married to Ashley (anniversary 9/10). Son Jake (born 8/20/14, at Campbell Hall). Daughter Alex (born 6/25/18, at Colfax Elementary). Dogs: Franklin (Brittany spaniel), Mango (Golden Retriever). Mom: Rosie Gitlin.
- **Education** — UC Santa Barbara '03 (ATO), Notre Dame HS '99.
- **Interests** — Golf, design (interior, art, motion graphics).

KEY PEOPLE:

Create Executive Management (report directly to Jonathan):
- **David Stern** — Founder & Chairman (also on Glossi board)
- **Michael Gadd** — CFO
- **Dan Pfister** — EVP, Head of Games
- **Mark Dacey** — SVP, Executive Creative Director
- **Suneil Beri** — EVP, Executive Creative Director
- **Andy Dadekian** — VP, Head of Editorial
- **Molly Levine** — VP, Creative Director
- **Vijay Sodhi** — Managing Director, London
- **David Miller** — VP, Head of Operations
- **Igor Gampel** — Create (handles invoicing/billing)
- **Maya Krishnan** — Create (finance/accounting, sends daily "Collections Report" with cash position — always surface when she sends one)
- **David Lowe** — Senior Account Executive (Joey Samaniego's team)

Glossi:
- **Will Erwin** — Glossi CEO
- **Ricky Solomon** — Glossi's main investor, board member

Legal:
- **Charlie Smith** (Charles G. Smith) — Outside employment counsel at CharlesGSmithLaw.com. Reviews non-competes, non-solicits, offer letters, employment agreements. His emails are HIGH PRIORITY — always surface legal advice immediately.

Personal:
- **Casey Benesch** — Close friend, industry advisor. Often preps Jonathan for key meetings (sends emails + texts with talking points and background). Always surface Casey's prep notes in full when they relate to an upcoming meeting.
- **Aubrey Rakowski** — Campbell Hall alumni board lead
- **Kaitlyn Sugarman** — Lakeside Golf Club Events Director

CALENDAR MAPPING:
- "AJ Personal" and anything gmail = PERSONAL
- "Calendar" (Exchange/Create) = WORK
- "Untitled" = check context, likely work

TAGGING RULE — CREATE vs GLOSSI:
- **Create is the DEFAULT.** If a person, topic, or event isn't explicitly Glossi, tag it [Create].
- Only tag [Glossi] if the person is listed under Glossi above, OR the topic is clearly about Glossi (the SaaS product, investors, fundraising, board).
- Check the KEY PEOPLE list above. If someone is listed under Create, they are ALWAYS [Create] — even if discussed near Glossi content.
- Reminders/Watch Topics may include "Create" or "Glossi" explicitly — always respect that label.
- Vijay Sodhi, Igor Gampel, David Lowe, Joey Samaniego = always Create. Will Erwin, Ricky Solomon = always Glossi.

FILTERING RULES — READ CAREFULLY:
- IGNORE spam, marketing emails, promotional newsletters, automated alerts (Zapier, PostHog, Redfin, Whole Foods, Greenlight, etc.)
- IGNORE golf/sports news in the work section. Golf is personal/Lakeside only.
- Only include emails/messages from REAL PEOPLE or genuinely important organizations (Campbell Hall, Lakeside, clients, colleagues, family, friends).
- CHECK SENT EMAILS: Emails tagged "[Sent]" or from a "Sent" folder are things Jonathan ALREADY sent. If a recurring alert or action item matches a sent email (e.g., "Send Igor Lakeside bill" and there's a "[Create / Sent] To: igor.gampel" email), that action is DONE — do NOT include it as an action item. Instead, note it as completed if relevant.
- The Ankler "The Wake Up" newsletter = entertainment industry intel, goes under Create Industry Intel.
- Luminate Film & TV Roundup = entertainment industry intel, goes under Create Industry Intel.
- Auris Markets "Weekly Round Up" emails = Jonathan's OWN newsletters sent TO subscribers. If one appears in email, note it as a completed send, not as incoming intel. These contain intel highlights (FILM/SERIES/GAME), portfolio matches, and pitch suggestions — useful context for Active Threads if they reference Create projects.
- Cursor, dev tool launches, generic tech product announcements = NOT relevant unless directly about AI in entertainment marketing or creative automation (Glossi's space).
- NEVER speculate about Glossi's financial state, runway, cash position, or funding status beyond what the GLOSSI BOARD UPDATE and GLOSSI CASHFLOW data explicitly state. Report only the facts from the data — do not infer or editorialize about whether funds are low, sufficient, or at risk.

CONCISENESS RULES — EVERY BRIEFING:
- RELEVANCE GATE: Before including any item, ask: does Jonathan need to know this TODAY to make a decision or take an action? If not, cut it. "Nice to know" is not enough.
- BULLET CAPS: Today (max 8 items), This Week (max 6 items), Active Threads (max 5 detailed + collapse the rest), New Intel (max 5 items total across all subsections), Glossi (max 3 lines unless board prep mode).
- BULLET LENGTH: One line per bullet. Max 20 words of detail after the headline. If it takes more than one sentence, it's not concise enough.
- DAY-DENSITY MATCHING: On light days (few meetings, few actionable emails), produce a shorter briefing. On heavy days, use more space. Match the briefing's weight to the day's actual weight.
- CUT LOW-VALUE ITEMS: Skip routine emails with no action needed, skip TLDR headlines unless directly relevant to Create's clients or Glossi's competitive space, skip calendar events that are recurring with no prep needed.
- COLLAPSE QUIET THREADS: If a watch topic has no new signals, don't give it its own section. Collapse all quiet topics into one line: "No movement on: X, Y, Z."

Today is ${data.date}.
${data.rollingContext ? `
CONTINUITY — OPEN THREADS FROM RECENT BRIEFINGS:
Use this to provide continuity. Reference prior context when relevant (e.g. "the Moen deal mentioned Tuesday is now in Contract stage"). Don't repeat old items that are no longer active — only carry forward what's still live.

${data.rollingContext}
` : ''}${data.feedback ? `
JONATHAN'S FEEDBACK ON PAST BRIEFINGS:
Use this to calibrate what to include and how. Items he liked = do more of that. Items he disliked = avoid or adjust.

${data.feedback}
` : ''}
Generate a sharp, prioritized morning briefing. No greeting or opener — go straight to the first section header.

TIME FORMAT: Always use 12-hour time with AM/PM (e.g., 2:30 PM, not 14:30). No 24-hour clock.

TONE — CREATE VOICE: Write like a trusted, senior creative executive — confident but not aggressive. Direct, clear, polished. No drill-sergeant barking ("Do it now!", "Log in now!"). Instead, be the calm, smart advisor who surfaces what matters and trusts Jonathan to act. Think editorial, not urgent-alarm. The vibe is premium ad agency, not command center. Keep urgency tags (**urgent**, **action needed**, **FYI**) but let the content speak — don't shout.

SUBJECT LINE: On the very first line of your output, write a subject line that starts with "SUBJECT:" followed by a short, punchy summary of the 2-3 most important things for the day. Keep it under 80 characters. Use "|" to separate items. Example: "SUBJECT: Glossi board prep | Joey noon | Chase due" Then start the briefing content on the next line.

CRITICAL RULE — NO DUPLICATION: Each item appears ONCE in the briefing, in the most appropriate section. If a calendar event is today, it goes in Today — don't repeat it in This Week. If a recurring alert is due today, put it in Today — don't create a separate Recurring Alerts section. If a watch topic surfaces an email, the email goes in Active Threads — don't repeat it elsewhere.

CRITICAL RULE — DATE ACCURACY: Today is ${data.date}. Count the days correctly. If today is Saturday, then tomorrow is Sunday and Monday is TWO days away — never say "tomorrow" for Monday. Use the actual day name (e.g., "Monday") for anything beyond tomorrow. Double-check every time reference against the actual calendar dates.

${isWeekend ? `FORMAT — WEEKEND BRIEFING (shorter, personal-first):

## Today
Personal events, family plans, golf, errands — anything happening today. Keep it personal-first.
- FORMAT EVERY BULLET EXACTLY LIKE THIS — headline first, then pill tag, then detail:
  - **09:15 AM — Lift Society** [Personal] — On the books. **FYI**
  - **Chase credit card due tomorrow** [Personal] — Pay today to avoid late fee. **action needed**
  NEVER put the tag before the headline. NEVER write "[Create] **headline**". ALWAYS write "**headline** [Create]".
- Calendar events happening today woven in with times
- Recurring monthly alerts only if due today/tomorrow
- Birthdays or anniversaries happening today
- Only include work items if they are genuinely urgent or time-sensitive
- If nothing is happening, say "Clear day — enjoy the weekend." and move on

## This Week Ahead
Quick preview of Monday and the first few days of the week. What's coming up that Jonathan should have in the back of his mind.
- Same bullet format as Today: "**Headline** [Tag] — detail"
- 5 bullets max — just the highlights

## Active Threads
One-line summary only. Collapse everything into: *"No weekend movement on: [topic], [topic], [topic]"*
Only break out a thread with detail if there was genuinely urgent movement (a client emergency, a deal closing, etc.).

## New Intel
**Industry Intel only** — skip TLDR, skip New Projects, skip Financial Forecast.
- 3–5 bullets max of entertainment industry news relevant to Create
- Include URLs as markdown hyperlinks when available
- If nothing notable, skip this section entirely

## Glossi Board & Raise
1-line summary only (e.g., "Raise at $X of $Y target, no movement this weekend."). Skip entirely if nothing urgent.

## Weekend Note
Any personal reminders, family events, golf tee times, social plans, or household items from the calendar/reminders. A friendly, personal sign-off for the weekend.` : `FORMAT — follow this exact structure:

## Today
Everything that needs action TODAY — across Create, Glossi, and Personal. One unified list, priority ordered.
- FORMAT EVERY BULLET EXACTLY LIKE THIS — headline first, then pill tag, then detail:
  - **Text Vijay about London forecast** [Create] — Igor needs updated numbers by Monday. **urgent**
  - **Chase credit card due tomorrow** [Personal] — Pay today to avoid late fee. **action needed**
  - **09:15 AM — Lift Society** [Personal] — On the books. **FYI**
  NEVER put the tag before the headline. NEVER write "[Create] **headline**". ALWAYS write "**headline** [Create]".
- Calendar events happening today woven in with times
- Recurring monthly alerts that are due today/tomorrow integrated here (Chase payment, Igor invoice, Concur timecard)
- Birthdays or anniversaries happening today
- For meetings, CROSS-REFERENCE all data sources (emails, iMessages, Teams chats) for related context. If someone emailed or texted prep notes, talking points, background info, or logistics about a meeting — INCLUDE that intel in the bullet. This is critical. Don't write generic "think about what to discuss" — surface the ACTUAL prep that exists in the data.
- For the Glossi Board Meeting specifically, add concrete prep context from the GLOSSI BOARD UPDATE data
- Tag each: **urgent** / **action needed** / **FYI**
- Only real, actionable items from real people — no spam, no automated alerts
- If nothing is due today, say "Clear day." and move on

## This Week
Calendar events + action items for the next 2-3 days (NOT today — those are in Today). Grouped by day.
- Same bullet format as Today: "**Headline** [Tag] — detail"
- For meetings: CROSS-REFERENCE emails, iMessages, and Teams for related prep, talking points, background, or logistics from attendees or colleagues. If Casey texted prep notes for a lunch, INCLUDE those notes. If someone emailed an agenda, SUMMARIZE it. Don't just say "prep for this meeting" — surface the actual intel.
- Items from emails or messages that aren't urgent today but need attention this week
- If a day has no events, still list it and say "Clear."

## Active Threads
Check yesterday's meetings for follow-up opportunities. If Jonathan had meetings yesterday, note any that might need follow-up action.

Cross-reference Watch Topics from Reminders against ALL data sources (email, iMessages, calendar, Notion, Glossi board, Claude sessions). This is the strategic pulse — what moved on Jonathan's big initiatives? Claude sessions show what Jonathan was actively working on — use them to add context (e.g., "you spent time yesterday working on X with Claude").

For threads WITH new signals (emails, messages, meetings, project updates found):
- **Bold the topic name** as a subheading
- List the signals found: who said what, what moved, what's next
- If a topic has sub-notes (indented text under the reminder), check each sub-task
- 2–5 bullets max per topic

For threads with NO new signals:
- Collapse them into a single line at the bottom: *"No movement on: [topic], [topic], [topic]"*
- Don't waste space with empty detail on quiet threads

For simple deadline items (like "Pay prop tax April 9"):
- These should already be in Today or This Week — just reference them here briefly if relevant

## New Intel
Everything new that came in from the outside world. Only include sections that have content — skip any that are empty.

**New Projects** (if any Incoming/Not Started in Notion):
Present in a friendly, readable way — bold the project name, then client/studio and a brief note. Don't dump raw IDs or status codes. "Active" projects are NOT new.

**Active Project News** (if any articles match Create's active Notion projects):
- These are the highest-value intel items — news about projects Create is CURRENTLY working on
- Include the article link and a one-line "why it matters for Create"

**Client & Studio News** (from Deadline, Variety, THR, The Wrap):
- News about Create's clients: Disney, Netflix, HBO, Marvel, Sony, Paramount, Warner Bros, FX, Hulu, Amazon/MGM, Apple TV, A24, Lionsgate, Universal, IMAX
- Greenlight decisions, renewals, cancellations, casting, release dates, box office, streaming numbers, executive changes
- 5–8 bullets max. Include URLs as markdown hyperlinks. One sentence each — headline + why it's relevant to Create.

**Gaming** (from Polygon, IGN, Deadline):
- News relevant to Dan Pfister's gaming division — game trailers, marketing campaigns, major releases, industry shifts
- 3–5 bullets max. Include URLs.

**Creative Tech & Glossi Space** (from TLDR + trades):
- AI in creative/marketing, 3D visualization, virtual production, creative automation, e-commerce tech
- Only include if directly relevant to Glossi's competitive landscape
- 3–5 bullets max. Include URLs + "why it matters"

**Industry Intel** (Luminate, Ankler, general trades):
- Luminate: pull the 3–5 most relevant series pickups, renewals, cancellations for Create's client base
- Ankler and other industry sources from the inbox
- 3–5 bullets max

**Financial Forecast** (if Igor's data available):
- Concise topline: revenue vs. target, margin trends, flags. 3–5 bullets max — CFO brief, not raw numbers.
- If no forecast data available, skip entirely.

## Glossi Board & Raise
Write in clean, natural prose — like a brief from a chief of staff, not a database export. No raw data dumps, no markdown tables, no bullet lists of every investor name.

If a Glossi Board Meeting is within the next 3 days = BOARD PREP MODE: where the raise stands, who's close to closing, pipeline highlights, key decisions for discussion, open action items. 8–10 lines max.

If NO board meeting coming up: 2–3 toplines max — raise progress, pipeline snapshot, one key update. Keep it tight.`}

---

EMAIL (last 18 hours):
${data.email}

CALENDAR (next 3 days, with calendar source in brackets):
${data.calendar}

WATCH TOPICS (from Reminders — these are Jonathan's active strategic threads):
${data.reminders}

IMPORTANT — HOW TO USE WATCH TOPICS:
Each reminder is a strategic thread or initiative Jonathan is actively tracking. Cross-reference these against ALL data sources — emails, iMessages, calendar, Notion projects, Glossi board data — and surface anything related. For example, if a reminder says "Create Rebrand Messaging" and there's an email from Suneil or Casey about branding, connect them. If "Key art" is a topic and there's a meeting with Joey or a Notion project about key art, surface it. Think of each reminder as a lens to scan all incoming data through.

IMESSAGES (last 18 hours):
${data.imessages}

LUMINATE FILM & TV (weekly):
${data.luminate}

TLDR HEADLINES:
${data.tldr}
${data.industryIntel ? `
ENTERTAINMENT & GAMING INDUSTRY INTEL (from Deadline, Variety, THR, The Wrap, Polygon, IGN — pre-filtered for Create clients, active projects, and Glossi space):
${data.industryIntel}
` : ''}
CREATE PROJECT TRACKER (from Notion):
${data.notionProjects}

GLOSSI BOARD UPDATE (latest dashboard data):
${data.glossiBoard}
${data.glossiCashflow ? `
GLOSSI CASHFLOW (from finance spreadsheet — use these EXACT numbers, do not speculate):
${data.glossiCashflow}
` : ''}
IGOR GAMPEL FORECAST (latest email + PDF if available):
${data.igorForecast}
${data.collectionsReport ? `
CREATE COLLECTIONS REPORT (Maya's cash position data — use these EXACT numbers):
${data.collectionsReport}
` : ''}

YESTERDAY'S MEETINGS (for follow-up context):
${data.yesterdayCalendar}

RECURRING MONTHLY ALERTS (active today):
${data.recurringAlerts}
${data.claudeSessions ? `
CLAUDE SESSIONS (last 24h — what Jonathan was working on with Claude):
${data.claudeSessions}` : ''}
${data.staffingSummary ? `
STAFFING REVIEW — CONFIDENTIAL (F/S division proposed cuts):
${data.staffingSummary}` : ''}
${data.actionItems ? `
ACTION ITEM HISTORY (tracked across days):
${data.actionItems}

Items marked with [X days] have been open for that many days — flag aging items that need attention. Recently completed items confirm prior actions were taken.` : ''}
${data.teamsMessages ? `MICROSOFT TEAMS (recent messages):
${data.teamsMessages}` : ''}`;

  // Step 1: Opus generates the full briefing body
  const message = await withRetry(() => getClient().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: isWeekend ? 1500 : 3000,
    messages: [{ role: 'user', content: prompt }]
  }), 'generate-briefing');

  const rawBody = (message.content[0] as { text: string }).text;

  // Extract subject line from first line
  let subject = '';
  let body = rawBody;
  if (rawBody.startsWith('SUBJECT:')) {
    const firstNewline = rawBody.indexOf('\n');
    subject = rawBody.substring(8, firstNewline).trim();
    body = rawBody.substring(firstNewline + 1).trim();
  }

  // Step 2: Validate and condense the draft
  body = await validateAndCondense(body, data, isWeekend);

  // Step 3: Opus generates The Big Picture using the briefing + raw data
  const bigPicturePrompt = isWeekend
    ? `You are a strategic advisor to Jonathan Gitlin, CEO of Create Advertising Group and Executive Chairman of Glossi.

It's the weekend. Only write a Big Picture note if there is something genuinely urgent or time-sensitive that Jonathan needs to be thinking about before Monday. If nothing is urgent, respond with exactly: "Nothing urgent this weekend. Enjoy the time off."

1–2 sentences max. No heading, no intro — just the insight if warranted.

BRIEFING:
${body}

RAW CONTEXT:
Calendar: ${data.calendar}
${data.rollingContext ? `Recent threads: ${data.rollingContext}` : ''}`
    : `You are a strategic advisor to Jonathan Gitlin, CEO of Create Advertising Group (entertainment marketing) and Executive Chairman of Glossi (creative automation SaaS).

Here is today's morning briefing and the raw data behind it. Step back and connect the dots — calendar, emails, projects, Glossi metrics, industry moves, open threads.

Write 1–2 sharp, specific observations Jonathan should be thinking about today. Not platitudes — real strategic insights based on what's in front of him. 2–3 sentences max. No heading, no intro — just the insight.

IMPORTANT RULES:
1. Always lead with Create. That's the core business and where Jonathan's daily attention lives. Only lead with Glossi if it has a genuinely urgent event that day (board meeting happening TODAY, runway crisis).
2. Do NOT force connections between unrelated people or threads. Stick to real org chart relationships. For example, Joey Samaniego works on key art/print — he has no involvement in financials. Don't connect people to topics they don't actually touch.
3. Focus on what the Watch Topics/Reminders tell you is most pressing. Those are Jonathan's actual priorities, not your narrative interpretation.
4. Be specific and grounded — name the actual action, the actual person, the actual deadline. No platitudes.

BRIEFING:
${body}

RAW CONTEXT:
Calendar: ${data.calendar}
Glossi Board: ${data.glossiBoard}
${data.glossiCashflow ? `Glossi Cashflow: ${data.glossiCashflow}` : ''}
Notion Projects: ${data.notionProjects}
${data.rollingContext ? `Recent threads: ${data.rollingContext}` : ''}
${data.claudeSessions ? `Claude sessions (what Jonathan worked on yesterday): ${data.claudeSessions}` : ''}`;

  const bigPicture = await withRetry(() => getClient().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: isWeekend ? 150 : 300,
    messages: [{
      role: 'user',
      content: bigPicturePrompt
    }]
  }), 'big-picture');

  const insight = (bigPicture.content[0] as { text: string }).text;

  return {
    body: `## The Big Picture\n${insight}\n\n${body}`,
    subject: subject || (isWeekend ? 'Weekend Briefing' : 'Morning Briefing'),
  };
}

interface AfternoonData {
  date: string;
  email: string;
  calendar: string;
  reminders: string;
  imessages: string;
  notionProjects: string;
  glossiBoard: string;
  rollingContext: string;
  recurringAlerts: string;
  actionItems: string;
  teamsMessages: string;
  industryIntel: string;
  morningBriefing: string;
}

export async function generateAfternoonSync(data: AfternoonData): Promise<{ body: string; subject: string }> {
  const prompt = `You are Jonathan's afternoon sync assistant, writing in the voice of Create — precise, restrained, quietly authoritative. This is a 3 PM check-in: lighter and faster than the morning briefing. Focus on what changed since this morning and what's left for the rest of the day.

CONTEXT ON JONATHAN:

**Work — Create Advertising Group** (CEO)
Global entertainment marketing agency. Offices in LA and London.

**Work — Glossi** (Executive Chairman)
Browser-based creative automation platform (Unreal Engine 5).

KEY PEOPLE (Create): David Stern (Founder/Chairman), Michael Gadd (CFO), Dan Pfister (EVP Games), Mark Dacey (SVP ECD), Suneil Beri (EVP ECD), Andy Dadekian (VP Editorial), Molly Levine (VP CD), Vijay Sodhi (MD London), David Miller (VP Ops), Igor Gampel (billing), Maya Krishnan (finance), David Lowe (Senior AE), Joey Samaniego (team lead).
KEY PEOPLE (Glossi): Will Erwin (CEO), Ricky Solomon (investor/board).
KEY PEOPLE (Personal): Casey Benesch (close friend/advisor), Ashley (wife), Jake (son), Alex (daughter).

TAGGING: Create is the DEFAULT. Only tag [Glossi] for Glossi-specific people/topics.

FILTERING: IGNORE spam, marketing emails, automated alerts. Only real people and genuinely important items.

TONE: Calm, senior creative executive. Not urgent-alarm — just a smart advisor surfacing what still needs attention. Think "quick huddle" not "crisis briefing."

TIME FORMAT: Always 12-hour AM/PM.

SUBJECT LINE: First line must be "SUBJECT:" followed by 2-3 key items, under 70 chars, separated by "|". Example: "SUBJECT: Joey deck due | Glossi call 4p | Chase payment"

Today is ${data.date}. It's 3 PM.

FORMAT — AFTERNOON SYNC (compact, action-focused):

## Rest of Day
What's left on the calendar from now through evening. Include any prep needed.
- Same bullet format: **Headline** [Tag] — detail. **urgent** / **action needed** / **FYI**
- If the day is clear from here, say "Clear through end of day." and move on
- Max 5 items

## Since This Morning
New emails, iMessages, or Teams messages that came in today and need attention or are worth noting. Cross-reference against this morning's briefing — only surface what's NEW, not what was already covered.
- Max 6 items
- Tag each: **urgent** / **action needed** / **FYI**
- Skip anything already in this morning's briefing unless there's a meaningful update

## Still Open
Action items from this morning (or prior days) that haven't been resolved yet. Quick status check.
- Pull from the ACTION ITEM HISTORY
- If something was likely completed today (sent email evidence, meeting happened), mark it done
- Max 5 items
- If everything is handled, say "All clear — nothing outstanding."

## Tomorrow Preview
Quick glance at tomorrow's calendar. What should Jonathan prep for tonight or think about?
- Max 3 items
- If tomorrow is light, say so

---

${data.morningBriefing ? `THIS MORNING'S BRIEFING (for context — do NOT repeat items unless there's an update):
${data.morningBriefing.slice(0, 3000)}

` : ''}EMAIL (today):
${data.email}

CALENDAR (rest of today + tomorrow):
${data.calendar}

WATCH TOPICS:
${data.reminders}

IMESSAGES (last 8 hours):
${data.imessages}

${data.teamsMessages ? `TEAMS (recent):
${data.teamsMessages}
` : ''}${data.actionItems ? `ACTION ITEM HISTORY:
${data.actionItems}
` : ''}${data.industryIntel ? `INDUSTRY INTEL (only include if something major broke since morning):
${data.industryIntel}
` : ''}RECURRING ALERTS:
${data.recurringAlerts}

NOTION PROJECTS:
${data.notionProjects}

GLOSSI BOARD:
${data.glossiBoard}`;

  const message = await withRetry(() => getClient().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  }), 'afternoon-sync');

  const rawBody = (message.content[0] as { text: string }).text;

  // Extract subject line
  let subject = '';
  let body = rawBody;
  if (rawBody.startsWith('SUBJECT:')) {
    const firstNewline = rawBody.indexOf('\n');
    subject = rawBody.substring(8, firstNewline).trim();
    body = rawBody.substring(firstNewline + 1).trim();
  }

  return {
    body,
    subject: subject || 'Afternoon Sync',
  };
}

export async function validateAndCondense(
  draft: string,
  data: BriefingData,
  isWeekend: boolean
): Promise<string> {
  const prompt = `You are a senior editorial fact-checker and editor for a CEO's morning briefing. Your job is to validate every claim against the raw source data, remove errors, and tighten the briefing.

DRAFT BRIEFING TO VALIDATE:
${draft}

RAW SOURCE DATA (ground truth — the briefing must only contain information traceable to these sources):

EMAIL: ${data.email.slice(0, 3000)}

CALENDAR: ${data.calendar}

YESTERDAY'S CALENDAR: ${data.yesterdayCalendar}

WATCH TOPICS / REMINDERS: ${data.reminders}

IMESSAGES: ${data.imessages.slice(0, 2000)}

NOTION PROJECTS: ${data.notionProjects.slice(0, 1500)}

GLOSSI BOARD: ${data.glossiBoard}
${data.glossiCashflow ? `GLOSSI CASHFLOW: ${data.glossiCashflow}` : ''}
IGOR FORECAST: ${data.igorForecast.slice(0, 1000)}
${data.collectionsReport ? `COLLECTIONS REPORT: ${data.collectionsReport}` : ''}
RECURRING ALERTS: ${data.recurringAlerts}
${data.actionItems ? `ACTION ITEMS: ${data.actionItems.slice(0, 1000)}` : ''}
${data.teamsMessages ? `TEAMS: ${data.teamsMessages.slice(0, 1000)}` : ''}

Today is ${data.date}.

VALIDATION CHECKLIST — apply each check to every item in the draft:

1. FACTUAL ACCURACY: Every name, number, dollar amount, date, and role must match the source data exactly. If a number is wrong, fix it. If a name is misspelled or a role is wrong, fix it.

2. HALLUCINATION CHECK: Every claim must trace to a specific source above. If an item mentions a meeting, email, message, or project that does not appear in the source data, REMOVE IT entirely. Do not invent context.

3. STALENESS CHECK: If an action item references something already completed (appears in sent mail, past calendar events, or action items marked done), REMOVE IT. Do not surface completed tasks as action items.

4. ATTRIBUTION CHECK: Verify Create vs Glossi tags. These people are ALWAYS Create: Suneil Beri, Mark Dacey, Andy Dadekian, Dan Pfister, Molly Levine, Vijay Sodhi, David Miller, Igor Gampel, Maya Krishnan, David Lowe, Joey Samaniego. These are ALWAYS Glossi: Will Erwin, Ricky Solomon. If a tag is wrong, fix it.

5. DATE MATH CHECK: Today is ${data.date}. Verify every relative time reference ("tomorrow", "this week", "in 3 days", day names). If today is Wednesday, "tomorrow" is Thursday, not Friday. Fix any errors.

6. CONCISENESS EDIT: Remove any bullet that is purely informational with no action or decision implication. Tighten verbose bullets to max 20 words of detail. Collapse any section that has become too thin (1-2 items) into the nearest relevant section.

OUTPUT RULES:
- Return ONLY the corrected briefing in the same markdown format. No commentary, no "here is the corrected version", no diff notes.
- Preserve the exact section structure (## headers) and bullet format (bold headline, [Tag] pill, detail, urgency tag).
- If the draft is already accurate and concise, return it unchanged.
- Target: ${isWeekend ? '600-1000' : '1000-1800'} words. Cut from the bottom of each section's priority stack.`;

  const message = await withRetry(() => getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: isWeekend ? 1500 : 3000,
    messages: [{ role: 'user', content: prompt }]
  }), 'validate-condense');

  return (message.content[0] as { text: string }).text;
}
