export const MKSH_BASE = 'https://www.mksh.phc.edu.tw';
export const MKSH_LUNCH_FEED = `${MKSH_BASE}/category/post-lunch/feed`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 LunchAngelBot/1.0';

function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function parseItems(xml) {
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/g;
  for (const match of String(xml).match(itemRe) ?? []) {
    const grab = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const m = match.match(re);
      return m ? m[1].trim() : '';
    };
    const guidMatch = match.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const pubMatch = match.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const linkMatch = match.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const title = decodeEntities(grab('title'));
    items.push({
      title,
      link: linkMatch ? linkMatch[1].trim() : '',
      guid: guidMatch ? guidMatch[1].trim() : title,
      pubDate: pubMatch ? pubMatch[1].trim() : '',
      description: decodeEntities(grab('description')),
      content: decodeEntities(grab('content:encoded')),
    });
  }
  return items;
}

export async function fetchLunchFeed() {
  const res = await fetch(MKSH_LUNCH_FEED, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`官方 RSS feed 取得失敗 (HTTP ${res.status})`);
  }
  return parseItems(await res.text());
}

export function extractPdfUrls(post) {
  const html = `${post.description}${post.content}`;
  const urls = [];
  const hrefRe = /href="([^"]+\.pdf(?:[?#][^"]*)?)"/gi;
  for (const m of html.matchAll(hrefRe)) {
    try {
      urls.push(new URL(m[1], MKSH_BASE).href);
    } catch {
      urls.push(m[1]);
    }
  }
  return urls;
}

export function extractPlainText(html) {
  return String(html)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\r/g, '')
    .replace(/(?:\t| )+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}