import * as cheerio from 'cheerio';

// Scrape multiple TLDR newsletters relevant to Glossi's space
const NEWSLETTERS = [
  { slug: 'ai', label: 'TLDR AI' },
  { slug: 'marketing', label: 'TLDR Marketing' },
  { slug: 'tech', label: 'TLDR Tech' },
  { slug: 'design', label: 'TLDR Design' },
];

async function scrapeTLDR(slug: string, date: string): Promise<string[]> {
  try {
    const url = `https://tldr.tech/${slug}/${date}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const headlines: string[] = [];
    $('h3').each((_, el) => {
      const title = $(el).text().trim();
      if (!title || title === 'More Stories') return;
      const link = $(el).find('a').attr('href')
        || $(el).closest('a').attr('href')
        || $(el).parent().find('a').first().attr('href')
        || '';
      if (link) {
        headlines.push(`${title} — ${link}`);
      } else {
        headlines.push(title);
      }
    });

    return headlines.slice(0, 8);
  } catch {
    return [];
  }
}

export async function fetchTLDR(): Promise<string> {
  const today = new Date().toISOString().split('T')[0];

  const results = await Promise.allSettled(
    NEWSLETTERS.map(async (nl) => {
      const headlines = await scrapeTLDR(nl.slug, today);
      if (headlines.length === 0) return '';
      return `[${nl.label}]\n${headlines.join('\n')}`;
    })
  );

  const sections = results
    .map(r => r.status === 'fulfilled' ? r.value : '')
    .filter(Boolean);

  return sections.join('\n\n') || '(no TLDR newsletters available today)';
}
