import nodemailer from 'nodemailer';

let _transporter: nodemailer.Transporter;
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: 587,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      }
    });
  }
  return _transporter;
}

// Create brand logo SVGs (dark for light bg, light for dark bg)
const LOGO_DARK = `<svg viewBox="0 0 318.37 44.22" xmlns="http://www.w3.org/2000/svg" style="height: 14px; width: auto;"><g fill="#171717"><path d="M0,22.14v-.06C0,8.26,12.86,0,31.26,0c15.08,0,27.07,5.7,30.1,15.28h-12.94c-2.37-4.85-9.63-6.87-16.99-6.87-10.1,0-19.13,4.28-19.13,13.67v.06c0,9.39,9.03,13.67,19.13,13.67,7.36,0,14.61-2.02,16.99-6.87h12.94c-3.03,9.57-15.04,15.28-30.13,15.28C12.83,44.22,0,35.97,0,22.14Z"/><path d="M64.1.96h32.19c11.86,0,19.89,3.27,19.89,13.86v.06c0,10.64-7.99,13.91-19.85,13.91h-20.44v14.48h-11.78V.96ZM94.86,20.44c6.12,0,9-1.22,9-5.56v-.06c0-4.28-2.88-5.51-9-5.51h-18.98v11.13h18.98Z"/><path d="M119.15.96h48.4v8.58h-36.62v8.1h34.89v8.58h-34.89v8.45h36.77v8.58h-48.55V.96Z"/><path d="M185.39.96h15.21l22.76,42.3h-12.92l-5.58-10.38h-24.53l-5.56,10.38h-12.14L185.39.96ZM200.54,24.35l-7.95-14.9h-.06l-7.92,14.9h15.93Z"/><path d="M232.59,9.55h-22.22V.96h56.25v8.59h-22.24v33.72h-11.78V9.55Z"/><path d="M269.82.96h48.4v8.58h-36.62v8.1h34.89v8.58h-34.89v8.45h36.77v8.58h-48.55V.96Z"/></g><polygon fill="#171717" points="98.47 26.77 84.89 26.77 84.81 28.59 101.44 43.26 116.85 43.26 98.47 26.77"/></svg>`;

const LOGO_LIGHT = LOGO_DARK.replace(/fill="#171717"/g, 'fill="#FFFFFF"');

// Create brand color tokens
const C = {
  bg: '#FAFAFA',
  surface: '#FFFFFF',
  surfaceAlt: '#F5F5F5',
  border: '#E5E5E5',
  borderDark: '#D4D4D4',
  text: '#171717',
  text2: '#525252',
  text3: '#8A8A8A',
  text4: '#ADADAD',
  accent: '#C0392B',
  dark: '#1A1A1A',
};

// Typography constants
const FONT = {
  sans: "Baikal, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  mono: "'IBM Plex Mono', 'SF Mono', Menlo, monospace",
};

function feedbackLinks(text: string, section?: string): string {
  const clean = text.replace(/<[^>]+>/g, '').trim();
  const truncated = clean.slice(0, 60);
  const sectionTag = section ? `[${section}] ` : '';
  const encoded = encodeURIComponent(`${sectionTag}${truncated}`);
  const smtpUser = process.env.SMTP_USER || '';
  const up = `mailto:${smtpUser}?subject=${encodeURIComponent('+')}%20${encoded}&body=${encodeURIComponent('Good item — keep including this.')}`;
  const downBody = encodeURIComponent(`What should change? (more/less/different angle/remove entirely)\n\n`);
  const down = `mailto:${smtpUser}?subject=${encodeURIComponent('−')}%20${encoded}&body=${downBody}`;

  return `<span style="white-space: nowrap; margin-left: 6px; opacity: 0.33;"><a href="${up}" style="text-decoration: none; font-size: 10px; color: ${C.text3}; font-family: ${FONT.mono};">+</a>&thinsp;<a href="${down}" style="text-decoration: none; font-size: 10px; color: ${C.text3}; font-family: ${FONT.mono};">&minus;</a></span>`;
}

