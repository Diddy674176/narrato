import JSZip from 'jszip';
import { cleanText } from '../textProcess';
import type { Chapter } from '../../types';

/**
 * EPUB reader.
 *
 * An EPUB is a zip of XHTML documents plus an OPF manifest that defines the
 * reading order ("spine"). We follow the spine rather than reading files in
 * archive order, because archive order is arbitrary and would shuffle the book.
 *
 * DRM-protected EPUBs are not opened - if the archive is encrypted we report
 * it and stop.
 */

export interface EpubResult {
  title: string;
  author: string | null;
  chapters: Chapter[];
}

/** Resolve an href that is relative to the OPF file's own directory. */
function resolveHref(opfPath: string, href: string): string {
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const joined = `${base}${href}`.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function textFromXhtml(xhtml: string): { title: string | null; text: string } {
  const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
  const body = doc.querySelector('body') ?? doc.documentElement;
  if (!body) return { title: null, text: '' };

  body.querySelectorAll('script,style,nav,svg').forEach((el) => el.remove());

  const heading = body.querySelector('h1,h2,h3')?.textContent?.trim() ?? null;

  // Convert block elements to real line breaks so paragraphs survive.
  const parts: string[] = [];
  body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,div').forEach((el) => {
    // Only take leaf-ish blocks, otherwise nested divs duplicate their children.
    if (el.querySelector('p,h1,h2,h3,h4,h5,h6,li,blockquote')) return;
    const t = el.textContent?.trim();
    if (t) parts.push(t);
  });

  const text = parts.length > 0 ? parts.join('\n\n') : (body.textContent ?? '');
  return { title: heading, text };
}

export async function extractEpub(file: File): Promise<EpubResult> {
  const zip = await JSZip.loadAsync(file);

  if (zip.file('META-INF/encryption.xml')) {
    throw new Error(
      'This EPUB is DRM-protected, so its text cannot be read. Narrato does not bypass DRM.'
    );
  }

  // container.xml points at the OPF package document.
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('This file is not a valid EPUB (no container.xml).');

  const containerXml = await containerFile.async('string');
  const container = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('This EPUB is missing its package document.');

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('This EPUB is missing its package document.');

  const opfXml = await opfFile.async('string');
  const opf = new DOMParser().parseFromString(opfXml, 'application/xml');

  const title =
    opf.querySelector('metadata > *|title, title')?.textContent?.trim() ||
    file.name.replace(/\.epub$/i, '');
  const author =
    opf.querySelector('metadata > *|creator, creator')?.textContent?.trim() || null;

  // manifest id -> href
  const manifest = new Map<string, string>();
  opf.querySelectorAll('manifest > item').forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) manifest.set(id, href);
  });

  const spine: string[] = [];
  opf.querySelectorAll('spine > itemref').forEach((ref) => {
    const idref = ref.getAttribute('idref');
    if (!idref) return;
    const href = manifest.get(idref);
    if (href) spine.push(resolveHref(opfPath, href));
  });

  if (spine.length === 0) throw new Error('This EPUB has no readable reading order.');

  const chapters: Chapter[] = [];
  for (const path of spine) {
    const entry = zip.file(path);
    if (!entry) continue;
    const xhtml = await entry.async('string');
    const { title: heading, text } = textFromXhtml(xhtml);
    const cleaned = cleanText(text);
    // Skip covers, blank pages and short front-matter stubs.
    if (cleaned.length < 120) continue;
    chapters.push({
      index: chapters.length,
      title: heading || `Chapter ${chapters.length + 1}`,
      text: cleaned,
    });
  }

  if (chapters.length === 0) {
    throw new Error('No readable text was found in this EPUB.');
  }

  return { title, author, chapters };
}
