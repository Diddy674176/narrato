import { cleanText } from '../textProcess';

/**
 * Best-effort article extract. Many sites block browser CORS —
 * we try direct fetch, then a public CORS proxy fallback, then ask user to paste.
 */
export async function extractUrlArticle(url: string): Promise<{ title: string; text: string; via: string }> {
  let html = '';
  let via = 'direct';
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch {
    // AllOrigins-style public proxy (best-effort, may be rate-limited)
    try {
      const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      const res = await fetch(proxy);
      if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
      html = await res.text();
      via = 'cors-proxy';
    } catch {
      throw new Error(
        'This webpage could not be accessed (CORS or network). Paste the article text instead.'
      );
    }
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove junk
  doc.querySelectorAll('script,style,nav,footer,aside,iframe,noscript,form,svg').forEach((el) => el.remove());
  const title =
    doc.querySelector('h1')?.textContent?.trim() ||
    doc.querySelector('title')?.textContent?.trim() ||
    url;

  const article =
    doc.querySelector('article') ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector('main') ||
    doc.body;

  // Simple readability: prefer paragraphs
  const ps = [...(article?.querySelectorAll('p,h1,h2,h3,li') ?? [])]
    .map((el) => el.textContent?.trim() || '')
    .filter((t) => t.length > 40 || /^h/i.test(''));

  let text = '';
  if (ps.length >= 3) {
    text = [...(article?.querySelectorAll('h1,h2,h3,p,li') ?? [])]
      .map((el) => el.textContent?.trim() || '')
      .filter(Boolean)
      .join('\n\n');
  } else {
    text = article?.textContent || '';
  }

  text = cleanText(text);
  if (text.length < 80) {
    throw new Error('Could not extract readable article content. Paste the text instead.');
  }
  return { title, text, via };
}
