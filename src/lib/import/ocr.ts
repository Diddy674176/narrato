import Tesseract from 'tesseract.js';
import { cleanText } from '../textProcess';

export async function extractImageText(
  file: File,
  onProgress?: (p: number) => void
): Promise<{ text: string; confidence: number }> {
  const result = await Tesseract.recognize(file, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.(m.progress);
      }
    },
  });
  const text = cleanText(result.data.text || '');
  return { text, confidence: result.data.confidence ?? 0 };
}
