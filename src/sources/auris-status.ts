/**
 * Auris Markets newsletter send-detection.
 *
 * Three editions: Monday (Company), Wednesday (Gaming), Friday (Films/Series).
 * Jonathan receives a copy in his inbox when each goes out. The original
 * detection embedded in claude.ts grepped the broad email feed for substrings,
 * which is fragile (scope, casing, truncation). This module does a focused
 * Graph API search and returns a structured signal the assembler can use.
 */

import { graphGet, isGraphConfigured } from './graph-client';

export interface AurisStatus {
  isSendDay: boolean;
  edition: 'Company' | 'Gaming' | 'Films/Series' | null;
  detected: boolean;
  emailDate: string | null;
  emailSubject: string | null;
  message: string;
}

/**
 * Returns the human-readable status string for the brief, plus the structured
 * signal so the assembler can decide whether to flag as action-needed.
 */
export async function fetchAurisStatus(): Promise<string> {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  let edition: AurisStatus['edition'] = null;
  if (dow === 1) edition = 'Company';
  else if (dow === 3) edition = 'Gaming';
  else if (dow === 5) edition = 'Films/Series';

  if (!edition) {
    return ''; // not a send day — nothing to surface
  }

  if (!isGraphConfigured()) {
    return `AURIS MARKETS: today is ${edition} send day. Graph not configured — check inbox manually.`;
  }

  // Search inbox for newsletter from weeklyroundup@auris-ai.io OR with subject pattern.
  // Uses graphGet so token recovery + refresh dedup handled centrally.
  const since = new Date(today);
  since.setHours(0, 0, 0, 0);
  const sinceISO = since.toISOString();

  try {
    // Primary query: by sender
    const data = await graphGet('/me/messages', {
      '$filter': `receivedDateTime ge ${sinceISO} and (from/emailAddress/address eq 'weeklyroundup@auris-ai.io' or contains(from/emailAddress/address, 'auris-ai.io'))`,
      '$top': '5',
      '$select': 'subject,from,receivedDateTime',
      '$orderby': 'receivedDateTime desc',
    });

    const m = (data?.value || [])[0];
    if (m) {
      const date = new Date(m.receivedDateTime);
      const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      return `AURIS MARKETS: ✓ ${edition} edition SENT today at ${time} — subject: "${m.subject}". No action needed.`;
    }

    // Fallback by subject ($search requires ConsistencyLevel: eventual)
    const subjData = await graphGet(
      '/me/messages',
      { '$search': '"Auris Markets"', '$top': '5', '$select': 'subject,from,receivedDateTime' },
      { ConsistencyLevel: 'eventual' },
    );
    const todayMatch = (subjData?.value || []).find((m: any) => {
      const d = new Date(m.receivedDateTime);
      return d.toDateString() === today.toDateString() && /auris/i.test(m.subject || '');
    });
    if (todayMatch) {
      const time = new Date(todayMatch.receivedDateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      return `AURIS MARKETS: ✓ ${edition} edition SENT today at ${time} — subject: "${todayMatch.subject}". No action needed.`;
    }
  } catch (err: any) {
    // Full error logged (no truncation) so debugging is possible if it recurs
    console.log(`[auris] Graph search failed: ${err.message}`);
    return `AURIS MARKETS: ${edition} edition send day — Graph search failed (${err.message?.slice(0, 120)}). Check inbox manually.`;
  }

  // No newsletter found yet today
  const hour = today.getHours();
  if (hour < 17) {
    return `AURIS MARKETS: ${edition} edition send day — not yet detected in inbox (typically sends after 5pm). FYI, check again later.`;
  }
  return `AURIS MARKETS: ⚠️ ${edition} edition send day — NO inbox confirmation as of ${today.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}. Verify it shipped.`;
}
