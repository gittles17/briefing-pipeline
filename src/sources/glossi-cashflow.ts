// Fetches Glossi cashflow from published Google Sheet CSV
// Shows burn rate, bank balance, cash available, and runway

const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTeY3v1sKBMDXpT5MnM-puEC-UvvsnvxmkBsnrxjUNfJ2VfFzkCeez0OaktAYXmgqD9CwExT2GpjWL7/pub?output=csv';

function cleanNum(s: string): string {
  return s.replace(/["\s]/g, '').replace(/^\((.*)\)$/, '-$1');
}

/** Detect key column indices by scanning header row for known names. */
function detectColumns(headerCols: string[]): { labelCol: number; categoryCol: number; dataStartCol: number } | null {
  const clean = headerCols.map(h => h.replace(/"/g, '').trim().toLowerCase());

  // Look for the label column: typically contains "name" or is immediately left of
  // recognisable financial headers. We search for a column whose downstream rows
  // will contain "bank balance", "total burn", etc. — but the header row itself
  // often just has a generic label. Instead, scan for known period-like headers
  // (month names, "Week of", dates) to find where data columns start.
  let dataStartCol = -1;
  for (let i = 0; i < clean.length; i++) {
    if (/^\d{1,2}[\/-]\d{1,2}|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|^week\s|^q[1-4]\s|^wk\s|^period/i.test(clean[i])) {
      dataStartCol = i;
      break;
    }
  }

  // Look for label column: find a header containing "name" or "item" or "description"
  // that appears before the data columns
  let labelCol = -1;
  let categoryCol = -1;
  const searchRange = dataStartCol > 0 ? dataStartCol : clean.length;
  for (let i = 0; i < searchRange; i++) {
    if (labelCol < 0 && /name|item|description|label|expense/i.test(clean[i])) {
      labelCol = i;
    } else if (labelCol >= 0 && categoryCol < 0 && /category|type|class|group/i.test(clean[i])) {
      categoryCol = i;
    }
  }

  // If we found a label column but no explicit data start, data starts after label+category
  if (labelCol >= 0 && dataStartCol < 0) {
    dataStartCol = (categoryCol >= 0 ? categoryCol : labelCol) + 1;
    // Scan forward from there for the first period-like or numeric header
    for (let i = dataStartCol; i < clean.length; i++) {
      if (clean[i] && /\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week|wk|q[1-4]|period/i.test(clean[i])) {
        dataStartCol = i;
        break;
      }
    }
  }

  if (labelCol >= 0 && dataStartCol > labelCol) {
    return { labelCol, categoryCol: categoryCol >= 0 ? categoryCol : labelCol + 1, dataStartCol };
  }
  return null;
}

export async function fetchGlossiCashflow(): Promise<string> {
  try {
    const response = await fetch(CSV_URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return '';
    const csv = await response.text();
    const lines = csv.split('\n');

    const headerCols = lines[0].split(',');

    // Try header-based detection; fall back to hardcoded positions
    const detected = detectColumns(headerCols);
    let labelCol: number;
    let categoryCol: number;
    let dataStartCol: number;

    if (detected) {
      labelCol = detected.labelCol;
      categoryCol = detected.categoryCol;
      dataStartCol = detected.dataStartCol;
      console.log(`[glossi-cashflow] detected columns: label=col${labelCol}, category=col${categoryCol}, dataStart=col${dataStartCol}`);
    } else {
      // Fallback to legacy hardcoded positions
      labelCol = 22;
      categoryCol = 23;
      dataStartCol = 27;
      console.log(`[glossi-cashflow] header detection failed, using hardcoded columns: label=col${labelCol}, category=col${categoryCol}, dataStart=col${dataStartCol}`);
    }

    // Row 0 has period headers in data columns
    const periods: string[] = [];
    for (let i = dataStartCol; i < headerCols.length; i++) {
      const h = headerCols[i]?.replace(/"/g, '').trim();
      if (h) periods.push(h);
    }

    // Extract key rows from summary section
    const metrics: Record<string, string[]> = {};
    for (const line of lines) {
      const cols = line.split(',');
      const label = cols[labelCol]?.replace(/"/g, '').trim() || '';
      if (/Total Burn|burn\s*rate|monthly\s*burn|Bank Balance|Cash Available|Runway|Paid-up/i.test(label)) {
        const values = cols.slice(dataStartCol).map(c => cleanNum(c));
        metrics[label] = values;
      }
    }

    if (Object.keys(metrics).length === 0) return '';

    const output: string[] = ['GLOSSI CASHFLOW (from finance spreadsheet):'];

    // Find metric keys (case-insensitive, partial match)
    const burnKey = Object.keys(metrics).find(k => /Total Burn|burn\s*rate|monthly\s*burn/i.test(k));
    const balKey = Object.keys(metrics).find(k => /Bank Balance/i.test(k));
    const cashKey = Object.keys(metrics).find(k => /Cash Available/i.test(k));
    const runwayKey = Object.keys(metrics).find(k => /Runway/i.test(k));

    // Show all periods with data
    for (let i = 0; i < periods.length; i++) {
      const burn = burnKey ? metrics[burnKey][i] : '';
      const bal = balKey ? metrics[balKey][i] : '';
      const cash = cashKey ? metrics[cashKey][i] : '';
      const runway = runwayKey ? metrics[runwayKey][i] : '';

      if (!burn && !bal) continue;

      output.push(`${periods[i]}:`);
      if (burn) output.push(`  Burn: $${burn}`);
      if (bal) output.push(`  Bank Balance: $${bal}`);
      if (cash) output.push(`  Cash Available: $${cash}`);
      if (runway) output.push(`  Runway (weeks): ${runway}`);
    }

    // Also pull expense breakdown
    const expenseLines: string[] = [];
    for (const line of lines) {
      const cols = line.split(',');
      const name = cols[labelCol]?.replace(/"/g, '').trim() || '';
      const category = cols[categoryCol]?.replace(/"/g, '').trim() || '';
      if (name && category && !/Total Burn|burn\s*rate|monthly\s*burn|Bank Balance|Cash Available|Runway|Paid-up|Name|Chase x|Cash Revenue/i.test(name)) {
        const latestVal = cols.slice(dataStartCol).map(c => cleanNum(c)).filter(v => v && v !== '0').pop();
        if (latestVal) {
          expenseLines.push(`  ${name} (${category}): $${latestVal}`);
        }
      }
    }

    if (expenseLines.length > 0) {
      output.push('Recurring expenses:');
      output.push(...expenseLines);
    }

    return output.join('\n');
  } catch (err: any) {
    return '';
  }
}
