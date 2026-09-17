import { cleanText } from '../textProcess';

/**
 * Image OCR (screenshots, textbook photos, worksheets).
 *
 * Runs entirely on-device with tesseract.js - photos of homework never leave
 * the phone. The language data is fetched once and then cached by the service
 * worker.
 */

export interface OcrResult {
  text: string;
  /** 0-100. Below ~70 the text is worth showing for correction before reading. */
  confidence: number;
}

/**
 * Downscale very large photos before OCR.
 *
 * A modern phone camera produces 12 MP images; Tesseract gets no more accurate
 * above roughly 2500px on the long edge but does get dramatically slower, and
 * on a phone it may simply run out of memory.
 */
async function prepareImage(file: File): Promise<Blob> {
  const MAX_EDGE = 2500;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= MAX_EDGE) {
    bitmap.close();
    return file;
  }

  const scale = MAX_EDGE / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  );
  canvas.width = 0;
  canvas.height = 0;
  return blob ?? file;
}

export async function extractImageText(
  file: File,
  onProgress?: (fraction: number) => void
): Promise<OcrResult> {
  const { createWorker } = await import('tesseract.js');
  const image = await prepareImage(file);

  const worker = await createWorker('eng', undefined, {
    logger: (m: { status?: string; progress?: number }) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.(m.progress);
      }
    },
  });

  try {
    const { data } = await worker.recognize(image);
    const text = cleanText(data.text ?? '');
    if (text.trim().length === 0) {
      throw new Error('Text could not be detected in this image.');
    }
    return { text, confidence: data.confidence ?? 0 };
  } finally {
    await worker.terminate();
  }
}
