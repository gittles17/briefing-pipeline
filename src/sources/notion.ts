// Fetches recent projects from Create's Notion Project Tracker
// Primary: live API pull; falls back to cache at ~/briefing-data/notion-projects.txt
// Tracks team assignments and detects new projects since last run

import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const DATA_DIR = join(homedir(), 'briefing-data');
const CACHE_PATH = join(DATA_DIR, 'notion-projects.txt');
const KNOWN_PROJECTS_PATH = join(DATA_DIR, 'notion-known-projects.json');

interface NotionProject {
  id: string;
  name: string;
  phase: string;
  client?: string;
  dueDate?: string;
  owner?: string;
  team?: string;
  createdTime?: string;
}

// Team header page IDs in Notion's Teams structure. Each team header page has a
// "Project Tracking" relation listing all projects in that team. Projects have
// the inverse "Project Team" relation pointing back. To find which projects
// belong to which team, we filter the Project Tracker DB by
// `Project Team contains <header_id>` — this works server-side without needing
// read access to the team pages themselves.
//
// Confirmed by Jonathan on 2026-05-12 via URL inspection of each team header.
// Add or remove entries here when teams are added/renamed in Notion.
const TEAM_HEADER_IDS: Record<string, string> = {
  'Design':       '23b67b59-a7c8-8054-99da-d81ae78c5d21',
  'Team Pfister': '23b67b59-a7c8-80a6-a1fb-d5d34cce11fd',
  'Key Art':      '34267b59-a7c8-8037-8c09-e0842280a0ec',
  'Team Andrew':  '23b67b59-a7c8-806a-bac9-cf21c7a64f69',
  'Team Content': '23b67b59-a7c8-80a9-ab07-e592d98a5110',
  'Social':       '23b67b59-a7c8-8036-8412-d8f611aa49b7',
  'Team Madness': '23b67b59-a7c8-800e-884a-d19654ca9a59',
  'Team Molly':   '23b67b59-a7c8-8056-8175-e00334cc17b0',
  'Team Natalie': '33067b59-a7c8-80b2-9b0c-cbc2cc17eafb',
  'Team London':  '31467b59-a7c8-8040-b18a-eb72236a5d8f',
  'Team Suneil':  '23b67b59-a7c8-8000-9434-ecfbf33a007c',
  // F (2 projects: Hannah Berner, Hamlet) — team name not yet known; surfaces as
  // 'Team-F' until Jonathan identifies it. Keep here so projects still get tagged.
  'Team-F':       '2e467b59-a7c8-8028-b28e-c3a44d3ef4f0',
};

interface TeamLookup {
  projectIdToTeam: Map<string, string>;
  teamPageIdToName: Map<string, string>;  // header page ID → team name
}

/**
 * Build a definitive project→team map by filtering the Project Tracker DB
 * once per team header. Uses server-side `Project Team contains <header_id>`
 * which works without read access to the team header pages.
 *
 * Cached for the lifetime of the Node process (one run).
 */
let _liveTeamLookupCache: TeamLookup | null = null;
async function fetchLiveTeamLookup(token: string): Promise<TeamLookup> {
  if (_liveTeamLookupCache) return _liveTeamLookupCache;

  const dbId = process.env.NOTION_DATABASE_ID;
  const projectIdToTeam = new Map<string, string>();
  const teamPageIdToName = new Map<string, string>();

  for (const [teamName, headerId] of Object.entries(TEAM_HEADER_IDS)) {
    teamPageIdToName.set(headerId, teamName);
    let cursor: string | undefined;
    let count = 0;
    do {
      try {
        const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filter: { property: 'Project Team', relation: { contains: headerId } },
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        });
        if (!r.ok) {
          console.log(`[notion] team filter failed for ${teamName}: HTTP ${r.status}`);
          break;
        }
        const d: any = await r.json();
        for (const p of d.results || []) {
          // Only set if not already mapped (first team wins — projects can be
          // multi-team but we want one display label)
          if (!projectIdToTeam.has(p.id)) {
            projectIdToTeam.set(p.id, teamName);
            count++;
          }
        }
        cursor = d.has_more ? d.next_cursor : undefined;
      } catch (err: any) {
        console.log(`[notion] team filter error for ${teamName}: ${err.message?.slice(0, 100)}`);
        break;
      }
    } while (cursor);
  }
  console.log(`[notion] team lookup built: ${projectIdToTeam.size} project→team mappings across ${Object.keys(TEAM_HEADER_IDS).length} teams`);

  _liveTeamLookupCache = { projectIdToTeam, teamPageIdToName };
  return _liveTeamLookupCache;
}


/**
 * Fetch projects from Notion API, falling back to cache.
 * Detects new projects added since last run.
 */
