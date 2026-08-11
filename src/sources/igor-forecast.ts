import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink, stat as fsStat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { graphGet, isGraphConfigured } from './graph-client';

const exec = promisify(execFile);

const CACHE_DIR = join(homedir(), 'briefing-data');

const SUBJECT_RE = /forecast|p&l|financial|revenue|monthly/i;

/**
 * Finds Igor Gampel's most recent forecast and returns the body context plus the
 * actual forecast figures from the PDF.
 *
 * MS Graph FIRST (reliable, no Mail.app, no launchd TCC hangs), CACHE FALLBACK.
 * The previous implementation drove Apple Mail via AppleScript, which hangs in a
 * synchronous Apple Event when Mail is busy — the same fragility email/calendar
 * were already migrated off. Graph removes it entirely.
 *
 * The forecast NUMBERS live in a PDF attachment, but the newest subject-matching
 * email is often a discussion reply with no attachment. So we take the body from
 * the newest matching email (latest context/caveats) and the PDF from the newest
 * matching email that actually HAS one (falling back to the last cached PDF), each
 * clearly dated — the figures never silently drop out.
 */
export async function fetchIgorForecast(): Promise<string> {
  const pdfPath = join(CACHE_DIR, 'igor-forecast.pdf');
  const metaPath = join(CACHE_DIR, 'igor-forecast.meta.json');

  if (isGraphConfigured()) {
    try {
      const result = await fetchViaGraph(pdfPath, metaPath);
      if (result) return result;
      console.log('[igor] Graph: no matching forecast email — trying cache');
    } catch (err: any) {
      console.log(`[igor] Graph fetch failed (${err.message?.slice(0, 100)}) — falling back to cache`);
    }
  } else {
    console.log('[igor] Graph not configured — using cache');
  }

  const cache = await readCachedPdf(pdfPath, metaPath);
  return cache
    ? `Subject: Igor Forecast (CACHED FALLBACK)\n\nWARNING: Live fetch unavailable. Using CACHED forecast PDF from email dated ${cache.forecastEmailDate ?? 'unknown'} (${cache.ageDays}d old) — a newer forecast may exist.\n\nPDF Content:\n${cache.text}`
    : '(Igor forecast unavailable — live fetch failed and no usable cache)';
}

/**
 * Graph path: find Igor's matching messages, use the newest for body context and
 * the newest one carrying a PDF for the figures.
 */
async function fetchViaGraph(pdfPath: string, metaPath: string): Promise<string | null> {
  // $search matches the `from` field on display name AND address (so it hits
  // "Igor Gampel" even though the address is igor.gampel@…). $search cannot be
  // combined with $orderby, so we sort/filter client-side.
  const list = await graphGet('/me/messages', {
    '$search': '"from:igor"',
    '$top': '25',
    '$select': 'id,subject,from,receivedDateTime,hasAttachments',
  });
  if (!list) return null; // null = no access token (reauth needed) → caller falls back

  const cutoff = Date.now() - 30 * 86400 * 1000;
  const candidates = (list.value || [])
    .filter((m: any) => SUBJECT_RE.test(m.subject || ''))
    .filter((m: any) => m.receivedDateTime && new Date(m.receivedDateTime).getTime() >= cutoff)
    .sort((a: any, b: any) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime());

  const bodyMsg = candidates[0];
  if (!bodyMsg) return null;

  const bodyDate = isoDate(bodyMsg.receivedDateTime);

  // Full body of the newest matching email, as plain text. Graph message IDs
  // contain '/', '+', '=' — they MUST be URL-encoded or the path breaks.
  const full = await graphGet(
    `/me/messages/${encodeURIComponent(bodyMsg.id)}`,
    { '$select': 'subject,receivedDateTime,body' },
    { 'Prefer': 'outlook.body-content-type="text"' },
  );
  const bodyText = cleanBody(full?.body?.content || '');

  // Walk candidates newest-first to find the most recent one carrying a PDF.
  let pdf: { text: string; date: string | null } | null = null;
  for (const m of candidates) {
    if (!m.hasAttachments) continue;
    try {
      // List attachments WITHOUT contentBytes ($select of contentBytes is rejected
      // on the polymorphic collection), find the PDF, then fetch that one by id —
      // the single-attachment GET includes contentBytes for fileAttachments.
      const atts = await graphGet(`/me/messages/${encodeURIComponent(m.id)}/attachments`, { '$select': 'id,name,contentType' });
      const meta = (atts?.value || []).find((a: any) =>
        /\.pdf$/i.test(a.name || '') || a.contentType === 'application/pdf',
      );
      if (!meta) continue;
      const file = await graphGet(`/me/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(meta.id)}`);
      if (!file?.contentBytes) continue;
      await writeFile(pdfPath, Buffer.from(file.contentBytes, 'base64'));
      const text = await extractPdfText(pdfPath);
      if (text) {
        pdf = { text, date: isoDate(m.receivedDateTime) };
        try {
          await writeFile(metaPath, JSON.stringify({ forecastEmailDate: pdf.date, cachedAt: new Date().toISOString() }, null, 2));
        } catch {}
        break;
      }
    } catch (err: any) {
      console.log(`[igor] attachment fetch error on one candidate: ${err.message?.slice(0, 80)}`);
    }
  }

  let out = `Forecast email date: ${bodyDate ?? 'unknown'}\nSubject: ${bodyMsg.subject}\n\nBody:\n${bodyText}`;

  if (pdf) {
    const sameEmail = pdf.date === bodyDate;
    const label = sameEmail ? 'PDF Content:' : `Forecast figures (PDF from email dated ${pdf.date ?? 'unknown'}):\nPDF Content:`;
    out += `\n\n${label}\n${pdf.text}`;
  } else {
    // Newest matching email(s) had no usable PDF — keep the figures from the last
    // cached PDF so the numbers never disappear, clearly labeled as older.
    const cache = await readCachedPdf(pdfPath, metaPath);
    if (cache) {
      out += `\n\n(Latest email carries no PDF; most recent forecast PDF on file is dated ${cache.forecastEmailDate ?? 'unknown'}, ${cache.ageDays}d old.)\nPDF Content:\n${cache.text}`;
    }
  }

  console.log(`[igor] Graph fetch succeeded — body dated ${bodyDate ?? 'unknown'}, PDF dated ${pdf?.date ?? '(cache/none)'}`);
  return out;
}

