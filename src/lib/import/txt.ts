import { cleanText } from '../textProcess';

/** Plain text / Markdown. Read as UTF-8; other encodings fall back to latin-1. */
export async function extractTxt(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();

  let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  // U+FFFD in quantity means the file was not UTF-8 after all.
  const replacements = (text.match(/�/g) ?? []).length;
  if (replacements > text.length * 0.01) {
    text = new TextDecoder('windows-1252').decode(buffer);
  }

  const cleaned = cleanText(text);
  if (cleaned.length === 0) throw new Error('This file appears to be empty.');
  return cleaned;
}