export async function fetchNotionProjects(): Promise<string> {
  const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;

  if (token && dbId) {
    try {
      const response = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
          filter: {
            timestamp: 'last_edited_time',
            last_edited_time: {
              after: new Date(Date.now() - 30 * 86400000).toISOString(),
            },
          },
          page_size: 100,
        }),
      });

      if (response.ok) {
        const data: any = await response.json();
        // Build the live team lookup (project→team) BEFORE parsing so each
        // project gets its current team assignment, not a stale snapshot.
        const teamLookup = await fetchLiveTeamLookup(token);
        const projects = parseNotionResults(data.results, teamLookup);

        if (projects.length > 0) {
          // Detect new projects
          const newProjects = await detectNewProjects(projects);
          const output = formatProjects(projects, newProjects);

          // Save current project IDs for next comparison
          await saveKnownProjects(projects).catch(() => {});
          // Update cache
          await writeFile(CACHE_PATH, output, 'utf-8').catch(() => {});
          return output;
        }
      }
    } catch (err) {
      console.log(`[notion] API fetch failed, falling back to cache: ${err}`);
    }
  }

  try {
    const cached = await readFile(CACHE_PATH, 'utf-8');
    if (cached.trim()) return cached.trim();
  } catch {}

  return '(Notion projects unavailable — set NOTION_API_KEY and NOTION_DATABASE_ID in .env)';
}

function parseNotionResults(results: any[], teamLookup: TeamLookup): NotionProject[] {
  // Team comes directly from the server-side filter pass (fetchLiveTeamLookup).
  // No owner inference, no static fallback — every project's team is now
  // definitive, computed from Notion's own Project Team relation via filtering.
  return results.map(page => {
    const props = page.properties || {};
    const id = page.id || '';
    return {
      id,
      name: extractTitle(props['Job (Project Name)'] || props.Name || props.Title),
      phase: extractSelect(props.Phase || props.Status || props.Stage),
      client: extractSelect(props.Client || props.Studio),
      dueDate: extractDate(props['Due date'] || props['Due Date'] || props.Deadline),
      owner: extractPerson(props['Design Producer'] || props['AV Producer'] || props.Owner),
      team: teamLookup.projectIdToTeam.get(id) || '',
      createdTime: page.created_time || '',
    };
  }).filter(p => p.name);
}

async function detectNewProjects(currentProjects: NotionProject[]): Promise<Set<string>> {
  const newIds = new Set<string>();
  try {
    const raw = await readFile(KNOWN_PROJECTS_PATH, 'utf-8');
    const known: string[] = JSON.parse(raw);
    const knownSet = new Set(known);

    for (const p of currentProjects) {
      if (p.id && !knownSet.has(p.id)) {
        newIds.add(p.id);
      }
    }
  } catch {
    // First run — no known projects file. Don't flag everything as new.
  }
  return newIds;
}

async function saveKnownProjects(projects: NotionProject[]): Promise<void> {
  const ids = projects.map(p => p.id).filter(Boolean);
  await writeFile(KNOWN_PROJECTS_PATH, JSON.stringify(ids, null, 2), 'utf-8');
}

function extractTitle(prop: any): string {
  if (!prop) return '';
  if (prop.title && Array.isArray(prop.title)) {
    return prop.title.map((t: any) => t.plain_text || '').join('');
  }
  return '';
}

function extractSelect(prop: any): string {
  if (!prop) return '';
  if (prop.select) return prop.select.name || '';
  if (prop.status) return prop.status.name || '';
  if (prop.multi_select) return prop.multi_select.map((s: any) => s.name).join(', ');
  return '';
}

function extractDate(prop: any): string {
  if (!prop || !prop.date) return '';
  return prop.date.start || '';
}

function extractPerson(prop: any): string {
  if (!prop || !prop.people) return '';
  return prop.people.map((p: any) => p.name || '').filter(Boolean).join(', ');
}

function formatProjects(projects: NotionProject[], newProjects: Set<string>): string {
  // Group by phase
  const byPhase = new Map<string, NotionProject[]>();
  for (const project of projects) {
    const phase = project.phase || 'Unknown';
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase)!.push(project);
  }

  const lines: string[] = [];

  // New projects section first (most important)
  if (newProjects.size > 0) {
    const newOnes = projects.filter(p => newProjects.has(p.id));
    lines.push(`🆕 NEW PROJECTS ADDED (${newOnes.length}):`);
    for (const p of newOnes) {
      let line = `- ${p.name}`;
      if (p.client) line += ` [${p.client}]`;
      if (p.team) line += ` — ${p.team}`;
      else line += ` — no team assigned`;
      if (p.owner) line += ` (${p.owner})`;
      if (p.dueDate) line += ` — due ${p.dueDate}`;
      lines.push(line);
    }
    lines.push('');
  }

  // Phase order
  const phaseOrder = ['Exploration', 'Production', 'Finishing', 'Delivered', 'Done'];
  const sortedPhases = [...byPhase.keys()].sort((a, b) => {
    const ai = phaseOrder.findIndex(s => a.toLowerCase().includes(s.toLowerCase()));
    const bi = phaseOrder.findIndex(s => b.toLowerCase().includes(s.toLowerCase()));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const phase of sortedPhases) {
    const phaseProjects = byPhase.get(phase)!;
    lines.push(`=== ${phase} (${phaseProjects.length}) ===`);
    for (const p of phaseProjects) {
      const isNew = newProjects.has(p.id);
      let line = `- ${isNew ? '🆕 ' : ''}${p.name}`;
      if (p.client) line += ` [${p.client}]`;
      if (p.team) line += ` {${p.team}}`;
      if (p.owner) line += ` (${p.owner})`;
      if (p.dueDate) line += ` — due ${p.dueDate}`;
      lines.push(line);
    }
    lines.push('');
  }

  return lines.join('\n');
}