/** Read + extract the cached forecast PDF, with its recorded email date and age. */
async function readCachedPdf(pdfPath: string, metaPath: string): Promise<{ text: string; forecastEmailDate: string | null; ageDays: number } | null> {
  try {
    const pdfStat = await fsStat(pdfPath);
    const ageDays = Math.round((Date.now() - pdfStat.mtimeMs) / 86400000);
    let forecastEmailDate: string | null = null;
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      forecastEmailDate = meta.forecastEmailDate ?? null;
    } catch {}
    const text = await extractPdfText(pdfPath);
    if (text) return { text, forecastEmailDate, ageDays };
  } catch {}
  return null;
}

function isoDate(dt?: string): string | null {
  return dt ? new Date(dt).toISOString().split('T')[0] : null;
}

/**
 * Keep only Igor's latest message: strip Outlook safelink/angle-bracket URLs and
 * cut the quoted reply history (which otherwise balloons the body to tens of
 * thousands of chars of thread noise), then cap length.
 */
function cleanBody(raw: string): string {
  let t = (raw || '').replace(/\r/g, '');
  t = t.replace(/<https?:\/\/[^>]+>/g, '').replace(/<mailto:[^>]+>/g, '');
  const markers = [/\nFrom: /, /\nOn .*wrote:/, /-----Original Message-----/, /________________________________/];
  let cut = t.length;
  for (const re of markers) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return t.slice(0, cut).replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
}

async function extractPdfText(pdfPath: string): Promise<string> {
  // Try multiple approaches to extract PDF text

  // 1. Try pdftotext (poppler) — most reliable
  try {
    const { stdout } = await exec('/opt/homebrew/bin/pdftotext', [pdfPath, '-'], { timeout: 10000 });
    if (stdout.trim()) return stdout.trim();
  } catch {}

  // 2. Try Python with pdfplumber (handles tables well)
  try {
    const pyScript = `
import sys
try:
    import pdfplumber
    with pdfplumber.open("${pdfPath}") as pdf:
        text = []
        for page in pdf.pages:
            t = page.extract_text()
            if t:
                text.append(t)
        print("\\n".join(text))
except ImportError:
    try:
        import PyPDF2
        reader = PyPDF2.PdfReader("${pdfPath}")
        text = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                text.append(t)
        print("\\n".join(text))
    except:
        print("")
`;
    const { stdout } = await exec('python3', ['-c', pyScript], { timeout: 15000 });
    if (stdout.trim()) return stdout.trim();
  } catch {}

  // 3. Try mdls + textutil as last resort (macOS built-in)
  try {
    const tmpTxt = pdfPath.replace('.pdf', '.txt');
    await exec('textutil', ['-convert', 'txt', '-output', tmpTxt, pdfPath], { timeout: 10000 });
    const content = await readFile(tmpTxt, 'utf-8');
    try { await unlink(tmpTxt); } catch {}
    if (content.trim()) return content.trim();
  } catch {}

  return '';
}
