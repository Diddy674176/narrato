import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { cleanPages } from '../textProcess';

// Vite resolves this to a hashed worker URL at build time.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface PdfResult {
  text: string;
  pageCount: number;
  /** True when the PDF has pages but almost no extractable text (a scan). */
  scannedLikely: boolean;
}

/**
 * Rebuild a page's text with its line structure intact.
 *
 * pdf.js hands back positioned text runs, not lines. Joining them all with
 * spaces (the obvious approach) destroys every paragraph and heading boundary,
 * which then breaks chapter detection and makes the narrator run headings
 * straight into body text. We use the end-of-line flag pdf.js provides, and
 * fall back to comparing baseline Y positions when it is absent.
 */
function pageText(items: TextItem[]): string {
  let out = '';
  let lastY: number | null = null;

  for (const item of items) {
    const y = item.transform?.[5] ?? null;

    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
      // A large vertical jump implies a paragraph break rather than a wrap.
      out += Math.abs(y - lastY) > 14 ? '\n\n' : '\n';
    } else if (out !== '' && !out.endsWith('\n') && !out.endsWith(' ')) {
      out += ' ';
    }

    out += item.str;
    if (item.hasEOL) out += '\n';
    if (y !== null) lastY = y;
  }

  return out;
}

export async function extractPdfText(
  file: File,
  onProgress?: (fraction: number) => void
): Promise<PdfResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is TextItem => 'str' in item);
    pages.push(pageText(items));
    page.cleanup();
    onProgress?.(i / pdf.numPages);
  }

  const text = cleanPages(pages);
  const density = text.replace(/\s/g, '').length / Math.max(1, pdf.numPages);
  // Under ~40 extractable characters per page, this is a scan, not a text PDF.
  const scannedLikely = pdf.numPages > 0 && density < 40;

  return { text, pageCount: pdf.numPages, scannedLikely };
}

/**
 * OCR a scanned PDF by rasterising each page and reading it.
 *
 * Far slower than text extraction, so it is only offered after
 * `scannedLikely` comes back true - never run automatically.
 */
export async function ocrPdf(
  file: File,
  onProgress?: (fraction: number, label: string) => void
): Promise<{ text: string; pageCount: number }> {
  const { createWorker } = await import('tesseract.js');
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;

  const worker = await createWorker('eng');
  const pages: string[] = [];

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      // 2x scale: OCR accuracy drops sharply below roughly 150 DPI.
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not create a canvas to render this PDF.');

      await page.render({ canvasContext: ctx, viewport }).promise;
      const { data: result } = await worker.recognize(canvas);
      pages.push(result.text ?? '');

      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      onProgress?.(i / pdf.numPages, `Reading page ${i} of ${pdf.numPages}`);
    }
  } finally {
    await worker.terminate();
  }

  return { text: cleanPages(pages), pageCount: pdf.numPages };
}
