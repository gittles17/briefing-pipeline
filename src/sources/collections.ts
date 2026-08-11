// Fetches Maya Krishnan's latest Collections Report Excel from Outlook via Graph API
// Extracts: Liquid Cash, MTD Collections, AR Balance, Apple/Disney AR, today's collections
// Falls back to cached data if Graph API unavailable

import { readFile, writeFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { graphGet, graphFetch, isGraphConfigured } from './graph-client';

const execAsync = promisify(execFile);
const DATA_DIR = join(homedir(), 'briefing-data');
const CACHE_PATH = join(DATA_DIR, 'collections-parsed.txt');
const XLSX_PATH = join(DATA_DIR, 'collections-report-latest.xlsx');

interface CollectionsData {
  liquidCash: number;
  mtdCollections: number;
  arBalance: number;
  todayCollections: number;
  todayDetail: string[];  // who paid today
  appleAR: number;
  disneyAR: number;
  mtdBillings: number;
  billingsByDivision: Record<string, number>;
  collectionsByStudio: Record<string, number>;
  wellsFargoLoan: number;
  jpMorgan: number;
  wellsFargo: number;
  borrowingAvailability: number;
  reportDate: string;
}

async function fetchLatestCollectionsEmail(): Promise<{ messageId: string; date: string } | null> {
  // Maya's collections emails can land in Inbox, get auto-archived to Archive,
  // OR get deleted to Deleted Items. Graph's $search on /me/messages excludes
  // Deleted Items, so we must query each folder explicitly. Uses graphGet so
  // token recovery + concurrent-refresh dedup are handled centrally.
  const folders = [
    { name: 'inbox',        path: '/me/mailFolders/inbox/messages' },
    { name: 'archive',      path: '/me/mailFolders/archive/messages' },
    { name: 'deleteditems', path: '/me/mailFolders/deleteditems/messages' },
  ];

  type Hit = { id: string; receivedDateTime: string; subject: string; hasAttachments: boolean; folder: string };
  const hits: Hit[] = [];

  for (const f of folders) {
    try {
      const data = await graphGet(f.path, {
        '$orderby': 'receivedDateTime desc',
        '$top': '200',
        '$select': 'id,receivedDateTime,subject,from,hasAttachments',
      });
      for (const m of data?.value || []) {
        const fromAddr = m.from?.emailAddress?.address?.toLowerCase() || '';
        if (
          fromAddr.includes('maya.krishnan') &&
          m.hasAttachments &&
          /collections/i.test(m.subject || '')
        ) {
          hits.push({ ...m, folder: f.name });
        }
      }
    } catch (err: any) {
      // Full error message logged (no truncation) so debugging is possible
      console.log(`[collections] ${f.name} query failed: ${err.message}`);
    }
  }

  if (!hits.length) {
    console.log(`[collections] no Maya Collections-Report+attachment found in inbox/archive/deleteditems`);
    return null;
  }

  hits.sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime());
  const newest = hits[0];
  console.log(`[collections] newest match: "${newest.subject}" (${newest.receivedDateTime}) in ${newest.folder}`);
  return { messageId: newest.id, date: newest.receivedDateTime };
}

