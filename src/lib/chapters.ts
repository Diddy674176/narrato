import type { Chapter } from '../types';
import { splitParagraphs, countWords } from './textProcess';

/**
 * Chapter detection.
 *
 * Real books mark chapters in wildly inconsistent ways, so we score candidate
 * heading lines rather than trusting a single pattern. A heading has to be
 * short, standalone, and look like a heading - that keeps us from turning
 * every line of dialogue into a new chapter.
 */

const HEADING_KEYWORDS =
  /^(chapter|chap\.?|part|book|section|prologue|epilogue|introduction|intro|foreword|afterword|preface|appendix|interlude|act|scene)\b/i;

/** "Chapter Twelve", "CHAPTER 12", "Part I" */
const NUMBER_WORD =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\b/i;

const MARKDOWN_HEADING = /^#{1,4}\s+\S/;

/** Longest a line can be and still plausibly be a chapter heading. */
const MAX_HEADING_CHARS = 90;

function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > MAX_HEADING_CHARS) return false;
  // A heading is one line; anything with sentence-ending punctuation mid-line
  // and a lot of words is prose.
  if (MARKDOWN_HEADING.test(t)) return true;

  const words = countWords(t);
  if (words > 12) return false;

  if (HEADING_KEYWORDS.test(t)) {
    // "Chapter 4", "Chapter Four", "Chapter 4: The Gate", or a bare "Prologue"
    return (
      /\d/.test(t) ||
      NUMBER_WORD.test(t) ||
      /^(prologue|epilogue|introduction|intro|foreword|afterword|preface)\b/i.test(t) ||
      words <= 4
    );
  }

  // Short ALL-CAPS lines are a very common chapter style.
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase() && words <= 8) {
    return !/[.!?]$/.test(t);
  }

  return false;
}

function cleanHeadingTitle(line: string): string {
  return line.replace(/^#{1,4}\s+/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Break a long chapter-less document into readable parts so the chapter list
 * and "next/previous chapter" controls stay useful.
 */
function synthesiseParts(text: string, targetChars: number): Chapter[] {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) return [];

  const parts: Chapter[] = [];
  let buffer: string[] = [];
  let size = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    parts.push({
      index: parts.length,
      title: `Part ${parts.length + 1}`,
      text: buffer.join('\n\n'),
    });
    buffer = [];
    size = 0;
  };

  for (const p of paragraphs) {
    buffer.push(p);
    size += p.length;
    if (size >= targetChars) flush();
  }
  flush();

  return parts;
}

/**
 * Split cleaned document text into chapters.
 *
 * @param text   Cleaned document text.
 * @param title  Document title, used when the text has no headings at all.
 */
export function detectChapters(text: string, title: string): Chapter[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  const lines = trimmed.split('\n');
  const chapters: Chapter[] = [];
  let currentTitle: string | null = null;
  let body: string[] = [];

  const push = () => {
    const content = body.join('\n').trim();
    // Ignore a "chapter" that is just a heading with no text under it; its
    // heading gets folded into the next one instead of creating an empty entry.
    if (content === '' && currentTitle === null) return;
    if (content === '') return;
    chapters.push({
      index: chapters.length,
      title: currentTitle ?? title,
      text: content,
    });
    body = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prevBlank = i === 0 || lines[i - 1]!.trim() === '';
    const nextBlank = i === lines.length - 1 || lines[i + 1]!.trim() === '';

    // A heading must stand alone in its own block.
    if (looksLikeHeading(line) && prevBlank && (nextBlank || MARKDOWN_HEADING.test(line.trim()))) {
      push();
      currentTitle = cleanHeadingTitle(line);
      continue;
    }
    body.push(line);
  }
  push();

  const totalChars = trimmed.length;

  // No headings found: fall back to synthetic parts for long documents, or a
  // single chapter for short ones.
  if (chapters.length === 0) {
    return totalChars > 40_000
      ? synthesiseParts(trimmed, 20_000)
      : [{ index: 0, title, text: trimmed }];
  }

  if (chapters.length === 1 && totalChars > 40_000) {
    const first = chapters[0]!;
    const parts = synthesiseParts(first.text, 20_000);
    if (parts.length > 1) return parts;
  }

  // Guard against a false positive storm (e.g. an all-caps stylised book that
  // produced hundreds of one-line "chapters").
  const tiny = chapters.filter((c) => c.text.length < 200).length;
  if (chapters.length > 8 && tiny / chapters.length > 0.6) {
    return totalChars > 40_000
      ? synthesiseParts(trimmed, 20_000)
      : [{ index: 0, title, text: trimmed }];
  }

  return chapters.map((c, i) => ({ ...c, index: i }));
}
