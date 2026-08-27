import Anthropic from '@anthropic-ai/sdk';
import { checkBriefingForRegressions } from './sources/regression-check';
import { withTimeout } from './utils/with-timeout';

// ---------------------------------------------------------------------------
// Client & retry infrastructure (mirrors claude.ts — kept independent for A/B)
// ---------------------------------------------------------------------------

let _client: Anthropic;
function getClient() {
  if (!_client) _client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 120_000,
    // The SDK retries internally on top of our withRetry loop. Left at the
    // default (2) the two layers multiply: one logical call could burn ~9 HTTP
    // attempts with no visibility in our logs. Observed 2026-08-14: a single
    // assembler call took 1783s (29.7 min) without emitting ONE retry line,
    // which stretched the run to 40 min. Keep the SDK's own retrying minimal and
    // let our loop own it, where it is logged and bounded.
    maxRetries: 1,
  });
  return _client;
}

/**
 * Hard wall-clock ceiling per model call. The SDK's `timeout` option did not
 * bound the real elapsed time (see maxRetries note above), so we race every call
 * against our own clock — the same fix that stopped the osascript hang. Normal
 * calls finish in 15-30s; 180s is generous headroom before we retry.
 */
const CALL_TIMEOUT_MS = 180_000;

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // withTimeout rejects with "... timed out after Ns", which the isTimeout
      // check below matches — so a stalled call retries visibly instead of
      // silently consuming half an hour.
      return await withTimeout(fn(), CALL_TIMEOUT_MS, label);
    } catch (err: any) {
      const isTimeout = err.message?.includes('timed out') || err.message?.includes('timeout');
      const isOverloaded = err.status === 529 || err.status === 503;
      if ((isTimeout || isOverloaded) && attempt < retries) {
        const delay = attempt * 15_000;
        console.log(`[missions] ${label} attempt ${attempt} failed (${err.message}) — retrying in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after ${retries} attempts`);
}

function extractText(msg: Anthropic.Message): string {
  // Find the first text block. With adaptive thinking enabled, content[0] is a
  // `thinking` block (empty text under the default display) and the real answer
  // is in a later `text` block — so we must search, not assume content[0].
  const textBlock = msg.content.find(b => (b as { type: string }).type === 'text') as { text?: string } | undefined;
  return textBlock?.text ?? '';
}

/**
 * Renders the PERSISTENT RULES block injected into every worker prompt.
 * Sourced from briefing-notes.md (via feedback.ts). Empty string when absent.
 * Workers respect these rules BEFORE generating output, so hallucinations are
 * suppressed at source rather than corrected downstream by the validator.
 */
function rulesBlock(feedback: string | undefined): string {
  if (!feedback || !feedback.trim()) return '';
  return `\n\nPERSISTENT RULES — FOLLOW STRICTLY (these correct recurring errors from prior briefings):\n${feedback.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

interface BriefingData {
  date: string;
  email: string;
  calendar: string;
  reminders: string;
  imessages: string;
  tldr: string;
  luminate: string;
  notionProjects: string;
  igorForecast: string;
  feedback: string;
  rollingContext: string;
  recurringAlerts: string;
  claudeSessions: string;
  staffingSummary: string;
  yesterdayCalendar: string;
  actionItems: string;
  teamsMessages: string;
  collectionsReport: string;
  industryIntel: string;
  replyEngineStatus?: string; // launchd PID + log freshness for Reply repo
  aurisStatus?: string;       // Auris Markets newsletter send-detection (empty if not a send day)
  aurisRetroStatus?: string;  // one-line weekly harness-retro result (empty when no run in last 7 days)
  graphTokenHealth?: string;  // Graph auth health alert (empty when healthy)
  pendingProposal?: string; // pre-rendered Rule Maintenance markdown section, or empty string
}

interface AfternoonData {
  date: string;
  email: string;
  calendar: string;
  reminders: string;
  imessages: string;
  notionProjects: string;
  rollingContext: string;
  recurringAlerts: string;
  actionItems: string;
  teamsMessages: string;
  industryIntel: string;
  morningBriefing: string;
  feedback?: string;
  replyEngineStatus?: string;
  aurisStatus?: string;
  graphTokenHealth?: string;
}

// Re-export getRecurringAlerts from claude.ts so callers can use either module
export { getRecurringAlerts } from './claude';

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

// Model routing (upgraded 2026-07 from sonnet-4-6 / opus-4-6):
//  - ASSEMBLER  = Opus 4.8, the flagship — best compositional quality, and the
//    only call where adaptive thinking is enabled (catches cross-source errors
//    like the Marcel/Primm attribution class).
//  - WORKER/VALIDATOR = Sonnet 5 — near-Opus quality at Sonnet cost. Thinking
//    is DISABLED on the reasoning workers (tight max_tokens; Sonnet 5 turns
//    adaptive thinking ON by default when `thinking` is omitted, which would
//    truncate their small budgets) but ADAPTIVE on the validator (accuracy is
//    its whole job, and it's a single call with headroom).
//  - CHEAP = Haiku 4.5 for mechanical/structured tasks (Day Shape reformat,
//    rule-usage, regression, context extraction). ~1/3 the cost of Sonnet,
//    no quality loss on these. NOTE: Haiku 4.5 does NOT support adaptive
//    thinking or `output_config.effort` — pass neither on cheap-tier calls.
const WORKER_MODEL    = 'claude-sonnet-5';
const ASSEMBLER_MODEL = 'claude-opus-4-8';
const VALIDATOR_MODEL = 'claude-sonnet-5';
const CHEAP_MODEL     = 'claude-haiku-4-5';

// ---------------------------------------------------------------------------
// PHASE 1 — Five parallel workers (all Sonnet)
// ---------------------------------------------------------------------------

// ---- Worker 1: Day Shape ----
async function dayShapeWorker(data: BriefingData, isWeekend: boolean): Promise<string> {
  const prompt = `You are a scheduling analyst. Produce a concise day-shape analysis.
${rulesBlock(data.feedback)}
Today is ${data.date}.${isWeekend ? ' (Weekend)' : ''}

TASKS:
1. Write ONE line summarizing the day's density/rhythm (e.g., "Heavy morning — back to back 10 AM through 12:30, clear after lunch" or "Light day — one meeting at 2 PM, otherwise open").
2. List every meeting/event for TODAY with: time (12-hour AM/PM), title, attendees (full names), location/link, and which calendar it's from.
3. List meetings for the next 2-3 days (grouped by day) in the same format.
4. Flag any recurring alerts that are active today.

IMPORTANT:
- David Stern is NOT in weekly Management Meetings — never list him as an attendee.
- "AJ Personal" or gmail calendar = Personal. "Calendar" (Exchange) = Work.
- Time format: always 12-hour with AM/PM.

OUTPUT FORMAT: Plain text, no markdown headers. One density line, then the meeting list, then recurring alerts. Keep it factual — no editorializing.

Target: 200-400 words.

---

CALENDAR (next 3 days):
${data.calendar}

YESTERDAY'S CALENDAR (for follow-up context):
${data.yesterdayCalendar}

RECURRING ALERTS:
${data.recurringAlerts}`;

  const msg = await withRetry(() => getClient().messages.create({
    model: CHEAP_MODEL, // Haiku 4.5 — Day Shape is mechanical calendar reformatting
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  }), 'worker-day-shape');
  return extractText(msg);
}

// ---- Worker 2: Meeting Prep ----
async function meetingPrepWorker(data: BriefingData, isWeekend: boolean): Promise<string> {
  if (isWeekend) return '(Weekend — no meeting prep needed unless urgent meetings on Monday.)';

  const prompt = `You are a meeting prep analyst. For EACH meeting on today's and tomorrow's calendar, find every related piece of intel across the data sources below.
${rulesBlock(data.feedback)}
Today is ${data.date}.

For each meeting, search for:
- Emails to/from attendees or about the meeting topic
- iMessages mentioning attendees, the meeting, or related projects
- Teams messages about the topic or from attendees
- Claude sessions where Jonathan was working on related material
- Notion projects related to the meeting topic
- Any prep notes, talking points, agendas, or background materials

OUTPUT FORMAT: For each meeting, write:

**[Time] — [Meeting Title]**
- Attendees: [full names]
- Related intel found: [cite source type and summarize — e.g., "Email from Casey Benesch (4/10): sent talking points for the Netflix discussion including..."]
- If no related intel found, write: "No prep intel found in data sources."

KEY RULES:
- Use first AND last name for every person on first mention.
- Casey Benesch's prep notes are HIGH VALUE — always surface in full.
- Charlie Smith (legal) emails are HIGH PRIORITY.
- Do NOT assign homework. Surface what EXISTS — don't tell Jonathan to "chase numbers" or "prepare talking points."

Target: 300-500 words.

---

CALENDAR:
${data.calendar}

EMAIL:
${data.email}

IMESSAGES:
${data.imessages}

${data.teamsMessages ? `TEAMS MESSAGES:\n${data.teamsMessages}\n` : ''}
${data.claudeSessions ? `CLAUDE SESSIONS (what Jonathan worked on):\n${data.claudeSessions}\n` : ''}
NOTION PROJECTS:
${data.notionProjects}`;

  const msg = await withRetry(() => getClient().messages.create({
    model: WORKER_MODEL,
    max_tokens: 1200,
    thinking: { type: 'disabled' }, // Sonnet 5 defaults thinking ON when omitted; keep workers fast + within budget
    messages: [{ role: 'user', content: prompt }],
  }), 'worker-meeting-prep');
  return extractText(msg);
}

// ---- Worker 3: Active Threads ----
async function activeThreadsWorker(data: BriefingData, isWeekend: boolean): Promise<string> {
  const prompt = `You are a strategic thread tracker for Jonathan Gitlin, CEO of Create Advertising Group and Executive Chairman of Glossi.
${rulesBlock(data.feedback)}
Today is ${data.date}.${isWeekend ? ' Weekend mode — only flag threads with urgent movement.' : ''}

Your job: For EACH watch topic in the Reminders data, scan ALL data sources below for signals. A "signal" is any email, message, meeting, project update, or Claude session that relates to that topic.

PROCESS:
1. Read each reminder/watch topic carefully (including sub-notes if present).
2. Cross-reference it against emails, iMessages, Teams, Notion, Glossi board, Claude sessions, action items.
3. If a sent email or completed action shows something was done, mark it COMPLETED.
4. Claude sessions show what Jonathan actively worked on — use them to add context.
5. Check Notion projects for any marked 🆕 NEW — these are new projects that just came in. Surface each new project with client name, team assignment, and phase. New projects are high-priority signals.

OUTPUT FORMAT:
For each topic WITH signals:
**[Topic Name]** [Create] or [Glossi]
- [Signal 1: source type, who, what, when — 1-2 lines]
- [Signal 2: ...]
- Status: [moving/stalled/completed/needs-action]

For topics with NO signals:
List them at the end as: "No movement on: [Topic 1], [Topic 2], [Topic 3]"
IMPORTANT: Keep Create and Glossi topics on SEPARATE "No movement" lines.

TAGGING RULES:
- Create is the DEFAULT. Only tag [Glossi] for Glossi-specific topics (the SaaS product, investors, fundraising, board).
- Vijay Sodhi, Igor Gampel, David Lowe, Joey Samaniego = always [Create].
- Will Erwin, Ricky Solomon = always [Glossi].
- Casey Benesch + industry contacts = [Create] not [Personal].
- NEVER combine Create and Glossi items in the same line.

CROSS-REFERENCE ACCURACY — do NOT connect people to threads they're not part of:
- David Lowe = Senior Account Executive on Joey Samaniego's sales team. He has NOTHING to do with Gaming, Live Sports Deck, or creative pitches.
- Dan Pfister = Head of Games/Gaming division ONLY. Do not attach him to non-gaming threads unless the data explicitly shows him involved.
- Live Sports Deck = Matt Primm + Casey Benesch project. Only include people the source data explicitly names in this thread.
- Marcel Perez = Senior Producer, Design on Joey Samaniego's team. He is NOT a group/division head. Do NOT attribute revenue, budget, or forecast figures to "Marcel Perez's group" — he doesn't run a P&L group. If Igor's forecast mentions "Perez" or "Marcel" next to revenue figures, that is MATT PRIMM's group, not Marcel Perez.
- Matt Primm = runs a creative group that IS a P&L center. Igor's forecast may label this group as "Primm" or sometimes ambiguously. Any revenue/budget P&L line that could be confused with "Marcel Perez" is actually MATT PRIMM's group.
- RULE: If a person is not explicitly mentioned in the source data for a specific thread, do NOT infer a connection. Only report what the data says.
- RULE: Never attribute financial figures to a person unless their name appears in the financial source data (Igor's forecast). Do NOT use Teams/email context to guess who owns a revenue line.

DEAD ITEMS — ignore completely, never surface:
- "Clio Entertainment Judging"
- "Text Mike Garrett"
- "Monkey Quest Cannes Greetings"
- "Approve payroll for Marina"

DATE CONFLICT RULE: When a reminder's text says one date but the [due:] field shows a different date, TRUST THE TEXT over the due field.

CHECK SENT EMAILS: If a "[Sent]" email shows an action was completed (e.g., Igor was sent the invoice), mark it done.

Target: 300-500 words.

---

WATCH TOPICS (from Reminders):
${data.reminders}

EMAIL:
${data.email}

IMESSAGES:
${data.imessages}

${data.teamsMessages ? `TEAMS MESSAGES:\n${data.teamsMessages}\n` : ''}
NOTION PROJECTS:
${data.notionProjects}

ROLLING CONTEXT (recent briefings):
${data.rollingContext || '(none)'}

${data.claudeSessions ? `CLAUDE SESSIONS:\n${data.claudeSessions}\n` : ''}
${data.actionItems ? `ACTION ITEM HISTORY:\n${data.actionItems}\n` : ''}
${data.collectionsReport ? `COLLECTIONS REPORT:\n${data.collectionsReport}\n` : ''}`;

  const msg = await withRetry(() => getClient().messages.create({
    model: WORKER_MODEL,
    max_tokens: 1200,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  }), 'worker-active-threads');
  return extractText(msg);
}

// ---- Worker 4: Intel ----
// Output is structured as TWO labeled sections so the assembler can surface
// them separately: ## New Projects (from Notion — Jonathan's primary signal)
// and ## Industry Briefs (trade headlines — secondary, smaller).
async function intelWorker(data: BriefingData, isWeekend: boolean): Promise<string> {
  const prompt = `You are an intelligence analyst for Jonathan Gitlin, CEO of Create Advertising Group. Your job is to surface (1) NEW PROJECTS from the Notion project tracker — Jonathan's PRIMARY interest — and (2) a small set of industry trade headlines as secondary context.
${rulesBlock(data.feedback)}
Today is ${data.date}.${isWeekend ? ' Weekend — keep both sections short.' : ''}

OUTPUT STRUCTURE — produce EXACTLY these two labeled sections, in this order:

=== NEW PROJECTS ===
ONLY list projects flagged "🆕" in the NOTION PROJECTS data block. The 🆕 flag means a project is genuinely newly added to the tracker since the last brief run — that is the ONLY signal for this section.
- Do NOT include projects without a 🆕 flag.
- Do NOT include projects because of due-date proximity, status changes, phase moves, or "needs attention" — none of those qualify. Pure newness only.
- Do NOT filter by team — surface ALL new projects across every team (London, Content, Madness, Design, Social, etc.). Every department's new work matters.
- Format each as: **Project name** [Client] — team if known. That's it. NO due date, NO status, NO phase. Jonathan only wants to know it exists.
- If there are zero 🆕-flagged projects, write exactly: "No new projects added since the last brief." and nothing else.
- No bullet cap — if 12 new projects were added, list all 12. Newness is the whole point of this section.

=== INDUSTRY BRIEFS ===
A SMALL secondary section. Pull 3-5 MACRO trade headlines that are genuinely relevant — preferably stories about Create's clients (Disney, Netflix, HBO, Marvel, Sony, Paramount, WB, FX, Hulu, Amazon/MGM, Apple TV, A24, Lionsgate, Universal, IMAX) or that affect entertainment-marketing strategy. Skip:
- Generic tech / AI / dev-tool news (not entertainment-marketing relevant)
- Granular casting announcements unless tied to a Create active project
- Studio personnel changes that don't affect Create's accounts

Each headline: **Headline** — one-line "why it matters for Create." Include URL as markdown link if available. MAXIMUM 5 bullets. If nothing of macro importance, write 2-3 bullets only — do NOT pad.

---

NOTION PROJECTS (PRIMARY SOURCE — surface 🆕 flags first):
${data.notionProjects}

LUMINATE FILM & TV (data points only, not for headlines):
${data.luminate}

${data.industryIntel ? `ENTERTAINMENT & GAMING INDUSTRY INTEL (trade outlets):\n${data.industryIntel}\n` : ''}
TLDR HEADLINES (skip generic tech — only entertainment-marketing-relevant):
${data.tldr}`;

  const msg = await withRetry(() => getClient().messages.create({
    model: WORKER_MODEL,
    max_tokens: 800,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  }), 'worker-intel');
  return extractText(msg);
}

// ---------------------------------------------------------------------------
// PHASE 2 — Assembler (Opus)
// ---------------------------------------------------------------------------

async function assembleBriefing(
  workers: {
    dayShape: string;
    meetingPrep: string;
    activeThreads: string;
    intel: string;
  },
  data: BriefingData,
  isWeekend: boolean,
): Promise<{ body: string; subject: string }> {

  const prompt = `You are Jonathan's morning briefing assistant, writing in the voice of Create — precise, restrained, quietly authoritative. Think Monocle editorial, not agency flash. Every sentence earns its place.

${isWeekend ? `Weekend mode — lighter touch, personal-first. Only surface work items that are genuinely urgent or time-sensitive for Monday.` : ''}

Today is ${data.date}.

You are assembling the final briefing from five pre-analyzed intelligence reports. Each worker has already done the cross-referencing and analysis. Your job is to COMPOSE — merge, deduplicate, prioritize, and write in the Create voice.

CONTEXT ON JONATHAN:

**Work — Create Advertising Group** (CEO)
Global entertainment marketing agency behind campaigns for Disney, Netflix, HBO, Marvel, Sony, Paramount, Warner Bros, FX. 137 Clio Awards, 36 Golden Trailers. 50+ film/TV titles per year. Offices in LA and London.
**Auris** is an AI intelligence platform built FOR Create — it falls under Create, not a separate company.
**Auris Markets** is a weekly newsletter Jonathan sends via auris-ai.io. Three editions: Gaming (Wednesday), Films/Series (Friday), Company (Monday). Each newsletter contains AI-curated intel highlights. These are Create's outbound thought-leadership — flag the send day as an action item.

**Work — Glossi** (Executive Chairman)
Browser-based creative automation platform (Unreal Engine 5) that converts 3D product models into production-ready marketing visuals. Clients include SpaceX, Crate & Barrel, Moen.

**Personal:**
- Campbell Hall — Alumni board member. Key contact: Aubrey Rakowski. Also his son Jake's middle school.
- Lakeside Golf Club — Social Committee Chair (Member #348). Key contact: Kaitlyn Sugarman (Events Director).
- Family — married to Ashley (anniversary 9/10). Son Jake (born 8/20/14). Daughter Alex (born 6/25/18). Dogs: Franklin (Brittany spaniel), Mango (Golden Retriever). Mom: Rosie Gitlin.

${data.rollingContext ? `CONTINUITY — OPEN THREADS FROM RECENT BRIEFINGS:
Use this for continuity. Reference prior context when relevant. Don't repeat old items that are no longer active.

${data.rollingContext}
` : ''}${data.feedback ? `JONATHAN'S FEEDBACK ON PAST BRIEFINGS:
${data.feedback}
` : ''}

VOICE & FORMATTING RULES:

TONE — CREATE VOICE: Write like a trusted, senior creative executive — confident but not aggressive. Direct, clear, polished. No drill-sergeant barking. Be the calm, smart advisor who surfaces what matters and trusts Jonathan to act. Think editorial, not urgent-alarm. The vibe is premium ad agency, not command center.

NAME RULE: ALWAYS use first AND last name on first mention. After that, first name only is fine.

SOURCE ATTRIBUTION: When surfacing an action item or commitment, briefly cite where it came from (e.g., "per your email to Rebecca Torres", "from your Thursday iMessage to Casey Benesch").

MEETING PREP STYLE: Jonathan does NOT prep by chasing numbers. Do NOT write action items like "chase Igor for numbers." Surface what data IS available and let him decide. The briefing informs; it doesn't assign homework.

SUBJECT LINE: First line of output must be "SUBJECT:" followed by a short, punchy summary of 2-3 most important things. Under 80 characters. Use "|" to separate items. Example: "SUBJECT: Glossi board prep | Joey noon | Chase due"

CRITICAL — NO DUPLICATION: Each item appears ONCE in the most appropriate section. If a meeting is today, it goes in Today — not also in This Week. If a recurring alert is due today, it goes in Today — not a separate section.

CRITICAL — DATE ACCURACY: Today is ${data.date}. Count days correctly. Use actual day names for anything beyond tomorrow.

CRITICAL — REMINDERS ARE AUTHORITATIVE: The REMINDERS data is Jonathan's manually-curated list of due dates and open items. When a reminder specifies a date (e.g., "by 5/15"), USE THAT DATE. Never substitute a date inferred from Teams/email context. Never write "April 15" for an item whose reminder says "5/15". Check REMINDERS first for any date-sensitive item.

CRITICAL — DO NOT HALLUCINATE RECIPIENTS: When a sent email subject is visible but the TO: field is not extracted in the source data, say "recipient not captured" — do NOT guess the recipient from Teams/thread context. Recipients are ONLY valid when explicitly named in the source data for that specific email.

CRITICAL — SENT EMAIL RESOLUTION: If Jonathan has already sent an email about a topic (visible in [Sent] email data), DO NOT add a "check in", "follow up", or "circle back" action item for that same topic. The ball is in the recipient's court — leave it alone unless the recipient has replied with something that requires action. A reminder note saying "send the X deal" or "follow up on Y" is STALE the moment the send is confirmed in sent mail; surface the send as resolved, not as an open action. Example: if reminders say "follow up with Zaid on Apple pitch" and sent mail shows Jonathan emailed Zaid, mark it resolved — do NOT carry forward a "check in next week" action.

CRITICAL — NEVER CLAIM "FIRST DAY" WITHOUT VERIFICATION: Do NOT write "[Person]'s first day", "starts today", "Day 1", "starting Monday", or "onboarding this week" unless the source data EXPLICITLY says so with a date matching today. Welcome threads, calendar invites, and Teams activity are NOT evidence of a first day — those happen weeks after someone starts. Joey Samaniego, in particular, has been at Create since well before 4/19/2026 and must never be framed as new or onboarding. If a "first day" is genuinely today and confirmed by HR/calendar with a matching date, fine — otherwise omit entirely.

CRITICAL — FILTER OUT ROUTINE HIRES/ONBOARDING: Jonathan does NOT approve individual hires below CEO-level contracts. Dan Pfister and Matt Primm own hiring decisions for their groups (creative/gaming/3D roles). DROP from the briefing: vendor or employee onboarding status, NDA routing, form signatures, department-head hire approvals, contract redlines that don't require Jonathan's signature, and similar HR/legal paperwork noise. SURFACE ONLY when: Jonathan is the actual signer (CEO-level contracts, board matters), there is a blocker needing CEO escalation, or the deal itself is material strategy. Never frame a department-head hire as "pending your sign-off."

CRITICAL — KNOWN DATE CORRECTIONS (defense-in-depth on top of the reminders-authoritative rule):
- Films/Series (F/S) staff reductions deadline is **5/15** (May 15), NOT 4/15. Never write "April 15" for this item.
- IRS short-term payment plan ($20K) has been SUBMITTED — Jonathan is waiting on IRS to revise. Do NOT flag it as "overdue". The payment schedule from reminders is: 5/15 pay $10K toward extension balance; 6/15 pay final $10K extension + $40K Q1 estimate ($50K total). Surface these on their due dates only — don't compound them or treat the 4/16 plan setup as an open action.

CRITICAL — CASH POSITION (when Maya's collections data is present):
- The "Early-pull candidates (MTD collected)" line MUST appear whenever cash position is in the brief, reproduced with Maya's exact line label — do NOT reword it to "Early-pull available", do NOT append "= $X if needed" or a combined sum, do NOT drop it for brevity. Both Apple AND Disney must appear even if one is $0.
- Use Maya's exact labels VERBATIM: "Apple TV+" (NOT "Apple", NOT "Apple TV") and "Walt Disney" (NOT "Disney", NOT "Disney+"). Those are the row labels from her Detail by Studio section.
- Quote the figures from the source — do NOT round, do NOT combine the two studios into a single sum without showing both component figures.
- These two studios get a dedicated line because Jonathan can request early payment from them specifically; other studios go into the generic "Top MTD" line.

TIME FORMAT: Always 12-hour with AM/PM.

TAGGING — CREATE vs GLOSSI:
- Create is the DEFAULT. Only tag [Glossi] if the person/topic is explicitly Glossi.
- VISUAL SEPARATION: NEVER combine Create and Glossi items in the same bullet or collapsed line.

CONCISENESS RULES:
- RELEVANCE GATE: Does Jonathan need this TODAY to make a decision or take an action?
- BULLET CAPS: Today (max 8), This Week (max 6), Active Threads (max 5 detailed + collapse rest), New Projects (max 8 from Notion), Industry Briefs (max 5 trade headlines).
- BULLET LENGTH: One line per bullet. Max 20 words of detail after the headline.
- DAY-DENSITY MATCHING: Light days get shorter briefings.
- COLLAPSE QUIET THREADS: One line: "No movement on: X, Y, Z."

DEAD ITEMS — NEVER include any of these:
- "Clio Entertainment Judging"
- "Text Mike Garrett"
- "Monkey Quest Cannes Greetings"
- "Approve payroll for Marina"

${data.graphTokenHealth ? `## System Alert
INCLUDE THIS AT THE TOP of the brief, before all other sections, in a callout-style line. Verbatim:
${data.graphTokenHealth}

` : ''}${data.aurisRetroStatus ? `SYSTEM/OPS FOOTNOTE — include this line VERBATIM as the very LAST line of the brief, as a single italic FYI (wrap it in underscores: _…_). Do NOT add a header, do NOT reword, do NOT expand it, and do NOT place it near the top. It is a low-priority ops note about the coding harness, not an alert:
${data.aurisRetroStatus}

` : ''}${isWeekend ? `FORMAT — WEEKEND BRIEFING (shorter, personal-first):

## The Big Picture
Day shape (from Day Shape analysis) + ONE new insight — the single most important new signal. NOT a stale thread rehash. 1-2 sentences max. If nothing urgent, "Nothing urgent this weekend. Enjoy the time off."

## Today
Personal events, family plans, golf, errands — anything happening today. Personal-first.
- FORMAT: **Headline** [Tag] — detail. **urgency tag**
- Calendar events with times
- Recurring alerts if due today/tomorrow
- Only work items if genuinely urgent
- If nothing: "Clear day — enjoy the weekend."

## This Week Ahead
Quick preview of Monday and first few days. 5 bullets max.

## Active Threads
One-line summary. Collapse everything: "No weekend movement on: [topic], [topic]"
Only break out if genuinely urgent movement.

## New Projects
Render "=== NEW PROJECTS ===" from Intel worker — newly-added Notion tracker entries only. Format: **Project name** [Client] — team. No dates, no status. If "No new projects" reported, skip the section.

## Industry Briefs
Render "=== INDUSTRY BRIEFS ===" from Intel worker — 3-5 bullets max, skip if nothing notable.

## Weekend Note
Personal reminders, family events, golf, social plans.` : `FORMAT — WEEKDAY BRIEFING:

## The Big Picture
Day shape (from Day Shape analysis) + ONE new insight — the single most important NEW signal from the worker analyses. This must be a fresh observation, not a rehash of a stale thread. Lead with Create unless Glossi has a genuinely urgent event today. Be specific — name the person, the action, the deadline. 2-3 sentences max.

IMPORTANT for Big Picture:
- Always lead with Create unless Glossi has urgent event TODAY.
- Do NOT force connections between unrelated people/threads.
- Focus on what Watch Topics/Reminders say is most pressing.
- Be specific and grounded — actual action, actual person, actual deadline.

## Today
Everything needing action TODAY — Create, Glossi, Personal. One unified list, priority ordered.
- FORMAT: **Headline** [Tag] — detail. **urgency tag**
  e.g. **09:15 AM — Lift Society** [Personal] — On the books. **FYI**
  NEVER put the tag before the headline.
- Calendar events with times, woven in with cross-referenced prep intel from Meeting Prep worker
- Recurring alerts due today/tomorrow integrated here
- Birthdays/anniversaries
- Tag each: **urgent** / **action needed** / **FYI**
- Max 8 items

## This Week
Next 2-3 days (NOT today). Grouped by day.
- Same bullet format
- Cross-referenced meeting prep from worker 2
- If a day has no events, still list it and say "Clear."
- Max 6 items

## New Projects
If the Active Threads worker flagged any 🆕 new Notion projects, list them here. For each:
- **Project Name** [Client] — Team assignment, phase, producer if known
- If no new projects, skip this section entirely (don't write "No new projects").

## Active Threads
From Active Threads worker output. Check yesterday's meetings for follow-up opportunities.

Threads WITH new signals: **Bold topic** as subheading, list signals, 2-5 bullets max per topic.
Threads with NO signals: Collapse to one line: "No movement on: X, Y, Z." (Create and Glossi on SEPARATE lines.)

Completed items noted once with a checkmark then dropped on next briefing.

Max 5 detailed threads + collapse the rest.

## New Projects
Render the "=== NEW PROJECTS ===" section from the Intel worker EXACTLY as the worker produced it. Jonathan only wants newness — he wants to know when a new project hit the Notion tracker, no matter which team added it.
- Format per project: **Project name** [Client] — team. Nothing more. NO due dates, NO status, NO phase.
- If the worker reports "No new projects added since the last brief," surface that line verbatim and move on.
- Do NOT pad with projects that aren't 🆕-flagged. Do NOT mix in trade headlines, due-date warnings, or phase updates.

## Industry Briefs
Render the "=== INDUSTRY BRIEFS ===" section from the Intel worker — a SECONDARY, smaller section. Max 5 bullets. Skip the section entirely if there's nothing genuinely macro-relevant. Trade headlines are NOT a substitute for project news.

## Financial Forecast
If Igor's data is available, 3-5 bullets CFO-brief style.

FRESHNESS — NON-NEGOTIABLE: The Igor source block contains a line "Forecast email date: YYYY-MM-DD". You MUST cite that exact date the first time you quote any Igor figure. Format: "per Igor's [M/D] forecast, [figure]" — e.g., "per Igor's 5/12 forecast, Film & Series May revenue tracking at $1.8M vs. $2.0M budget." Do NOT paraphrase the date to a month name ("April forecast", "May 2026 forecast") — use the literal M/D from the source.
- If the source begins with "Subject: Igor Forecast (CACHED FALLBACK)" or contains "WARNING: Using CACHED", quote the staleness verbatim in the briefing: "Igor data is cached from [date], [N] days old — live fetch failed, treat as directional."
- NEVER write a financial summary line without the date citation. Lines like "Consolidated revenue: $2.78M vs. budget $2.57M" with no dated source are a violation.

SCOPE: Igor's forecast is typically Film & Series division ONLY, not company-wide. Always label scope explicitly — "Film & Series May revenue" not "Total revenue". If the data doesn't specify scope, default to "Film & Series" and note that. Do NOT call it "company-wide" or "broken out by division" unless the source data explicitly says so.

ATTRIBUTION: Never assign a person/group name to a revenue figure unless that exact name appears in the Igor forecast data. Quote internal labels verbatim — do NOT substitute names from Teams/email. "Marcel Perez" is NOT a group head; any line that looks like "Perez" or "Marcel" is MATT PRIMM's group — write "Matt Primm's group".

## Cash Position
If Maya's collections report data is available, show it in this exact format (4 lines max):
- **Liquid: $[X]K** — covers/short next payroll (~$450K) with $[Y]K buffer (or ⚠️ short ~$[Y]K)
- **MTD Collections: $[X]K** | **AR Outstanding: $[X]K**
- Early-pull candidates (MTD collected): Apple TV+ ($[X]K) · Walt Disney ($[X]K) — reproduce Maya's line label VERBATIM; do NOT reword to "Early-pull available" and do NOT append "= $X if needed" or a combined sum; show BOTH studios even if one is $0; use the exact labels "Apple TV+" and "Walt Disney" (never "Apple" or "Disney" alone)
- Today's collections: [who paid, amounts] — flag big days (over $100K) with 📈
If no collections data, skip this section entirely.

`}

---

WORKER ANALYSES (pre-analyzed intelligence — use these as your primary source):

=== DAY SHAPE ANALYSIS ===
${workers.dayShape}

=== MEETING PREP INTELLIGENCE ===
${workers.meetingPrep}

=== ACTIVE THREADS ANALYSIS ===
${workers.activeThreads}

=== INDUSTRY INTEL ===
${workers.intel}

---

SUPPLEMENTARY RAW DATA (for fact-checking and gap-filling — workers may have missed something):

IGOR FORECAST (NOTE: Igor's data is typically Film & Series division only, NOT company-wide. Label scope explicitly. Use ONLY names/labels that appear in this data — never substitute names from other sources): ${data.igorForecast ? data.igorForecast.slice(0, 2000) : '(unavailable)'}
${data.collectionsReport ? `COLLECTIONS REPORT: ${data.collectionsReport.slice(0, 500)}` : ''}
${data.staffingSummary ? `STAFFING REVIEW — CONFIDENTIAL: ${data.staffingSummary.slice(0, 500)}` : ''}`;

  const msg = await withRetry(() => getClient().messages.create({
    model: ASSEMBLER_MODEL,
    // Thinking is intentionally OFF here: this call re-emits the full ~1500-word
    // brief, and adaptive thinking shares the max_tokens budget — enabling it
    // truncated the output. Opus 4.8 without thinking is already a large quality
    // step over 4.6. (To add thinking later, switch to streaming + ~32K max_tokens.)
    max_tokens: isWeekend ? 3000 : 4000,
    messages: [{ role: 'user', content: prompt }],
  }), 'assembler');

  const rawBody = extractText(msg);
  const { subject, body } = extractSubjectAndBody(rawBody);
  return { body, subject };
}

/**
 * Pulls the SUBJECT line out of the assembler output, regardless of leading
 * whitespace, code-fence wrappers, or stray characters. Returns the body with
 * any "SUBJECT: ..." line(s) removed so it can never bleed into the email body.
 */
function extractSubjectAndBody(raw: string): { subject: string; body: string } {
  // Match an optional leading whitespace, optional `# ` heading prefix, then
  // SUBJECT: <text> on its own line. Captures up to first newline.
  const match = raw.match(/^\s*(?:#+\s*)?SUBJECT\s*:\s*([^\n]+)\n/i);
  if (match) {
    const subject = match[1].trim();
    const body = raw.slice(match[0].length).trim();
    return { subject, body };
  }
  // Fallback: scan first 5 non-empty lines for a SUBJECT: prefix and strip it
  // (handles assembler output with leading commentary).
  const lines = raw.split('\n');
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const m = lines[i].match(/^\s*(?:#+\s*)?SUBJECT\s*:\s*(.+)$/i);
    if (m) {
      const subject = m[1].trim();
      lines.splice(i, 1);
      // Drop a single blank line if it was left behind
      if (lines[i] !== undefined && lines[i].trim() === '') lines.splice(i, 1);
      return { subject, body: lines.join('\n').trim() };
    }
  }
  return { subject: '', body: raw.trim() };
}

// ---------------------------------------------------------------------------
// PHASE 3 — Validator (Sonnet, enhanced with completeness check)
// ---------------------------------------------------------------------------

async function validateMissions(
  draft: string,
  workerOutputs: {
    dayShape: string;
    meetingPrep: string;
    activeThreads: string;
    intel: string;
  },
  data: BriefingData,
  isWeekend: boolean,
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

IGOR FORECAST: ${data.igorForecast.slice(0, 2500)}
${data.collectionsReport ? `COLLECTIONS REPORT: ${data.collectionsReport}` : ''}
RECURRING ALERTS: ${data.recurringAlerts}
${data.replyEngineStatus ? `REPLY-ENGINE STATUS (use this to answer "is reply-engine firing?" — do NOT say "no data" if this block is present):\n${data.replyEngineStatus}\n` : ''}${data.aurisStatus ? `AURIS NEWSLETTER STATUS (use this verbatim for newsletter status — do NOT say "no data" or "no confirmation" if this block is present):\n${data.aurisStatus}\n` : ''}${data.aurisRetroStatus ? `HARNESS RETRO OPS NOTE (ground truth — a single italic FYI line that belongs at the very END of the brief; keep it verbatim if the draft contains it, do NOT remove it as unsourced and do NOT expand it):\n${data.aurisRetroStatus}\n` : ''}
${data.actionItems ? `ACTION ITEMS: ${data.actionItems.slice(0, 1000)}` : ''}
${data.teamsMessages ? `TEAMS: ${data.teamsMessages.slice(0, 1000)}` : ''}

WORKER ANALYSES (what the workers found — the briefing should reflect these):

DAY SHAPE: ${workerOutputs.dayShape.slice(0, 800)}

MEETING PREP: ${workerOutputs.meetingPrep.slice(0, 800)}

ACTIVE THREADS: ${workerOutputs.activeThreads.slice(0, 800)}

Today is ${data.date}.

VALIDATION CHECKLIST — apply each check to every item in the draft:

1. FACTUAL ACCURACY: Every name, number, dollar amount, date, and role must match the source data exactly. If wrong, fix it.

2. HALLUCINATION CHECK: Every claim must trace to a specific source above. If an item mentions a meeting, email, message, or project that does not appear in the source data, REMOVE IT entirely.

3. STALENESS CHECK: If an action item references something already completed (appears in sent mail, past events, or action items marked done), REMOVE IT.

4. ATTRIBUTION CHECK: Verify Create vs Glossi tags. These people are ALWAYS Create: Suneil Beri, Mark Dacey, Andy Dadekian, Dan Pfister, Molly Levine, Vijay Sodhi, David Miller, Igor Gampel, Maya Krishnan, David Lowe, Joey Samaniego. These are ALWAYS Glossi: Will Erwin, Ricky Solomon. Create and Glossi must NEVER be combined in the same bullet or collapsed line.

5. DATE MATH CHECK: Today is ${data.date}. Verify every relative time reference. Fix any errors.

6. NAME CHECK: Every person must have first AND last name on first mention. Fix any that don't.

7. CONCISENESS EDIT: Remove purely informational bullets with no action/decision implication. Tighten to max 20 words detail per bullet. Collapse thin sections.

8. CROSS-REFERENCE ACCURACY CHECK: For each Active Thread, verify that every person mentioned in that thread is actually named in the SOURCE DATA for that specific topic. If someone is listed under a thread but the raw data does not connect them to it, REMOVE that bullet. Common false connections to watch for:
   - David Lowe appearing in threads he's not part of (he's sales/accounts only)
   - Dan Pfister appearing outside gaming threads without explicit data support
   - People being connected to the Live Sports Deck who aren't Matt Primm or Casey Benesch (unless source data explicitly names them)

9. FINANCIAL SCOPE CHECK: If Igor's forecast data is mentioned, verify the scope is labeled. Igor's forecast is typically Film & Series division only — if the briefing says "Total revenue" without specifying division, add "Film & Series" scope qualifier. Also verify that every person/group name attributed to a financial figure actually appears in the Igor forecast data — do NOT allow names inferred from Teams, email, or other non-financial sources. Marcel Perez is NOT a group head and should never have revenue attributed to him.

10. **IGOR FRESHNESS CHECK**: The Igor forecast source contains a "Forecast email date: YYYY-MM-DD" line. Every Igor-derived figure in the briefing must cite that exact date in M/D format on first mention — e.g., "per Igor's 5/12 forecast, $1.8M". If the briefing says "April 2026 forecast", "May 2026 forecast", "this month's forecast", or quotes Igor numbers WITHOUT any dated citation, REWRITE to add the M/D date. If the source data starts with "CACHED FALLBACK" or contains "WARNING: Using CACHED", the briefing MUST explicitly call out the staleness ("Igor data cached from [date], live fetch failed"). Do NOT let cached numbers be presented as current.

11. **SENT EMAIL RESOLUTION CHECK**: Scan the briefing for action items like "follow up with X", "check in with Y", "circle back on Z". For each, search the sent email data — if Jonathan has already sent on that topic, REMOVE the action item and replace with a resolution note ("Sent [date] — awaiting reply"). Do NOT carry forward stale follow-up reminders when the send is already done.

12. **FIRST-DAY CLAIM CHECK**: Scan for any phrase like "first day", "starts today", "Day 1", "starting Monday", "onboarding this week". For each, verify the source data EXPLICITLY contains a hire date that matches today. If no such date is present, REMOVE the claim. Joey Samaniego must NEVER be framed as new, starting, or onboarding — he has been at Create since well before 2026.

13. **ROUTINE HIRE/ONBOARDING CHECK**: Remove any bullet about routine HR paperwork, NDA routing, department-head hire approvals, form signatures, or vendor onboarding unless Jonathan is the explicit signer or it's a material strategic deal. Items framed as "pending your sign-off" for a Pfister/Primm hire are wrong — they own those decisions.

14. **CASH POSITION LABEL CHECK**: If cash position is in the briefing, the early-pull line MUST use Maya's verbatim line label "Early-pull candidates (MTD collected):" — NOT "Early-pull available", and with NO appended "= $X if needed" or combined sum. It MUST use the studio labels "Apple TV+" and "Walt Disney" (Maya's verbatim Detail-by-Studio row labels) — NEVER "Apple" alone, "Apple TV" without the plus, or "Disney" alone. Both studios must appear (even if one is $0). If the line is reworded, fix it to the verbatim label; if it is missing entirely while other cash data is present, ADD it from the source.

15. **COMPLETENESS CHECK**:
   a. For EACH meeting on today's calendar, verify it appears in the briefing. If a meeting is missing, ADD it.
   b. For each watch topic where the Active Threads worker found signals, verify it's mentioned in the briefing. If a thread with movement was dropped, ADD it.
   c. For each recurring alert active today, verify it's mentioned. If missing, ADD it.
   Flag: "COMPLETENESS: [X meetings verified, Y threads verified, Z alerts verified. Gaps filled: ...]"
   Then REMOVE this flag line from the final output — it's for your internal tracking only.

OUTPUT RULES:
- Return ONLY the corrected briefing in the same markdown format. No commentary, no "here is the corrected version", no diff notes, no completeness flag in output.
- Preserve the exact section structure (## headers) and bullet format (bold headline, [Tag] pill, detail, urgency tag).
- If the draft is already accurate and concise, return it unchanged.
- Target: ${isWeekend ? '600-1000' : '1000-1800'} words. Cut from the bottom of each section's priority stack.`;

  const msg = await withRetry(() => getClient().messages.create({
    model: VALIDATOR_MODEL,
    // Thinking MUST be explicitly disabled: Sonnet 5 turns adaptive thinking ON
    // when the field is omitted, which burns the whole max_tokens budget on
    // thinking and returns an empty brief (stop_reason=max_tokens, no text
    // block). Explicit disable keeps it re-emitting the full validated brief.
    max_tokens: isWeekend ? 3000 : 4000,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  }), 'validator');

  // Defense-in-depth: validator shouldn't re-add a SUBJECT line, but strip
  // one anyway if it appears so it can never bleed into the email body.
  const vRaw = extractText(msg);
  return extractSubjectAndBody(vRaw).body || vRaw;
}

// ---------------------------------------------------------------------------
// Main export: generateBriefingMissions
// ---------------------------------------------------------------------------

export async function generateBriefingMissions(
  data: BriefingData,
  isWeekend: boolean = false,
): Promise<{ body: string; subject: string }> {
  const now = Date.now();

  // Phase 1: Run all 5 workers in parallel. allSettled so a single worker
  // failure (e.g. API timeout on one specialist) doesn't sink the whole brief —
  // assembler receives a placeholder for the failed worker instead.
  console.log('[missions] Phase 1 — launching 4 parallel workers');
  const workerResults = await Promise.allSettled([
    dayShapeWorker(data, isWeekend),
    meetingPrepWorker(data, isWeekend),
    activeThreadsWorker(data, isWeekend),
    intelWorker(data, isWeekend),
  ]);
  console.log(`[missions] Phase 1 complete — workers finished in ${((Date.now() - now) / 1000).toFixed(1)}s`);

  const workerNames = ['dayShape', 'meetingPrep', 'activeThreads', 'intel'] as const;
  const resolved = workerResults.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.log(`[missions] WORKER FAILED — ${workerNames[i]}: ${r.reason?.message?.slice(0, 200)}`);
    return `(${workerNames[i]} worker unavailable — upstream failure: ${r.reason?.message?.slice(0, 100) ?? 'unknown'})`;
  });
  const [dayShape, meetingPrep, activeThreads, intel] = resolved;
  const workers = { dayShape, meetingPrep, activeThreads, intel };

  // Phase 2: Assembler (Opus)
  const assembleStart = Date.now();
  console.log('[missions] Phase 2 — assembling briefing with Opus');
  const { body: assembledBody, subject } = await assembleBriefing(workers, data, isWeekend);
  console.log(`[missions] Phase 2 complete — assembled in ${((Date.now() - assembleStart) / 1000).toFixed(1)}s`);

  // Phase 3: Validator (Sonnet)
  const validateStart = Date.now();
  console.log('[missions] Phase 3 — validating and completeness-checking');
  const validatedBody = await validateMissions(assembledBody, workers, data, isWeekend);
  console.log(`[missions] Phase 3 complete — validated in ${((Date.now() - validateStart) / 1000).toFixed(1)}s`);

  // Regression check (non-blocking): verify promoted rules are still respected
  checkBriefingForRegressions(validatedBody, 'morning').then(regressions => {
    for (const r of regressions) {
      console.log(`[regression] Promoted rule "${r.rule_id}" violated: "${r.violation_quote}"`);
    }
  }).catch(err => {
    console.log(`[regression] check failed (non-blocking): ${err.message}`);
  });

  const totalTime = ((Date.now() - now) / 1000).toFixed(1);
  console.log(`[missions] Pipeline complete — total ${totalTime}s`);

  return {
    body: validatedBody,
    subject: subject || (isWeekend ? 'Weekend Briefing' : 'Morning Briefing'),
  };
}

// ---------------------------------------------------------------------------
// Afternoon Sync — Missions variant (3 workers)
// ---------------------------------------------------------------------------

// ---- Afternoon Worker 1: Schedule ----
async function afternoonScheduleWorker(data: AfternoonData): Promise<string> {
  const prompt = `You are a scheduling analyst. It's 3 PM on ${data.date}.
${rulesBlock(data.feedback)}
TASKS:
1. List what's LEFT on today's calendar from 3 PM onward, with times, attendees, location.
2. List tomorrow's full calendar.
3. Note if the rest of today is clear.

Time format: 12-hour AM/PM. Full names for all attendees. David Stern is NOT in weekly Management Meetings.

Target: 100-200 words.

---

CALENDAR:
${data.calendar}`;

  const msg = await withRetry(() => getClient().messages.create({
    model: CHEAP_MODEL, // Haiku 4.5 — "what's left today" is a mechanical calendar read
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  }), 'afternoon-worker-schedule');
  return extractText(msg);
}

// ---- Afternoon Worker 2: Threads ----
async function afternoonThreadsWorker(data: AfternoonData): Promise<string> {
  const prompt = `You are tracking what changed since this morning for Jonathan Gitlin, CEO of Create / Executive Chairman of Glossi.
${rulesBlock(data.feedback)}
Today is ${data.date}, 3 PM.

TASKS:
1. Compare new emails, iMessages, and Teams messages against this morning's briefing. Surface only what's NEW — not already covered.
2. RESOLVE OPEN ACTION ITEMS: For EACH action item the morning briefing flagged as "action needed" or "carry forward," actively search the sent emails, iMessages, and Teams for evidence it was completed. A sent email about the topic = done. A meeting where it was discussed = done. Be aggressive about matching — if the morning said "send Glossi investor update email" and you see a sent email to investors or about Glossi updates, that's a match. Mark resolved items as DONE, not "still no confirmation."
3. Check if today is an Auris Markets newsletter send day (Monday=Company, Wednesday=Gaming, Friday=Films/Series). Look for evidence it was sent (email from weeklyroundup@auris-ai.io). If today is a send day and no evidence it was sent, flag it prominently.
4. CHECK SENT EMAILS: Scan ALL "[Sent]" emails for actions that were completed. If Jonathan sent an email related to an open thread or action item, mark it done. Do not carry forward items that have evidence of completion in the sent mail.

TAGGING: Create is default. Only [Glossi] for Glossi-specific. Never combine in same bullet. Full names on first mention.

Target: 200-400 words.

---

${data.morningBriefing ? `THIS MORNING'S BRIEFING (context — only flag what's NEW):\n${data.morningBriefing.slice(0, 3000)}\n` : ''}
EMAIL:
${data.email}

IMESSAGES:
${data.imessages}

${data.teamsMessages ? `TEAMS:\n${data.teamsMessages}\n` : ''}
WATCH TOPICS:
${data.reminders}

${data.actionItems ? `ACTION ITEMS:\n${data.actionItems}\n` : ''}
RECURRING ALERTS:
${data.recurringAlerts}`;

  const msg = await withRetry(() => getClient().messages.create({
    model: WORKER_MODEL,
    max_tokens: 800,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  }), 'afternoon-worker-threads');
  return extractText(msg);
}

// ---- Afternoon Assembler ----
async function assembleAfternoonSync(
  workers: { schedule: string; threads: string },
  data: AfternoonData,
): Promise<{ body: string; subject: string }> {

  const prompt = `You are Jonathan's afternoon sync assistant, writing in the voice of Create — precise, restrained, quietly authoritative. This is a 3 PM check-in: lighter and faster than the morning briefing. Focus on what changed since this morning and what's left for today.

Today is ${data.date}. It's 3 PM.
${data.feedback ? `
JONATHAN'S FEEDBACK & PERSISTENT RULES (follow these every time):
${data.feedback}
` : ''}

VOICE: Calm, senior creative executive. "Quick huddle" not "crisis briefing." Think editorial, not urgent-alarm.
NAME RULE: First AND last name on first mention.
TIME FORMAT: 12-hour AM/PM.
TAGGING: Create is default. Only [Glossi] for Glossi-specific. NEVER combine in same bullet.

SUBJECT LINE: First line "SUBJECT:" with 2-3 key items, under 70 chars, "|" separator.

${data.graphTokenHealth ? `## System Alert
INCLUDE THIS VERBATIM at the very top of the sync, before "Rest of Day":
${data.graphTokenHealth}

` : ''}FORMAT — AFTERNOON SYNC:

## Rest of Day
What's left on the calendar from now through evening. Max 5 items.
- **Headline** [Tag] — detail. **urgency tag**
- If clear: "Clear through end of day."

## Since This Morning
New emails, iMessages, Teams that need attention. Only what's NEW.
- Max 6 items. Tag each: **urgent** / **action needed** / **FYI**

## New Projects
Look in NOTION PROJECTS data for entries flagged 🆕 — those are projects added to the tracker since this morning's brief. List each one as: **Project name** [Client] — team. Nothing more. NO due dates, NO status, NO phase.
- Surface ALL new projects across ALL teams (London, Content, Madness, Design, Social, every department).
- If there are zero 🆕-flagged projects, write exactly: "No new projects added since this morning." and skip the rest of the section.
- Do NOT include projects without a 🆕 flag. Do NOT include due-date proximity, status changes, or phase moves.

## Still Open
Action items from morning (or prior days) not yet resolved.
- If the Threads worker marked something as DONE, show it with a checkmark and move on — do NOT carry it forward as open.
- Only list items that are genuinely still unresolved with no evidence of completion in sent emails, messages, or completed meetings.
- Check Auris newsletter status if today is a send day.
- Max 5 items. If all handled: "All clear — nothing outstanding."

## Tomorrow Preview
Quick glance at tomorrow. Max 3 items. If light, say so.

---

${data.replyEngineStatus ? `REPLY-ENGINE STATUS (use this to answer "is reply-engine firing?" — do NOT say "no data" if this block is present):\n${data.replyEngineStatus}\n\n` : ''}${data.aurisStatus ? `AURIS NEWSLETTER STATUS (use this verbatim — do NOT say "no confirmation" if this block is present):\n${data.aurisStatus}\n\n` : ''}NOTION PROJECTS (look for 🆕 flags — that's the source of truth for the "New Projects" section):
${data.notionProjects}

WORKER ANALYSES:

=== SCHEDULE ===
${workers.schedule}

=== THREADS & UPDATES ===
${workers.threads}`;

  const msg = await withRetry(() => getClient().messages.create({
    model: ASSEMBLER_MODEL,
    max_tokens: 2500, // afternoon sync is shorter; thinking off (see morning assembler note)
    messages: [{ role: 'user', content: prompt }],
  }), 'afternoon-assembler');

  const rawBody = extractText(msg);

  let subject = '';
  let body = rawBody;
  const parsed = extractSubjectAndBody(rawBody);
  subject = parsed.subject;
  body = parsed.body;

  return {
    body,
    subject: subject || 'Afternoon Sync',
  };
}

export async function generateAfternoonSyncMissions(
  data: AfternoonData,
): Promise<{ body: string; subject: string }> {
  const now = Date.now();

  // Phase 1: Run 2 afternoon workers in parallel (allSettled — one failed worker
  // won't sink the sync; assembler receives a placeholder).
  console.log('[missions-pm] Phase 1 — launching 2 parallel workers');
  const pmResults = await Promise.allSettled([
    afternoonScheduleWorker(data),
    afternoonThreadsWorker(data),
  ]);
  console.log(`[missions-pm] Phase 1 complete — ${((Date.now() - now) / 1000).toFixed(1)}s`);

  const pmNames = ['schedule', 'threads'] as const;
  const pmResolved = pmResults.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.log(`[missions-pm] WORKER FAILED — ${pmNames[i]}: ${r.reason?.message?.slice(0, 200)}`);
    return `(${pmNames[i]} worker unavailable — upstream failure: ${r.reason?.message?.slice(0, 100) ?? 'unknown'})`;
  });
  const [schedule, threads] = pmResolved;
  const workers = { schedule, threads };

  // Phase 2: Assemble with Opus
  const assembleStart = Date.now();
  console.log('[missions-pm] Phase 2 — assembling afternoon sync');
  const result = await assembleAfternoonSync(workers, data);
  console.log(`[missions-pm] Phase 2 complete — ${((Date.now() - assembleStart) / 1000).toFixed(1)}s`);

  const totalTime = ((Date.now() - now) / 1000).toFixed(1);
  console.log(`[missions-pm] Pipeline complete — total ${totalTime}s`);

  return result;
}