async function downloadExcelAttachment(messageId: string): Promise<boolean> {
  try {
    const res = await graphFetch(`/me/messages/${messageId}/attachments`);
    if (!res || !res.ok) {
      if (res) {
        const body = await res.text().catch(() => '');
        console.log(`[collections] attachment list failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
      }
      return false;
    }
    const data: any = await res.json();
    const xlsxAtt = data.value?.find((a: any) =>
      a.name?.toLowerCase().endsWith('.xlsx') || a.name?.toLowerCase().endsWith('.xls')
    );
    if (!xlsxAtt?.contentBytes) return false;
    const buffer = Buffer.from(xlsxAtt.contentBytes, 'base64');
    await writeFile(XLSX_PATH, buffer);
    console.log(`[collections] downloaded ${xlsxAtt.name} (${buffer.length} bytes)`);
    return true;
  } catch (err: any) {
    console.log(`[collections] attachment download failed: ${err.message}`);
    return false;
  }
}

async function parseExcel(filePath: string): Promise<CollectionsData | null> {
  try {
    // Use Python + openpyxl to parse (already installed)
    const script = `
import json, sys, openpyxl

wb = openpyxl.load_workbook("${filePath}", data_only=True)
ws = wb["Sheet1"]

data = {
    "liquidCash": 0, "mtdCollections": 0, "arBalance": 0,
    "todayCollections": 0, "todayDetail": [],
    "appleAR": 0, "disneyAR": 0, "mtdBillings": 0,
    "billingsByDivision": {}, "collectionsByStudio": {},
    "wellsFargoLoan": 0, "jpMorgan": 0, "wellsFargo": 0,
    "borrowingAvailability": 0, "reportDate": ""
}

in_studio_detail = False
prev_mtd = 0

for row in ws.iter_rows(min_row=1, max_row=ws.max_row, values_only=False):
    vals = [cell.value for cell in row]
    # Find the label (usually col B) and value (usually col D)
    label = str(vals[1] or "").strip() if len(vals) > 1 else ""
    value = vals[3] if len(vals) > 3 else None

    if not label:
        continue

    # Try to get numeric value
    num = 0
    if value is not None:
        try:
            num = float(value)
        except (ValueError, TypeError):
            pass

    label_lower = label.lower()

    if "liquid cash" in label_lower:
        data["liquidCash"] = num
    elif "total mtd" in label_lower and "detail" in label_lower:
        data["mtdCollections"] = num
    elif "previous mtd" in label_lower:
        prev_mtd = num
    elif label_lower == "total today":
        data["todayCollections"] = num
    elif "ar balance" in label_lower:
        data["arBalance"] = num
    elif "month-to-date billings" in label_lower or "mtd billings" in label_lower:
        data["mtdBillings"] = num
    elif "wells fargo loan" in label_lower:
        data["wellsFargoLoan"] = num
    elif label_lower == "jp morgan chase":
        data["jpMorgan"] = num
    elif label_lower == "wells fargo":
        data["wellsFargo"] = num
    elif "borrowing avail" in label_lower:
        data["borrowingAvailability"] = num
    elif "detail by studio" in label_lower:
        in_studio_detail = True
        # Check if the value is a date
        if value:
            data["reportDate"] = str(value)[:10]
    elif label_lower == "total" and in_studio_detail:
        in_studio_detail = False
    elif in_studio_detail and num > 0:
        data["collectionsByStudio"][label] = num
        if "apple" in label_lower or "disney" in label_lower or "walt disney" in label_lower:
            if "apple" in label_lower:
                data["appleAR"] = num
            if "disney" in label_lower:
                data["disneyAR"] = num

    # Division billings (between MTD billings header and AR balance)
    divisions = ["corporate", "films & series", "gaming", "content", "apple ih"]
    if label_lower in divisions:
        data["billingsByDivision"][label] = num

    # Today's detail: items between "Previous MTD" and "Total Today" that have values
    # These are collected between specific rows — check if between prev_mtd and today total

# Find today's collections detail
found_prev = False
for row in ws.iter_rows(min_row=1, max_row=ws.max_row, values_only=False):
    vals = [cell.value for cell in row]
    label = str(vals[1] or "").strip() if len(vals) > 1 else ""
    value = vals[3] if len(vals) > 3 else None
    label_lower = label.lower()

    if "previous mtd" in label_lower:
        found_prev = True
        continue
    if "total today" in label_lower:
        break
    if found_prev and label and value:
        try:
            amt = float(value)
            if amt > 0:
                data["todayDetail"].append(label + ": " + "{:,.0f}".format(amt))
        except (ValueError, TypeError):
            pass

if not data["mtdCollections"] and prev_mtd and data["todayCollections"]:
    data["mtdCollections"] = prev_mtd + data["todayCollections"]

print(json.dumps(data))
`;

    const { stdout } = await execAsync('python3', ['-c', script]);
    return JSON.parse(stdout.trim());
  } catch (err) {
    console.log(`[collections] Excel parse failed: ${err}`);
    return null;
  }
}

function formatCollections(data: CollectionsData): string {
  const lines: string[] = ['CASH POSITION (from Maya\'s Collections Report):'];

  // Payroll context
  const payroll = 450000; // midpoint of $400-500K range
  const buffer = data.liquidCash - payroll;
  const bufferLabel = buffer >= 0
    ? `covers next payroll (~$450K) with $${(buffer / 1000).toFixed(0)}K buffer`
    : `⚠️ short ~$${(Math.abs(buffer) / 1000).toFixed(0)}K for next payroll (~$450K)`;

  lines.push(`Liquid Cash: $${(data.liquidCash / 1000).toFixed(0)}K — ${bufferLabel}`);
  lines.push(`MTD Collections: $${(data.mtdCollections / 1000).toFixed(0)}K | AR Outstanding: $${(data.arBalance / 1000).toFixed(0)}K`);

  // Apple & Disney early-pull context: Jonathan can request early payment from
  // these two specifically, so their figures from Maya's "Detail by Studio"
  // section are surfaced prominently. Source data: MTD collected per studio.
  const appleMTD = data.appleAR;     // from Detail by Studio (Apple TV+)
  const disneyMTD = data.disneyAR;   // from Detail by Studio (Walt Disney)
  if (appleMTD > 0 || disneyMTD > 0) {
    const parts: string[] = [];
    if (appleMTD > 0)  parts.push(`Apple TV+ $${(appleMTD / 1000).toFixed(0)}K`);
    if (disneyMTD > 0) parts.push(`Walt Disney $${(disneyMTD / 1000).toFixed(0)}K`);
    lines.push(`Early-pull candidates (MTD collected): ${parts.join(' · ')}`);
  }

  // Today's collections (big collection days)
  if (data.todayCollections > 0) {
    const detail = data.todayDetail.length > 0
      ? data.todayDetail.join(', ')
      : `$${(data.todayCollections / 1000).toFixed(0)}K`;
    // Flag if it's a big day (over $100K)
    const bigDay = data.todayCollections >= 100000 ? ' 📈' : '';
    lines.push(`Today's collections: ${detail}${bigDay}`);
  }

  // Top collections by studio (show top 5 for context)
  const studios = Object.entries(data.collectionsByStudio)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (studios.length > 0) {
    const studioLine = studios
      .map(([name, amt]) => `${name} $${(amt / 1000).toFixed(0)}K`)
      .join(', ');
    lines.push(`Top MTD: ${studioLine}`);
  }

  // Bank detail
  lines.push(`Bank: JPM $${(data.jpMorgan / 1000).toFixed(0)}K + WF $${(data.wellsFargo / 1000).toFixed(0)}K + WF Avail $${(data.borrowingAvailability / 1000).toFixed(0)}K | Loan: $${(data.wellsFargoLoan / 1000).toFixed(0)}K`);

  return lines.join('\n');
}

export async function fetchCollectionsReport(): Promise<string> {
  const token = isGraphConfigured() ? 'configured' : '';

  if (token) {
    try {
      // Find Maya's latest Collections Report email
      const email = await fetchLatestCollectionsEmail();
      if (email) {
        const ageHours = (Date.now() - new Date(email.date).getTime()) / 3600000;
        const ageDays = ageHours / 24;
        // Always parse the latest available report. If it's old (>72h),
        // prepend an explicit staleness warning so the assembler dates the
        // numbers correctly instead of presenting them as today's snapshot.
        const downloaded = await downloadExcelAttachment(email.messageId);
        if (downloaded) {
          const data = await parseExcel(XLSX_PATH);
          if (data) {
            const reportDate = new Date(email.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            let formatted = formatCollections(data);
            if (ageHours >= 72) {
              const staleness = `⚠️ STALE: latest collections report is from ${reportDate} (${ageDays.toFixed(1)} days old). Cite the report date when quoting figures; do NOT present these as today's cash position.\n`;
              formatted = staleness + formatted;
              console.log(`[collections] using stale report from ${reportDate} (${ageHours.toFixed(1)}h old)`);
            } else {
              console.log(`[collections] using fresh report from ${reportDate} (${ageHours.toFixed(1)}h old)`);
            }
            await writeFile(CACHE_PATH, formatted, 'utf-8').catch(() => {});
            console.log(`[collections] parsed: liquid $${(data.liquidCash / 1000).toFixed(0)}K, MTD $${(data.mtdCollections / 1000).toFixed(0)}K, AR $${(data.arBalance / 1000).toFixed(0)}K`);
            return formatted;
          } else {
            console.log(`[collections] Excel parse returned null — see error above`);
          }
        } else {
          console.log(`[collections] attachment download failed`);
        }
      } else {
        console.log(`[collections] no Maya email matched — falling back to cache`);
      }
    } catch (err) {
      console.log(`[collections] Graph fetch failed: ${err}`);
    }
  }

  // Fallback: try cached parsed output (< 48h old)
  try {
    const cacheStat = await stat(CACHE_PATH);
    if (Date.now() - cacheStat.mtimeMs < 48 * 3600000) {
      const cached = await readFile(CACHE_PATH, 'utf-8');
      if (cached.trim()) {
        console.log('[collections] using cached parsed data');
        return cached.trim();
      }
    }
  } catch {}

  // Fallback: try manually downloaded xlsx
  try {
    const manualPath = join(DATA_DIR, 'collections-report-2026-04-14.xlsx');
    const xlsxStat = await stat(manualPath);
    if (Date.now() - xlsxStat.mtimeMs < 48 * 3600000) {
      const data = await parseExcel(manualPath);
      if (data) return formatCollections(data);
    }
  } catch {}

  return '';
}
