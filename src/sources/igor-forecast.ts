import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink, stat as fsStat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { runOsascript } from '../utils/retry-osascript';

const exec = promisify(execFile);

const CACHE_DIR = join(homedir(), 'briefing-data');

/**
 * Finds the most recent forecast email from Igor Gampel,
 * extracts the body text and any PDF attachment content.
 */
export async function fetchIgorForecast(): Promise<string> {
  // AppleScript to find Igor's latest forecast email and extract body + save PDF.
  // Also emits the email's date so we can detect stale caches.
  const pdfPath = join(CACHE_DIR, 'igor-forecast.pdf');
  const metaPath = join(CACHE_DIR, 'igor-forecast.meta.json');
  const script = `
tell application "Mail"
  set cutoff to (current date) - 30 * days
  set output to ""
  set foundMsg to missing value
  set latestDate to date "Monday, January 1, 2024 at 12:00:00 AM"

  -- Search all accounts for Igor's forecast emails
  repeat with acct in every account
    repeat with mb in every mailbox of acct
      try
        set msgs to (every message of mb whose date received is greater than cutoff and sender contains "igor")
        repeat with msg in msgs
          try
            set subj to subject of msg
            set subjLower to do shell script "echo " & quoted form of subj & " | tr '[:upper:]' '[:lower:]'"
            if subjLower contains "forecast" or subjLower contains "p&l" or subjLower contains "financial" or subjLower contains "revenue" or subjLower contains "monthly" then
              if date received of msg > latestDate then
                set latestDate to date received of msg
                set foundMsg to msg
              end if
            end if
          end try
        end repeat
      end try
    end repeat
  end repeat

  if foundMsg is not missing value then
    set subj to subject of foundMsg
    set bod to content of foundMsg
    set emailDate to date received of foundMsg
    set isoDate to (year of emailDate as text) & "-" & text -2 thru -1 of ("0" & ((month of emailDate as integer) as text)) & "-" & text -2 thru -1 of ("0" & (day of emailDate as text))
    set output to "EMAIL_DATE: " & isoDate & linefeed & "Subject: " & subj & linefeed & linefeed & "Body:" & linefeed & bod

    -- Save first PDF attachment
    set attachList to every mail attachment of foundMsg
    repeat with att in attachList
      try
        set attName to name of att
        set attNameLower to do shell script "echo " & quoted form of attName & " | tr '[:upper:]' '[:lower:]'"
        if attNameLower ends with ".pdf" then
          save att in POSIX file "${pdfPath}"
          set output to output & linefeed & linefeed & "[PDF_ATTACHED: ${pdfPath}]"
          exit repeat
        end if
      end try
    end repeat
  else
    set output to "(no recent forecast email from Igor)"
  end if

  return output
end tell`;

  const scriptPath = join(CACHE_DIR, 'igor-forecast.applescript');
  await writeFile(scriptPath, script, 'utf-8');

  // --- LIVE FIRST, CACHE FALLBACK ---
  // Prior design preferred cache unconditionally if <14d old, which meant newer
  // forecasts sent after the cache timestamp were never picked up (stale-data bug).
  // New order: always attempt live fetch first. On failure, fall back to cache
  // with an explicit staleness warning.
  try {
    const stdout = await runOsascript(scriptPath, 45000); // 45s timeout
    let result = stdout.trim();

    // Extract the forecast email date (emitted as EMAIL_DATE: YYYY-MM-DD)
    const emailDateMatch = result.match(/^EMAIL_DATE:\s*(\d{4}-\d{2}-\d{2})/m);
    const forecastEmailDate = emailDateMatch?.[1] ?? null;
    result = result.replace(/^EMAIL_DATE:.*\n?/m, '');

    // If a PDF was saved, extract text and write metadata sidecar
    if (result.includes('[PDF_ATTACHED:')) {
      try {
        const pdfText = await extractPdfText(pdfPath);
        if (pdfText) {
          // Write metadata sidecar recording which forecast is cached
          if (forecastEmailDate) {
            try {
              await writeFile(metaPath, JSON.stringify({ forecastEmailDate, cachedAt: new Date().toISOString() }, null, 2));
            } catch {}
          }
          console.log(`[igor] live fetch succeeded — forecast dated ${forecastEmailDate ?? 'unknown'}`);
          result = result.replace(/\[PDF_ATTACHED:.*\]/, `\nForecast email date: ${forecastEmailDate ?? 'unknown'}\nPDF Content:\n${pdfText}`);
          // Keep PDF + meta for next-run fallback (don't unlink)
        } else {
          result = result.replace(/\[PDF_ATTACHED:.*\]/, `(PDF extraction returned empty — raw file kept at ${pdfPath} for manual review)`);
          console.log(`[igor] PDF extraction failed — file kept at ${pdfPath}`);
        }
      } catch (err: any) {
        result = result.replace(/\[PDF_ATTACHED:.*\]/, `(PDF extraction failed: ${err.message?.slice(0, 80)} — file kept at ${pdfPath})`);
        console.log(`[igor] PDF extraction error: ${err.message?.slice(0, 100)}`);
      }
    }

    if (result && !result.startsWith('(no recent forecast')) {
      return result;
    }
    // Live fetch returned no result — drop through to cache
    console.log(`[igor] live fetch returned no forecast — trying cache`);
  } catch (err: any) {
    console.log(`[igor] live fetch failed (${err.message?.slice(0, 80)}) — falling back to cache`);
  }

  // --- CACHE FALLBACK ---
  try {
    const pdfStat = await fsStat(pdfPath);
    const ageDays = Math.round((Date.now() - pdfStat.mtimeMs) / 86400000);

    // Read sidecar for forecast date if available
    let forecastEmailDate: string | null = null;
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      forecastEmailDate = meta.forecastEmailDate ?? null;
    } catch {}

    const pdfText = await extractPdfText(pdfPath);
    if (pdfText) {
      const stalenessNote = forecastEmailDate
        ? `WARNING: Using CACHED Igor forecast from email dated ${forecastEmailDate} (${ageDays}d old). Live fetch failed — a newer forecast may exist in Mail.`
        : `WARNING: Using CACHED Igor forecast (${ageDays}d old, email date unknown). Live fetch failed.`;
      console.log(`[igor] ${stalenessNote}`);
      return `Subject: Igor Forecast (CACHED FALLBACK)\n\n${stalenessNote}\n\nForecast email date: ${forecastEmailDate ?? 'unknown'}\n\nPDF Content:\n${pdfText}`;
    }
  } catch {}

  return '(Igor forecast unavailable — live fetch failed and no usable cache)';
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
