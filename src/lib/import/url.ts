import { cleanText } from '../textProcess';

/**
 * Web article extraction ("reader mode").
 *
 * Two-step by design. A browser can rarely fetch a third-party page directly
 * because of CORS, and the usual workaround - bouncing the request through a
 * public proxy - means handing that URL to someone else. That is a privacy
 * decision the user should make, so `fetchDirect` runs first and the caller
 * has to explicitly opt in to `fetchViaProxy`.
 *
 * Paywalls, logins and other access controls are never bypassed: we only parse
 * whatever HTML the server chooses to return.
 */

export interface ArticleResult {
  title: string;
  text: string;
  via: 'direct' | 'proxy';
  siteName: string | null;
}

/** Elements that are never article content. */
const JUNK_SELECTOR =
  'script,style,noscript,iframe,svg,form,nav,aside,header,footer,button,' +
  '[role="navigation"],[role="banner"],[role="complementary"],[aria-hidden="true"],' +
  '.ad,.ads,.advert,.advertisement,.cookie,.cookies,.newsletter,.subscribe,' +
  '.social,.share,.sharing,.related,.recommended,.comments,.comment,.sidebar,' +
  '.nav,.menu,.breadcrumb,.paywall,.promo,.popup,.modal';

/**
 * Proportion of a block's text that sits inside links.
 *
 * Navigation and "related stories" blocks are mostly links; real prose is not.
 */
function linkDensity(el: Element): number {
  const total = el.textContent?.length ?? 0;
  if (total === 0) return 1;
  let linkChars = 0;
  el.querySelectorAll('a').forEach((a) => {
    linkChars += a.textContent?.length ?? 0;
  });
  return linkChars / total;
}

/**
 * Score candidate containers and keep the best one.
 *
 * A deliberately small readability heuristic: paragraph text is worth points,
 * link-heavy blocks are penalised, and semantic <article> gets a bonus.
 */
function pickArticleRoot(doc: Document): Element {
  const candidates = [
    ...doc.querySelectorAll('article,main,[role="main"],.post,.article,.content,.entry-content,#content,div,section'),
  ];

  let best: Element = doc.body;
  let bestScore = 0;

  for (const el of candidates) {
    const paragraphs = el.querySelectorAll('p');
    if (paragraphs.length < 2) continue;

    let score = 0;
    paragraphs.forEach((p) => {
      const len = p.textContent?.trim().length ?? 0;
      // Very short <p> tags are captions and bylines, not body text.
      if (len > 60) score += len;
    });

    score *= 1 - Math.min(0.9, linkDensity(el));
    if (el.tagName === 'ARTICLE') score *= 1.5;
    if (/comment|sidebar|footer|related|promo/i.test(el.className || '')) score *= 0.2;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function parseArticle(html: string, url: string, via: 'direct' | 'proxy'): ArticleResult {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(JUNK_SELECTOR).forEach((el) => el.remove());

  const meta = (name: string): string | null =>
    doc.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute('content') ??
    null;

  const title =
    meta('og:title') ??
    doc.querySelector('h1')?.textContent?.trim() ??
    doc.querySelector('title')?.textContent?.trim() ??
    url;

  const siteName = meta('og:site_name');
  const root = pickArticleRoot(doc);

  // Walk block elements in document order so headings stay attached to the
  // text they introduce.
  const parts: string[] = [];
  root.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre').forEach((el) => {
    if (el.closest(JUNK_SELECTOR)) return;
    const t = el.textContent?.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const isHeading = /^H[1-4]$/.test(el.tagName);
    if (!isHeading && t.length < 25) return;
    parts.push(t);
  });

  let text = cleanText(parts.join('\n\n'));
  if (text.length < 200) {
    // Last resort: take the raw text of the best container.
    text = cleanText(root.textContent ?? '');
  }

  if (text.length < 120) {
    throw new Error(
      'No readable article text was found at this address. The page may require sign-in, or it may be built entirely in JavaScript. Try pasting the text instead.'
    );
  }

  return { title: title.trim(), text, via, siteName };
}

/** Same-origin or CORS-permitted fetch. Usually fails for third-party sites. */
export async function fetchDirect(url: string): Promise<ArticleResult> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`The site returned HTTP ${res.status}.`);
  return parseArticle(await res.text(), url, 'direct');
}

/**
 * Fetch through a public CORS proxy.
 *
 * The caller must have told the user that the URL is sent to a third party.
 */
export async function fetchViaProxy(url: string): Promise<ArticleResult> {
  const endpoint = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error(`The proxy returned HTTP ${res.status}.`);
  const html = await res.text();
  if (html.trim().length === 0) throw new Error('The proxy returned an empty response.');
  return parseArticle(html, url, 'proxy');
}

export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Enter a web address.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https addresses are supported.');
    }
    return parsed.toString();
  } catch {
    throw new Error('That does not look like a valid web address.');
  }
}
