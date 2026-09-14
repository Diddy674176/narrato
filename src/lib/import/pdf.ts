import * as pdfjs from 'pdfjs-dist';
import { cleanText } from '../textProcess';

// Vite-friendly worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export async function extractPdfText(file: File): Promise<{ text: string; pageCount: number; scannedLikely: boolean }> {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .filter(Boolean);
    pages.push(strings.join(' '));
  }
  const text = cleanText(pages.join('\n\n'));
  const scannedLikely = text.replace(/\s/g, '').length < 40 && pdf.numPages > 0;
  return { text, pageCount: pdf.numPages, scannedLikely };
}
