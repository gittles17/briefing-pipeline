import * as cheerio from 'cheerio';
import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CACHE_PATH = join(homedir(), 'briefing-data', 'industry-intel.txt');

// RSS feeds — entertainment trades + gaming
const FEEDS = [
  { url: 'https://deadline.com/feed/', label: 'Deadline' },
  { url: 'https://variety.com/feed/', label: 'Variety' },
  { url: 'https://www.hollywoodreporter.com/feed/', label: 'THR' },
  { url: 'https://www.thewrap.com/feed/', label: 'The Wrap' },
  { url: 'https://www.polygon.com/rss/index.xml', label: 'Polygon' },
  { url: 'https://feeds.feedburner.com/ign/all', label: 'IGN' },
];

// Known aliases — maps Notion client names to additional search terms
// so "HBO/Max" also matches "hbo max", "Warner Brothers" matches "warner bros", etc.
const CLIENT_ALIASES: Record<string, string[]> = {
  'hbo': ['hbo max', 'max'],
  'warner brothers': ['warner bros', 'wbd', 'warner bros. discovery'],
  'fx': ['fxx'],
  'mgm': ['mgm/amazon'],
  'amazon': ['prime video'],
  'disney': ['walt disney'],
  'disney/marvel': ['marvel', 'mcu'],
  'sony': ['sony pictures'],
  'sony television': ['sony tv'],
  'universal': ['focus features', 'searchlight'],
  'bethesda': ['bethesda softworks', 'bethesda game studios'],
  'bandai namco': ['bandai', 'namco'],
  'ea': ['electronic arts', 'ea sports'],
};

// Active project titles and clients from Notion (refreshed each run)
async function loadProjectTitles(): Promise<string[]> {
  try {
    const notionCache = await readFile(join(homedir(), 'briefing-data', 'notion-projects.txt'), 'utf-8');
    const titles: string[] = [];
    for (const line of notionCache.split('\n')) {
      const match = line.match(/^- (?:🆕 )?(.+?)(?:\s*\[|\s*\{|\s*\(|$)/);
      if (match) {
        const title = match[1].trim().toLowerCase();
        if (title.length > 3) titles.push(title);
      }
    }
    return titles;
  } catch {
    return [];
  }
}

// Dynamically extract all active clients from Notion + expand with aliases
async function loadNotionClients(): Promise<string[]> {
  const clients = new Set<string>();
  try {
    const notionCache = await readFile(join(homedir(), 'briefing-data', 'notion-projects.txt'), 'utf-8');
    const clientPattern = /\[([^\]]+)\]/g;
    let match;
    while ((match = clientPattern.exec(notionCache)) !== null) {
      const raw = match[1].trim();
      if (!raw || raw.startsWith('=') || raw.length < 2) continue;
      const client = raw.toLowerCase();

      // Add the client name as-is
      clients.add(client);

      // Split compound clients (e.g., "Disney/Marvel" → "disney", "marvel")
      for (const part of client.split('/')) {
        const p = part.trim();
        if (p.length > 2) clients.add(p);
      }

      // Expand known aliases
      for (const [key, aliases] of Object.entries(CLIENT_ALIASES)) {
        if (client.includes(key)) {
          for (const alias of aliases) clients.add(alias);
        }
      }
    }
  } catch {}

  console.log(`[industry-intel] ${clients.size} active clients loaded from Notion`);
  return [...clients];
}

// Keywords relevant to Create's space (entertainment marketing)
const INDUSTRY_KEYWORDS = [
  'key art', 'movie poster', 'trailer', 'teaser', 'marketing campaign',
  'box office', 'premiere', 'greenlit', 'greenlight', 'renewed', 'cancelled',
  'canceled', 'picked up', 'ordered to series', 'season \\d',
  'entertainment marketing', 'studio marketing', 'film marketing',
  'awards campaign', 'fyc', 'oscar', 'emmy', 'golden globe',
  'cinema con', 'cinemacon', 'comic-con', 'comic con', 'sdcc',
  'streaming war', 'subscriber', 'viewership', 'ratings',
  'cast', 'casting', 'first look', 'exclusive', 'official trailer',
  'release date', 'opening weekend',
];

// Keywords relevant to Glossi's space
const GLOSSI_KEYWORDS = [
  'creative automation', '3d visualization', 'unreal engine',
  'ai-generated', 'generative ai', 'ai creative', 'ai marketing',
  'e-commerce', 'product visualization', 'virtual production',
  'real-time rendering', 'cgi', 'visual effects', 'vfx',
];

// Gaming-specific keywords (Dan Pfister's division)
const GAMING_KEYWORDS = [
  'video game', 'game trailer', 'game marketing', 'esports',
  'playstation', 'xbox', 'nintendo', 'steam', 'epic games',
  'game awards', 'e3', 'gamescom', 'game adaptation',
  // Active gaming project titles & franchises
  'gta', 'starfield', 'fallout', 'ace combat', 'call of duty',
  'fortnite', 'tekken', 'elden ring', 'dark souls',
];

interface Article {
  title: string;
  link: string;
  source: string;
  category: string; // 'client', 'project', 'industry', 'gaming', 'glossi'
  relevance: number; // 0-10 score
  description: string;
}

let dynamicClients: string[] = []; // populated from Notion each run

async function fetchFeed(url: string, label: string): Promise<Article[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Create-Briefing/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    const articles: Article[] = [];
    $('item').each((i, el) => {
      if (i >= 30) return false; // limit per feed
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim().slice(0, 300);
      const categories = $(el).find('category').map((_, c) => $(c).text().toLowerCase()).get();

      if (!title) return;

      const combined = `${title} ${desc} ${categories.join(' ')}`.toLowerCase();
      const { score, category } = scoreArticle(combined, dynamicClients);

      if (score > 0) {
        articles.push({ title, link, source: label, category, relevance: score, description: desc });
      }
    });

    return articles;
  } catch {
    return [];
  }
}

function scoreArticle(text: string, clients: string[]): { score: number; category: string } {
  let score = 0;
  let category = 'industry';

  // Client match — highest value
  for (const client of clients) {
    if (text.includes(client)) {
      score += 5;
      category = 'client';
      break;
    }
  }

  // Industry keywords
  for (const kw of INDUSTRY_KEYWORDS) {
    if (new RegExp(kw, 'i').test(text)) {
      score += 2;
      break;
    }
  }

  // Gaming keywords
  for (const kw of GAMING_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      score += 3;
      category = score > 5 ? category : 'gaming';
      break;
    }
  }

  // Glossi keywords
  for (const kw of GLOSSI_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      score += 3;
      category = 'glossi';
      break;
    }
  }

  return { score, category };
}

