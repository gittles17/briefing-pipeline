// Parses Maya's Collections Report (CSV or XLSX) saved by applemail.ts
// Falls back gracefully if no file exists

import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const DATA_DIR = join(homedir(), 'briefing-data');
const CSV_PATH = join(DATA_DIR, 'collections-report.csv');
const XLSX_PATH = join(DATA_DIR, 'collections-report.xlsx');

export async function fetchCollectionsReport(): Promise<string> {
  // Try CSV first
  try {
    const csvStat = await stat(CSV_PATH);
    // Only use if less than 48 hours old
    if (Date.now() - csvStat.mtimeMs < 48 * 3600000) {
      const csv = await readFile(CSV_PATH, 'utf-8');
      return parseCSV(csv);
    }
  } catch {}

  // Try XLSX — just note its existence, can't parse without a library
  try {
    const xlsxStat = await stat(XLSX_PATH);
    if (Date.now() - xlsxStat.mtimeMs < 48 * 3600000) {
      return '(Maya\'s Collections Report received as Excel — CSV version needed for parsing. File saved at ~/briefing-data/collections-report.xlsx)';
    }
  } catch {}

  return '';
}

function parseCSV(csv: string): string {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return '';

  const output: string[] = ['CREATE COLLECTIONS REPORT (from Maya):'];

  // Try to detect header row and extract key data
  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim());
    if (cols.length < 2) continue;
    // Skip empty rows
    if (cols.every(c => !c)) continue;

    const row = header.map((h, idx) => {
      const val = cols[idx] || '';
      return val ? `${h}: ${val}` : '';
    }).filter(Boolean).join(' | ');

    if (row) output.push(`- ${row}`);
  }

  return output.length > 1 ? output.join('\n') : '';
}
