// Fetches latest Glossi board update from the dashboard API
// https://glossiboardupdate-production.up.railway.app/api/data

import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
const API_URL = 'https://glossiboardupdate-production.up.railway.app/api/data';

export async function fetchGlossiBoard(): Promise<string> {
  try {
    const { stdout } = await exec('curl', ['-s', API_URL], { timeout: 15000 });
    const json = JSON.parse(stdout);
    const data = json.data || json;
    const dd = data.dashboard_data || {};
    const lines: string[] = [];

    // Seed Raise from dashboard_data.seedRaise
    const sr = dd.seedRaise;
    if (sr) {
      const investors = sr.investors || [];
      const byStage: Record<string, any[]> = {};
      for (const inv of investors) {
        const stage = (inv.stage || 'unknown').toLowerCase();
        if (!byStage[stage]) byStage[stage] = [];
        byStage[stage].push(inv);
      }

      // Calculate closed total
      let closedTotal = 0;
      for (const inv of byStage.closed || []) {
        const num = parseFloat(String(inv.amount).replace(/[^0-9.]/g, ''));
        if (!isNaN(num)) closedTotal += num * (String(inv.amount).toLowerCase().includes('k') ? 1000 : 1);
      }

      lines.push(`SEED RAISE: $${Math.round(closedTotal / 1000)}K closed / ${sr.target || '$500K'} target`);

      if (byStage.closed) {
        lines.push(`Closed (${byStage.closed.length}): ${byStage.closed.map((i: any) => `${i.name} $${i.amount}${i.notes ? ' — ' + i.notes : ''}`).join(', ')}`);
      }
      if (byStage.committed) {
        lines.push(`Committed (${byStage.committed.length}): ${byStage.committed.map((i: any) => `${i.name} $${i.amount}${i.notes ? ' — ' + i.notes : ''}`).join(', ')}`);
      }
      if (byStage['in talks']) {
        lines.push(`In Talks (${byStage['in talks'].length}): ${byStage['in talks'].map((i: any) => `${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`).join(', ')}`);
      }
      if (byStage.interested) {
        lines.push(`Interested (${byStage.interested.length}): ${byStage.interested.map((i: any) => `${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`).join(', ')}`);
      }
    }

    // Sales Pipeline from Google Sheet sync
    const gsPipeline = data.googleSheetPipeline || dd.googleSheetPipeline;
    if (gsPipeline && gsPipeline.deals && gsPipeline.deals.length > 0) {
      const deals = gsPipeline.deals;
      const stageGroups: Record<string, { count: number; total: number }> = {};
      for (const deal of deals) {
        const stage = deal.stage || 'unknown';
        if (!stageGroups[stage]) stageGroups[stage] = { count: 0, total: 0 };
        stageGroups[stage].count++;
        stageGroups[stage].total += parseFloat(String(deal.value || '0').replace(/[^0-9.]/g, ''));
      }

      lines.push('');
      lines.push(`SALES PIPELINE: ${deals.length} deals`);
      for (const [stage, info] of Object.entries(stageGroups)) {
        lines.push(`${stage}: $${Math.round(info.total / 1000)}K (${info.count} deals)`);
      }

      // Hot deals
      const hot = deals.filter((d: any) => d.stage === 'Contract' || d.stage === 'Closed');
      if (hot.length > 0) {
        lines.push('Key deals:');
        for (const d of hot) {
          lines.push(`• ${d.name} — ${d.value} (${d.stage})${d.owner ? ', ' + d.owner : ''}`);
        }
      }
    }

    // Also check pipeline_weekly_history for pipeline data
    if (!gsPipeline && data.pipeline_weekly_history && data.pipeline_weekly_history.length > 0) {
      const latest = data.pipeline_weekly_history[0];
      const deals = latest.deals || [];
      const stageGroups: Record<string, { count: number; total: number }> = {};
      for (const deal of deals) {
        const stage = deal.stage || 'unknown';
        if (!stageGroups[stage]) stageGroups[stage] = { count: 0, total: 0 };
        stageGroups[stage].count++;
        stageGroups[stage].total += parseFloat(String(deal.value || '0').replace(/[^0-9.]/g, ''));
      }

      lines.push('');
      lines.push(`SALES PIPELINE: ${deals.length} deals`);
      for (const [stage, info] of Object.entries(stageGroups)) {
        lines.push(`${stage}: $${Math.round(info.total / 1000)}K (${info.count} deals)`);
      }
    }

    // Latest meeting summary + decisions
    if (data.meetings && data.meetings.length > 0) {
      const m = data.meetings[0];
      lines.push('');
      lines.push(`LATEST BOARD SYNC (${m.date || 'recent'}):`);

      const summaries = Array.isArray(m.summary) ? m.summary : [m.summary];
      for (const s of summaries) {
        if (s) lines.push(`• ${String(s).slice(0, 250)}`);
      }

      const decisions = m.decisions || [];
      if (decisions.length > 0) {
        lines.push('');
        lines.push('KEY DECISIONS:');
        for (const d of decisions) {
          lines.push(`• ${String(d).slice(0, 200)}`);
        }
      }
    }

    // Action items (todos)
    if (data.todos && data.todos.length > 0) {
      const open = data.todos.filter((t: any) => !t.completed);
      if (open.length > 0) {
        lines.push('');
        lines.push(`OPEN ACTION ITEMS (${open.length}):`);
        const byOwner: Record<string, string[]> = {};
        for (const t of open) {
          const owner = t.owner || 'Unassigned';
          if (!byOwner[owner]) byOwner[owner] = [];
          byOwner[owner].push(t.text || t.title);
        }
        for (const [owner, items] of Object.entries(byOwner)) {
          lines.push(`${owner}: ${items.join(', ')}`);
        }
      }
    }

    return lines.join('\n') || '(no Glossi board data)';
  } catch (err: any) {
    return `(Glossi board fetch failed: ${err.message})`;
  }
}
