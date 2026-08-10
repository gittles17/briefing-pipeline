/**
 * Recurring monthly/weekly alerts surfaced into the briefing prompt.
 * The actual briefing generation lives in claude-missions.ts; this module
 * exists only as the canonical home for getRecurringAlerts, which both
 * index.ts and afternoon.ts import.
 */

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
      // Compute the actual day-of-week for the event so the model doesn't
      // confabulate (e.g. calling April 23 "Wednesday" when it's Thursday).
      const eventDate = new Date(today.getFullYear(), event.month - 1, event.day);
      const dow = eventDate.toLocaleDateString('en-US', { weekday: 'long' });
      if (daysUntil === 0) alerts.push(`🎂 Today: ${event.label}!`);
      else alerts.push(`🎂 ${event.label} is ${dow}, ${event.month}/${event.day} — ${daysUntil} day${daysUntil > 1 ? 's' : ''} out. DO NOT state a different day of the week; ${event.month}/${event.day} is ${dow}.`);
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