function markdownToHtml(md: string): string {
  // Inline formatting
  // Tag pill colors
  const pills: Record<string, { bg: string; text: string }> = {
    Create:   { bg: '#EDE9FE', text: '#6D28D9' },
    Glossi:   { bg: '#DBEAFE', text: '#1D4ED8' },
    Personal: { bg: '#FEF3C7', text: '#92400E' },
  };
  const pillStyle = (bg: string, fg: string) =>
    `display: inline-block; font-family: ${FONT.mono}; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; background: ${bg}; color: ${fg}; padding: 3px 8px; border-radius: 4px; margin-right: 6px; vertical-align: middle;`;

  let result = md
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" style="color: ${C.accent}; text-decoration: none; border-bottom: 1px solid ${C.border};">$1</a>`)
    .replace(/\*\*(.+?)\*\*/g, `<strong style="color: ${C.text}; font-weight: 700;">$1</strong>`)
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---$/gm, '');

  // Move [Tag] pills to AFTER the first bold phrase in each bullet, then style as pills
  // Pattern: "**[Tag]** **headline**" → "**headline** [Tag]"
  for (const label of Object.keys(pills)) {
    // Handle: <strong>[Tag]</strong> <strong>headline</strong>
    const swapBold = new RegExp(
      `<strong[^>]*>\\[${label}\\]</strong>\\s*(<strong[^>]*>.*?</strong>)`,
      'g'
    );
    result = result.replace(swapBold, `$1 [${label}]`);

    // Handle: **[Tag]** **headline** (pre-markdown conversion)
    const swapMd = new RegExp(
      `\\*\\*\\[${label}\\]\\*\\*\\s*(\\*\\*.*?\\*\\*)`,
      'g'
    );
    result = result.replace(swapMd, `$1 [${label}]`);
  }

  // Now replace remaining [Tag] text with styled pills
  for (const [label, colors] of Object.entries(pills)) {
    const pill = `<span style="${pillStyle(colors.bg, colors.text)}">${label}</span>`;
    result = result.replace(new RegExp(`<strong[^>]*>\\[${label}\\]</strong>`, 'g'), pill);
    result = result.replace(new RegExp(`\\[${label}\\]`, 'g'), pill);
  }

  // Block-level, line by line — track current section for feedback context
  let currentSection = '';
  return result.split('\n').map(line => {
    // H3 — subsection
    if (/^### (.+)$/.test(line)) {
      const match = line.match(/^### (.+)$/);
      if (match) currentSection = match[1].replace(/<[^>]+>/g, '').trim();
      return line.replace(/^### (.+)$/, `<h3 style="font-family: ${FONT.sans}; font-size: 15px; font-weight: 600; margin: 28px 0 8px; color: ${C.text}; letter-spacing: -0.01em;">$1</h3>`);
    }
    // H2 with number prefix
    if (/^## (\d+)\. (.+)$/.test(line)) {
      const match = line.match(/^## (\d+)\. (.+)$/);
      if (match) currentSection = match[2].replace(/<[^>]+>/g, '').trim();
      return line.replace(/^## (\d+)\. (.+)$/, `<div style="border-top: 1px solid ${C.border}; margin-top: 36px; padding-top: 24px;"><span style="font-family: ${FONT.mono}; font-size: 11px; color: ${C.accent}; letter-spacing: 0.08em; text-transform: uppercase;">$1</span><h2 style="font-family: ${FONT.sans}; font-size: 20px; font-weight: 700; margin: 4px 0 12px; color: ${C.text}; letter-spacing: -0.02em;">$2</h2></div>`);
    }
    // H2 — section
    if (/^## (.+)$/.test(line)) {
      const match = line.match(/^## (.+)$/);
      if (match) currentSection = match[1].replace(/<[^>]+>/g, '').trim();
      return line.replace(/^## (.+)$/, `<div style="border-top: 1px solid ${C.border}; margin-top: 36px; padding-top: 24px;"><h2 style="font-family: ${FONT.sans}; font-size: 20px; font-weight: 700; margin: 0 0 12px; color: ${C.text}; letter-spacing: -0.02em;">$1</h2></div>`);
    }
    // H1
    if (/^# (.+)$/.test(line)) {
      return line.replace(/^# (.+)$/, `<h1 style="font-family: ${FONT.sans}; font-size: 24px; font-weight: 700; margin: 0 0 16px; color: ${C.text}; letter-spacing: -0.025em;">$1</h1>`);
    }

    // List items with feedback
    const bulletMatch = line.match(/^[-*] (.+)$/) || line.match(/^\d+\. (.+)$/);
    if (bulletMatch) {
      const content = bulletMatch[1];
      return `<li style="margin: 6px 0; padding-left: 4px; color: ${C.text2}; font-size: 15px; line-height: 1.7;">${content} ${feedbackLinks(content, currentSection)}</li>`;
    }

    if (line.trim() === '') return '';

    // Regular paragraph
    return `<p style="margin: 8px 0; color: ${C.text2}; line-height: 1.7; font-size: 15px;">${line}</p>`;
  }).join('\n');
}

export async function sendBriefing(briefingText: string, date: string, subject?: string, isWeekend: boolean = false, mode: 'morning' | 'afternoon' = 'morning') {
  const bodyHtml = markdownToHtml(briefingText);
  const briefingLabel = mode === 'afternoon' ? 'Afternoon Sync' : (isWeekend ? 'Weekend Briefing' : 'Morning Briefing');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: ${C.bg};">
  <div style="font-family: ${FONT.sans}; max-width: 640px; margin: 0 auto; background: ${C.surface}; padding: 0;">

    <!-- Dark header -->
    <div style="background: ${C.dark}; padding: 36px 40px 32px;">
      <div style="margin-bottom: 24px;">${LOGO_LIGHT}</div>
      <div style="width: 40px; height: 3px; background: ${C.accent}; margin-bottom: 16px;"></div>
      <p style="font-family: ${FONT.mono}; font-size: 11px; color: ${C.text3}; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 6px;">${briefingLabel}</p>
      <h1 style="font-family: ${FONT.sans}; font-size: 24px; font-weight: 700; color: #FFFFFF; margin: 0; letter-spacing: -0.025em;">${date}</h1>
    </div>

    <!-- Content -->
    <div style="padding: 36px 40px; font-size: 15px; line-height: 1.7; color: ${C.text2};">
      ${bodyHtml}
    </div>

    <!-- Feedback -->
    <div style="padding: 20px 40px; border-top: 1px solid ${C.border}; text-align: center;">
      <p style="font-family: ${FONT.mono}; font-size: 10px; color: ${C.text4}; margin: 0 0 10px; letter-spacing: 0.08em; text-transform: uppercase;">Overall</p>
      <a href="mailto:${process.env.SMTP_USER}?subject=Briefing%20Feedback%20%2B&body=Good%20briefing%20today." style="text-decoration: none; font-size: 14px; color: ${C.text3}; margin: 0 10px; font-family: ${FONT.mono};">+</a>
      <a href="mailto:${process.env.SMTP_USER}?subject=Briefing%20Feedback%20%E2%88%92&body=Here%27s%20what%20to%20improve%3A%0A%0A" style="text-decoration: none; font-size: 14px; color: ${C.text3}; margin: 0 10px; font-family: ${FONT.mono};">&minus;</a>
    </div>

    <!-- Footer -->
    <div style="padding: 24px 40px; border-top: 1px solid ${C.border};">
      <div style="margin-bottom: 8px;">${LOGO_DARK}</div>
      <p style="font-family: ${FONT.mono}; font-size: 10px; color: ${C.text4}; margin: 0;">${briefingLabel} / Create</p>
    </div>
  </div>
</body>
</html>`;

  await getTransporter().sendMail({
    from: `"${mode === 'afternoon' ? 'Afternoon Sync' : 'Morning Brief'} for JG" <${process.env.SMTP_USER}>`,
    to: process.env.RECIPIENT_EMAIL,
    subject: subject ? `${subject} — ${date.replace(/^[A-Za-z]+, /, '')}` : `Briefing — ${date}`,
    text: briefingText,
    html,
  });
}
