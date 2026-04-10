import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink } from 'fs/promises';
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
  // AppleScript to find Igor's latest forecast email and extract body + save PDF
  const pdfPath = join(CACHE_DIR, 'igor-forecast.pdf');
  const script = `
tell application "Mail"
  set cutoff to (current date) - 14 * days
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
    set output to "Subject: " & subj & linefeed & linefeed & "Body:" & linefeed & bod

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

  try {
    const stdout = await runOsascript(scriptPath);
    let result = stdout.trim();

    // If a PDF was saved, extract text from it
    if (result.includes('[PDF_ATTACHED:')) {
      try {
        const pdfText = await extractPdfText(pdfPath);
        if (pdfText) {
          result = result.replace(/\[PDF_ATTACHED:.*\]/, `\nPDF Content:\n${pdfText}`);
        }
        // Clean up PDF file
        try { await unlink(pdfPath); } catch {}
      } catch {
        result = result.replace(/\[PDF_ATTACHED:.*\]/, '(PDF extraction failed)');
      }
    }

    return result || '(no recent forecast email from Igor)';
  } catch {
    return '(Igor forecast unavailable)';
  }
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