async function matchProjects(articles: Article[], projectTitles: string[]): Promise<void> {
  for (const article of articles) {
    const titleLower = article.title.toLowerCase();
    for (const project of projectTitles) {
      if (project.length > 4 && titleLower.includes(project)) {
        article.relevance += 8; // Active project match is extremely relevant
        article.category = 'project';
        break;
      }
    }
  }
}

export async function fetchIndustryIntel(): Promise<string> {
  // Load active project titles and clients from Notion for matching
  const projectTitles = await loadProjectTitles();
  const notionClients = await loadNotionClients();

  // Fully dynamic — all clients come from Notion
  dynamicClients = notionClients;

  // Fetch all feeds in parallel
  const results = await Promise.allSettled(
    FEEDS.map(f => fetchFeed(f.url, f.label))
  );

  let allArticles: Article[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allArticles.push(...r.value);
  }

  // Match against active projects
  await matchProjects(allArticles, projectTitles);

  // Sort by relevance, deduplicate by similar titles
  allArticles.sort((a, b) => b.relevance - a.relevance);
  const seen = new Set<string>();
  const deduped: Article[] = [];
  for (const a of allArticles) {
    // Simple dedup: first 40 chars of title
    const key = a.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }

  // Group by category
  const byCategory = new Map<string, Article[]>();
  for (const a of deduped) {
    if (!byCategory.has(a.category)) byCategory.set(a.category, []);
    byCategory.get(a.category)!.push(a);
  }

  // Format output
  const lines: string[] = [];

  // Active project news first
  const projectNews = byCategory.get('project') || [];
  if (projectNews.length > 0) {
    lines.push('📋 NEWS ABOUT ACTIVE CREATE PROJECTS:');
    for (const a of projectNews.slice(0, 5)) {
      lines.push(`- [${a.source}] ${a.title} — ${a.link}`);
    }
    lines.push('');
  }

  // Client/studio news
  const clientNews = byCategory.get('client') || [];
  if (clientNews.length > 0) {
    lines.push('🎬 CREATE CLIENT & STUDIO NEWS:');
    for (const a of clientNews.slice(0, 10)) {
      lines.push(`- [${a.source}] ${a.title} — ${a.link}`);
    }
    lines.push('');
  }

  // Gaming
  const gamingNews = byCategory.get('gaming') || [];
  if (gamingNews.length > 0) {
    lines.push('🎮 GAMING:');
    for (const a of gamingNews.slice(0, 5)) {
      lines.push(`- [${a.source}] ${a.title} — ${a.link}`);
    }
    lines.push('');
  }

  // Glossi-relevant
  const glossiNews = byCategory.get('glossi') || [];
  if (glossiNews.length > 0) {
    lines.push('🔧 CREATIVE TECH & GLOSSI SPACE:');
    for (const a of glossiNews.slice(0, 5)) {
      lines.push(`- [${a.source}] ${a.title} — ${a.link}`);
    }
    lines.push('');
  }

  // General industry
  const industryNews = byCategory.get('industry') || [];
  if (industryNews.length > 0) {
    lines.push('📰 INDUSTRY:');
    for (const a of industryNews.slice(0, 5)) {
      lines.push(`- [${a.source}] ${a.title} — ${a.link}`);
    }
  }

  const output = lines.join('\n') || '(no relevant industry news today)';

  // Cache
  await writeFile(CACHE_PATH, output, 'utf-8').catch(() => {});

  return output;
}
