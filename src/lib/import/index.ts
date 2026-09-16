import type { Chapter, DocContent, DocMeta, DocSource } from '../../types';
import { detectChapters } from '../chapters';
import { putContent, putDoc } from '../db';
import { makeId } from '../hash';
import { countWords, estimateSeconds } from '../textProcess';
import { extractDocx } from './docx';
import { extractEpub } from './epub';
import { extractImageText } from './ocr';
import { extractPdfText, ocrPdf } from './pdf';
import { extractTxt } from './txt';

/**
 * Import pipeline: raw input in, a stored, chaptered document out.
 */

export interface ImportProgress {
  label: string;
  /** 0-1, or null when the step has no measurable progress. */
  fraction: number | null;
}

export type ProgressFn = (p: ImportProgress) => void;

export interface ImportedDoc {
  meta: DocMeta;
  content: DocContent;
  /** Non-fatal notes worth showing, e.g. low OCR confidence. */
  warnings: string[];
  /** True when a PDF looks scanned and OCR is worth offering. */
  needsOcr: boolean;
}

const EMOJI_BY_SOURCE: Record<DocSource, string> = {
  paste: '\u{1F4DD}',
  txt: '\u{1F4C4}',
  pdf: '\u{1F4D5}',
  docx: '\u{1F4D8}',
  epub: '\u{1F4D6}',
  image: '\u{1F5BC}️',
  url: '\u{1F517}',
};

