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

// Team page IDs from the Teams Database → project page IDs they contain
// Built from Notion MCP data. Each team page's "Project Tracking" relation.
const TEAM_PAGES: Record<string, string[]> = {
  'Gaming': [
    '23967b59-a7c8-8095-b85e-fb7e9f7722b6','23967b59-a7c8-80e2-aa13-db532c1669a3',
    '23967b59-a7c8-802c-8b51-e83362849232','24167b59-a7c8-8041-82b7-c0f329f149b0',
    '24167b59-a7c8-8076-a267-ff49c2b4f56f','24667b59-a7c8-8024-bd39-cc0d9c40615b',
    '24d67b59-a7c8-808f-b3d6-fad2d53333a2','24f67b59-a7c8-801c-b519-ebaffe4528a1',
    '24f67b59-a7c8-8083-a312-cfd2d960f82f','25467b59-a7c8-808d-b5fd-cdbb3adffb5c',
    '25567b59-a7c8-80e0-819e-dba979cde195','26567b59-a7c8-80e3-b516-dfbfb45654df',
    '27967b59-a7c8-8063-9e97-e538f3ed462c','28e67b59-a7c8-8003-b266-cae04996918a',
    '29a67b59-a7c8-80fa-9875-cc22060dce6e','2a467b59-a7c8-8068-9238-e99d6ce71837',
    '2a767b59-a7c8-801a-ad5d-e53ef1403edf','2b667b59-a7c8-805e-a496-e18e92361542',
    '2b767b59-a7c8-80af-b7bf-c2c1d3492a0d','2bd67b59-a7c8-80e9-b9cb-f11db9f1fc64',
    '2c067b59-a7c8-8005-a4a1-e6b16ac4d44c','2e167b59-a7c8-8040-a50f-e69733b22eda',
    '2ea67b59-a7c8-8092-ab96-d66019a30aa4','2fb67b59-a7c8-8082-8dda-feda71329445',
    '2fb67b59-a7c8-80b8-90ff-c49f8a84e6f0','2fb67b59-a7c8-80ba-805c-f4cd30af8968',
    '2fb67b59-a7c8-8002-a099-e43f9f8f26dd','2fb67b59-a7c8-8066-89ed-cdb690540374',
    '2fb67b59-a7c8-805b-b60e-cb1602df7d5b','2fb67b59-a7c8-80a1-a8fb-da123fbc8db3',
    '2fb67b59-a7c8-8093-83df-ee542491dfc3','2fc67b59-a7c8-803e-b798-f372f87d8bac',
    '2fd67b59-a7c8-8037-b380-c98e528f5bdc','2fe67b59-a7c8-80aa-b49b-c172645ea656',
    '31067b59-a7c8-808f-bd3f-ee0e6a7da4bf','31b67b59-a7c8-80d3-ba64-ffb680226b63',
    '32867b59-a7c8-80e8-b981-e2949060dc14',
  ],
  'Team Madness': [
    '23967b59-a7c8-80f1-a562-c686d56ffcf8','23967b59-a7c8-8078-aa94-c5eb2a9c14e9',
    '23967b59-a7c8-80b1-93c6-c0de015e9b1f','23967b59-a7c8-800b-8488-d1ffa6ed3677',
    '23967b59-a7c8-80f4-ad06-e908ec0f541b','23967b59-a7c8-808b-a5d7-fd9f01c7b7d8',
    '23967b59-a7c8-8000-a2b8-ff4d9d3b964a','23967b59-a7c8-8038-955b-f3c689b63c29',
    '23967b59-a7c8-8017-af59-ed68267adfd5','24667b59-a7c8-8018-bdb2-fdf114c0e9b3',
    '23967b59-a7c8-8053-a1c8-e8f6499b477b','24d67b59-a7c8-807b-8e58-c7e085fa5396',
    '25567b59-a7c8-8047-b876-d85cd633159c','27167b59-a7c8-8099-84bc-c0706a899338',
    '28667b59-a7c8-80fd-b3dd-d56394594fa7','28867b59-a7c8-8099-8290-ecccc0a6b87f',
    '28b67b59-a7c8-8004-91eb-c4807fce1be0','29a67b59-a7c8-8051-99d2-c7962b912445',
    '2a267b59-a7c8-80ba-94e3-cf89cd353089','2b167b59-a7c8-8011-9633-fcff0049fbed',
    '2ca67b59-a7c8-80c4-9754-c65537aa2e65','2e667b59-a7c8-8008-9557-c2cb20ca5cdf',
    '2ee67b59-a7c8-80ca-8ae3-ebe8d121d7a7','2f167b59-a7c8-80d1-892b-cbad6cc1cb3f',
    '2f467b59-a7c8-80ac-a334-f1338b1a140d','2f467b59-a7c8-801f-b888-e8fe64f30267',
    '2f467b59-a7c8-801a-9fa0-d64f40ceb87d','2f667b59-a7c8-803a-92da-e38663bc0489',
    '2f867b59-a7c8-801e-9232-d3a8d7c3fd57','2fc67b59-a7c8-80f0-809f-da4f0893aeb4',
    '2fe67b59-a7c8-8066-8a2f-f529d25b54fe','30267b59-a7c8-80af-876d-f2d552304aab',
    '32f67b59-a7c8-80c7-9254-ef99e7a3cf6e','33367b59-a7c8-809b-9f29-e1cea71961d2',
    '33567b59-a7c8-80d4-9173-ff7b2a6356ad',
  ],
  'Design': [
    '23967b59-a7c8-80b8-8bec-ff9c2d4f4d74','23967b59-a7c8-80d1-936d-f77a11b62fe8',
    '23967b59-a7c8-80bb-b544-cbebbfca1446','23967b59-a7c8-8132-a36f-ec39388616db',
    '23967b59-a7c8-803d-b749-e1c2bd106106','24667b59-a7c8-8030-8b45-f01e050d6b0f',
    '24a67b59-a7c8-80bf-a3a9-ec83d391aba2','23967b59-a7c8-800e-8278-cf7e5d4d7a16',
    '25567b59-a7c8-80c1-baa0-cdd84ee508b6','25767b59-a7c8-8024-a74c-f6e72a91a941',
    '26a67b59-a7c8-80f0-a678-df4ac9f75a3b','26c67b59-a7c8-80f6-93a4-f6b5ef1bf53d',
    '26c67b59-a7c8-8042-b15b-c77faaa40b01','27367b59-a7c8-8010-9eff-fd2e4e47e01b',
    '2c067b59-a7c8-8059-9f7a-d4a054e5507c','2e367b59-a7c8-805d-870e-d95eff555f3b',
    '2e667b59-a7c8-8017-b1ca-d4df6f3d367b','2ef67b59-a7c8-8086-a911-d2ebddbd4b7d',
    '2f067b59-a7c8-80f7-96bf-f138aacea28a','2f167b59-a7c8-8020-97f0-e2b91a9e9eb1',
    '2fd67b59-a7c8-800e-957e-caffdb120f20','2fe67b59-a7c8-8087-944f-da5b1904ceca',
    '30267b59-a7c8-80a9-98bc-cb16a95dbce5','30567b59-a7c8-8012-b5bb-e89bf90977b0',
    '30a67b59-a7c8-80a7-8450-f3a4f07991fd','30d67b59-a7c8-80ea-85de-ee19dc61ccc1',
    '31e67b59-a7c8-8019-bed8-e86153271259','31e67b59-a7c8-806c-8c4b-ea1e8ac6622d',
    '32a67b59-a7c8-8049-b253-c0f1631dd43f','32d67b59-a7c8-80be-865c-e597dbe89a52',
  ],
  'Team London': [
    '30667b59-a7c8-806c-a995-d9a69830d1be','30d67b59-a7c8-807a-a70c-ca47c47901a4',
    '31467b59-a7c8-80fb-8916-f9da732dbc45','31467b59-a7c8-8033-ac5b-da4b8940b1ab',
  ],
  'Team Andrew': [
    '23967b59-a7c8-8086-a669-d28db211947f','24e67b59-a7c8-8094-b70c-c0cbca5361d5',
    '24e67b59-a7c8-803d-abef-d8842b04dbac','25567b59-a7c8-8052-b837-d6e020dc2c8c',
    '25567b59-a7c8-80b5-a110-d93f65bf0548','25767b59-a7c8-801f-a3ed-c0f173fb63ab',
    '28f67b59-a7c8-80dc-8047-f2b0b09279bd','2af67b59-a7c8-8047-a1cb-f16ee0ac70ff',
    '2e467b59-a7c8-803e-a36a-c5b28e2d33ee','2ef67b59-a7c8-80de-b26a-e2f0ea58d4b1',
    '2f167b59-a7c8-8046-bdd0-f5c13ac35262','30467b59-a7c8-8007-bda9-e1ab10a2ff33',
    '31067b59-a7c8-8040-903a-fc4c22c7fd1b','33067b59-a7c8-8045-ba05-d5c6700fd469',
    '33567b59-a7c8-8071-9b4e-d425a9efa5ad',
  ],
  'Team Content': [
    '23967b59-a7c8-808b-96de-f19422d28d9e','23967b59-a7c8-8097-bfec-cf65741845e8',
    '23967b59-a7c8-80b8-abf7-de8a31e83001','23967b59-a7c8-8045-8d5a-e14eafc4303f',
    '24667b59-a7c8-80a7-9933-d497166aa189','25167b59-a7c8-80de-b029-d1347a85062a',
    '25367b59-a7c8-80ca-b794-ce26614c9ee1','25767b59-a7c8-8014-a78d-f72e58849526',
    '25b67b59-a7c8-80c4-af87-fb9f043c4fd3','26367b59-a7c8-8074-92db-c710cd5ab778',
    '26567b59-a7c8-8012-afd0-e04e40013db5','26467b59-a7c8-8047-894c-dd93d670527a',
    '26a67b59-a7c8-8025-8b13-c8e5839c7686','28667b59-a7c8-8056-9d9a-cabc7e14a2e5',
    '28767b59-a7c8-8073-a220-fc7c96530658','27767b59-a7c8-8046-9e5b-ca4008ebe268',
    '28b67b59-a7c8-80f8-88e3-f8a07f191099','28d67b59-a7c8-800f-97cc-d027af3054be',
    '29467b59-a7c8-802b-bdca-c8277c4e3197','29d67b59-a7c8-801a-8015-f3df4142fc6d',
    '2a967b59-a7c8-8033-872e-c15b246bb956','2af67b59-a7c8-80c5-b14b-cf4294afcd0e',
    '2af67b59-a7c8-8066-a055-f23d5a29e69f','2c467b59-a7c8-80fa-9334-c2867a6d98a8',
    '2c567b59-a7c8-8053-881b-d9d62cc413bd','2e767b59-a7c8-80dd-aedc-f246eab3299c',
    '2f167b59-a7c8-803c-aed3-fb9598fa88e9','2e767b59-a7c8-807c-b006-db4f5f8ed3dd',
    '30367b59-a7c8-8069-ab51-d7e9513a21f3','30467b59-a7c8-80dc-8ad2-fb92c8745dd0',
    '33767b59-a7c8-803c-b962-fd424cd659b0',
  ],
  'Team Social': [
    '31267b59-a7c8-8015-9f26-efaae0e1b10e','31467b59-a7c8-80f7-9b50-fb51714facd1',
    '31467b59-a7c8-8057-9ace-f6148939c160','31467b59-a7c8-80ac-9655-d7dc3446b14e',
    '31467b59-a7c8-8044-986d-cd322301c00b','31467b59-a7c8-8019-88c3-d0f86580707b',
    '31467b59-a7c8-8097-8929-e158c774e831','31467b59-a7c8-80fb-8916-f9da732dbc45',
    '31767b59-a7c8-80a6-a322-fae9e3ad022e','2fb67b59-a7c8-80ba-805c-f4cd30af8968',
    '31a67b59-a7c8-80b2-b336-dfcf93f5e83b','31b67b59-a7c8-8093-9102-c28ea15b9810',
    '31b67b59-a7c8-80ff-bead-b553aee9ed6b','2e467b59-a7c8-803e-a36a-c5b28e2d33ee',
    '31f67b59-a7c8-804f-9466-fe682664f6ae','32567b59-a7c8-800e-bed3-f7d05b7dbd87',
    '31e67b59-a7c8-8056-9e8c-ef5a798fcc3b','32867b59-a7c8-8052-b469-c2d1dc6ac64a',
    '31067b59-a7c8-8063-94cc-e2e2321b53ce','32967b59-a7c8-8061-ae54-cd59b7854166',
    '32f67b59-a7c8-8082-8702-f121d23c7267','33667b59-a7c8-80d1-863f-c26f32bdd29a',
  ],
};

// Build reverse lookup: project ID → team name
function buildTeamLookup(): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [team, projectIds] of Object.entries(TEAM_PAGES)) {
    for (const id of projectIds) {
      lookup.set(id, team);
    }
  }
  return lookup;
}

const teamLookup = buildTeamLookup();

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
        const projects = parseNotionResults(data.results);

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

function parseNotionResults(results: any[]): NotionProject[] {
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
      team: teamLookup.get(id) || '',
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
