import { cleanText } from '../textProcess';

/**
 * Word (.docx) text extraction via mammoth.
 *
 * We ask for HTML rather than raw text so heading structure survives; chapter
 * detection then has real headings to work with instead of a flat wall of text.
 */
export async function extractDocx(file: File): Promise<{ text: string; messages: string[] }> {
  const mammoth = await import('mammoth/mammoth.browser.js');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });

  const doc = new DOMParser().parseFromString(result.value, 'text/html');
  const parts: string[] = [];

  doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote').forEach((el) => {
    const t = el.textContent?.trim();
    if (!t) return;
    // Keep headings on their own line so detectChapters can see them.
    parts.push(t);
  });

  const text = cleanText(parts.join('\n\n'));
  if (text.length < 20) {
    throw new Error('No readable text was found in this Word document.');
  }

  return {
    text,
    messages: (result.messages ?? []).map((m: { message: string }) => m.message),
  };
}