/** Detect the document's language well enough to warn about voice support. */
export function detectLanguage(text: string): string {
  const sample = text.slice(0, 4000);
  if (/[一-鿿]/.test(sample)) return 'zh';
  if (/[぀-ヿ]/.test(sample)) return 'ja';
  if (/[가-힯]/.test(sample)) return 'ko';
  if (/[Ѐ-ӿ]/.test(sample)) return 'ru';
  if (/[؀-ۿ]/.test(sample)) return 'ar';
  if (/[ऀ-ॿ]/.test(sample)) return 'hi';
  if (/[Ͱ-Ͽ]/.test(sample)) return 'el';

  // Latin script: separate the common European languages by stopwords.
  const lower = ` ${sample.toLowerCase()} `;
  const score = (words: string[]): number =>
    words.reduce((n, w) => n + (lower.split(` ${w} `).length - 1), 0);

  const scores: Array<[string, number]> = [
    ['en', score(['the', 'and', 'of', 'to', 'that', 'was', 'with'])],
    ['es', score(['el', 'la', 'que', 'de', 'los', 'una', 'por'])],
    ['fr', score(['le', 'la', 'les', 'des', 'une', 'que', 'pour'])],
    ['de', score(['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit'])],
    ['pt', score(['o', 'de', 'que', 'nao', 'uma', 'para', 'com'])],
    ['it', score(['il', 'che', 'di', 'la', 'per', 'una', 'sono'])],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [lang, best] = scores[0]!;
  return best > 3 ? lang : 'en';
}

/** Build meta + content records from finished text. */
export function buildDoc(opts: {
  title: string;
  author: string | null;
  source: DocSource;
  sourceRef: string | null;
  chapters: Chapter[];
}): { meta: DocMeta; content: DocContent } {
  const id = makeId('doc');
  const fullText = opts.chapters.map((c) => c.text).join('\n\n');
  const now = Date.now();

  const meta: DocMeta = {
    id,
    title: opts.title.trim() || 'Untitled',
    author: opts.author,
    source: opts.source,
    sourceRef: opts.sourceRef,
    createdAt: now,
    updatedAt: now,
    wordCount: countWords(fullText),
    charCount: fullText.length,
    chapterCount: opts.chapters.length,
    estSeconds: estimateSeconds(fullText),
    favorite: false,
    keepOffline: false,
    finished: false,
    coverEmoji: EMOJI_BY_SOURCE[opts.source],
    description: fullText.slice(0, 220).replace(/\s+/g, ' ').trim(),
    language: detectLanguage(fullText),
  };

  return { meta, content: { id, chapters: opts.chapters } };
}

export async function saveDoc(doc: { meta: DocMeta; content: DocContent }): Promise<void> {
  await putContent(doc.content);
  await putDoc(doc.meta);
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

/** Route a file to the right extractor by extension, then by MIME type. */
export async function importFile(file: File, onProgress: ProgressFn): Promise<ImportedDoc> {
  const name = file.name.toLowerCase();
  const warnings: string[] = [];

  const finish = (
    text: string,
    source: DocSource,
    title: string,
    author: string | null,
    needsOcr = false
  ): ImportedDoc => {
    const chapters = detectChapters(text, title);
    const built = buildDoc({ title, author, source, sourceRef: file.name, chapters });
    return { ...built, warnings, needsOcr };
  };

  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    onProgress({ label: 'Reading PDF', fraction: 0 });
    const result = await extractPdfText(file, (f) =>
      onProgress({ label: 'Reading PDF', fraction: f })
    );
    if (result.scannedLikely) {
      return {
        ...finish(result.text, 'pdf', baseName(file.name), null, true),
        needsOcr: true,
      };
    }
    return finish(result.text, 'pdf', baseName(file.name), null);
  }

  if (name.endsWith('.epub')) {
    onProgress({ label: 'Reading EPUB', fraction: null });
    const epub = await extractEpub(file);
    const built = buildDoc({
      title: epub.title,
      author: epub.author,
      source: 'epub',
      sourceRef: file.name,
      chapters: epub.chapters,
    });
    return { ...built, warnings, needsOcr: false };
  }

  if (name.endsWith('.docx')) {
    onProgress({ label: 'Reading Word document', fraction: null });
    const { text, messages } = await extractDocx(file);
    if (messages.length > 0) {
      warnings.push(`Some formatting was not converted (${messages.length} note(s)).`);
    }
    return finish(text, 'docx', baseName(file.name), null);
  }

  if (name.endsWith('.doc')) {
    throw new Error(
      'Legacy .doc files are not supported. Save the file as .docx or paste the text instead.'
    );
  }

  if (file.type.startsWith('image/')) {
    onProgress({ label: 'Reading text from image', fraction: 0 });
    const result = await extractImageText(file, (f) =>
      onProgress({ label: 'Reading text from image', fraction: f })
    );
    if (result.confidence < 70) {
      warnings.push(
        `The image was hard to read (${Math.round(result.confidence)}% confidence). Check the text before listening.`
      );
    }
    return finish(result.text, 'image', baseName(file.name), null);
  }

  if (
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.markdown') ||
    file.type.startsWith('text/')
  ) {
    onProgress({ label: 'Reading text file', fraction: null });
    const text = await extractTxt(file);
    return finish(text, 'txt', baseName(file.name), null);
  }

  throw new Error(
    `"${file.name}" is not a supported file type yet. Narrato reads PDF, EPUB, DOCX, TXT, Markdown and images.`
  );
}

/** Re-import a scanned PDF through OCR after the user opts in. */
export async function importPdfWithOcr(
  file: File,
  onProgress: ProgressFn
): Promise<ImportedDoc> {
  const result = await ocrPdf(file, (fraction, label) => onProgress({ label, fraction }));
  const title = baseName(file.name);
  const chapters = detectChapters(result.text, title);
  const built = buildDoc({
    title,
    author: null,
    source: 'pdf',
    sourceRef: file.name,
    chapters,
  });
  return { ...built, warnings: [], needsOcr: false };
}

export function importPastedText(text: string, title: string): ImportedDoc {
  const chapters = detectChapters(text, title || 'Pasted text');
  const built = buildDoc({
    title: title || 'Pasted text',
    author: null,
    source: 'paste',
    sourceRef: null,
    chapters,
  });
  return { ...built, warnings: [], needsOcr: false };
}
