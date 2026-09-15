/**
 * Text normalisation for narration.
 *
 * The single biggest cause of "robotic" sounding TTS on real documents is not
 * the voice model - it is dirty text. PDFs arrive with words hyphenated across
 * line breaks, sentences wrapped mid-clause, and the same running header on
 * every page. Feeding that straight to a voice model produces false pauses and
 * garbled words. Everything here exists to fix that *without* changing meaning.
 */

// Invisible characters written as escapes so the source stays ASCII-only.
const ZERO_WIDTH = new RegExp('[\\u200B-\\u200D\\uFEFF\\u00AD]', 'g');
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

/** Lines that are nothing but a page number or roman numeral. */
const PAGE_NUMBER_LINE = /^\s*(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})\s*$/i;

/** Abbreviations that end in "." but do not end a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'fr', 'rev', 'hon',
  'gen', 'col', 'capt', 'lt', 'sgt', 'cmdr', 'adm', 'gov', 'sen', 'rep',
  'vs', 'etc', 'eg', 'ie', 'al', 'inc', 'ltd', 'co', 'corp', 'dept', 'est',
  'fig', 'vol', 'no', 'pp', 'ed', 'approx', 'apt', 'ave', 'blvd', 'rd',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
]);

/** Strip invisible junk and normalise line endings. */
function normaliseWhitespace(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, ' ')
    .replace(/\t/g, ' ')
    .replace(new RegExp('[ \\u00A0]{2,}', 'g'), ' ');
}

/**
 * Rejoin words split across a line break ("care-\nfully" -> "carefully").
 * When the second half is capitalised we keep the hyphen, since that is
 * usually a real compound ("Anglo-Saxon") rather than a layout artefact.
 */
function dehyphenate(input: string): string {
  return input
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    .replace(/([a-z])-\n([A-Z])/g, '$1-$2');
}

/**
 * Join lines that were soft-wrapped by the source layout rather than authored
 * as separate lines. Conservative on purpose: we only join when the break
 * clearly falls inside a sentence, so lists, headings and verse survive.
 */
function joinWrappedLines(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const prev = out[out.length - 1];

    if (prev === undefined || prev === '' || line === '') {
      out.push(line);
      continue;
    }

    const prevEndsSentence = /[.!?:;"'’”…)\]]$/.test(prev);
    const startsLower = /^[a-z,;]/.test(line);
    const prevEndsWithComma = /,$/.test(prev);
    const startsWithBullet = /^\s*(?:[-*•·]|\d+[.)])\s/.test(line);

    const isContinuation =
      !startsWithBullet && !prevEndsSentence && (startsLower || prevEndsWithComma);

    if (isContinuation) {
      out[out.length - 1] = `${prev} ${line.trimStart()}`;
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

/** Drop lines that are only a page number, and runs of identical lines. */
function dropNoiseLines(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let lastMeaningful = '';

  for (const line of lines) {
    const t = line.trim();
    if (t !== '' && PAGE_NUMBER_LINE.test(t)) continue;
    if (t !== '' && t === lastMeaningful) continue;
    if (t !== '') lastMeaningful = t;
    out.push(line);
  }
  return out.join('\n');
}

/** Main entry point used by every importer. */
export function cleanText(raw: string): string {
  if (!raw) return '';
  let text = normaliseWhitespace(raw);
  text = dehyphenate(text);
  text = joinWrappedLines(text);
  text = dropNoiseLines(text);
  return text
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Page-aware cleaning for paginated sources (PDF).
 *
 * Running headers and footers repeat on most pages; we detect them by
 * frequency rather than by guessing at positions, then remove them before the
 * pages are joined into continuous prose.
 */
export function cleanPages(pages: string[]): string {
  if (pages.length === 0) return '';
  if (pages.length < 3) return cleanText(pages.join('\n\n'));

  const firstLines = new Map<string, number>();
  const lastLines = new Map<string, number>();

  const pageLines = pages.map((p) =>
    normaliseWhitespace(p)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
  );

  for (const lines of pageLines) {
    if (lines.length === 0) continue;
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (first) firstLines.set(first, (firstLines.get(first) ?? 0) + 1);
    if (last) lastLines.set(last, (lastLines.get(last) ?? 0) + 1);
  }

  const threshold = Math.max(3, Math.floor(pages.length * 0.5));
  // A repeated *short* line is a running head; long repeated lines are content.
  const isRepeated = (map: Map<string, number>, line: string): boolean =>
    (map.get(line) ?? 0) >= threshold && line.length <= 120;

  const cleanedPages = pageLines.map((lines) => {
    let start = 0;
    let end = lines.length;
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (first !== undefined && isRepeated(firstLines, first)) start = 1;
    if (end - 1 > start && last !== undefined && isRepeated(lastLines, last)) end -= 1;
    return lines.slice(start, end).join('\n');
  });

  return cleanText(cleanedPages.join('\n\n'));
}

/* ------------------------------------------------------------------ *
 * Sentence / paragraph segmentation
 * ------------------------------------------------------------------ */

/**
 * Split prose into sentences, keeping trailing punctuation and closing quotes
 * attached. Handles abbreviations, decimals and initials so we do not insert a
 * dramatic pause in the middle of "Dr. Vance said".
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    current += ch;

    if (ch === '\n') {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }

    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    // Absorb any run of terminators plus closing quotes/brackets.
    let j = i + 1;
    let run = ch;
    while (j < text.length && /[.!?]/.test(text[j]!)) {
      current += text[j];
      run += text[j];
      j++;
    }
    while (j < text.length && /["'’”)\]]/.test(text[j]!)) {
      current += text[j];
      j++;
    }
    i = j - 1;

    const trimmed = current.trim();
    const rest = text.slice(j);

    // An ellipsis is a pause inside a sentence far more often than an ending.
    // Splitting on it produces fragments like "Well..." / "I suppose so.",
    // so we treat a run of dots as non-terminal and let the sentence continue.
    if (/^\.{2,}$/.test(run)) continue;

    // Decimal number: "3.14"
    if (ch === '.' && /\d$/.test(trimmed.slice(0, -1)) && /^\s?\d/.test(rest)) continue;

    // Known abbreviation, or a single-letter initial ("J. R. R.")
    const lastWord = trimmed.slice(0, -1).split(/[\s(]/).pop()?.toLowerCase() ?? '';
    if (ch === '.' && (ABBREVIATIONS.has(lastWord) || /^[a-z]$/i.test(lastWord))) continue;

    // A sentence ends only when what follows looks like a new one.
    if (rest !== '') {
      if (!/^\s/.test(rest)) continue;
      if (!/^\s*[A-Z"'‘“—(\[\d]/.test(rest)) continue;
    }

    if (trimmed !== '') out.push(trimmed);
    current = '';
  }

  if (current.trim() !== '') out.push(current.trim());
  return out.filter((s) => s.length > 0);
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function countWords(text: string): number {
  const m = text.match(/[\w'’-]+/g);
  return m ? m.length : 0;
}

/**
 * Kokoro narrates at roughly 155 words/minute at 1x. We use this before any
 * audio exists so the buffer planner has something to work with, and to show
 * "3 hr 20 min" on a library card.
 */
export const WORDS_PER_MINUTE = 155;

export function estimateSeconds(text: string): number {
  return (countWords(text) / WORDS_PER_MINUTE) * 60;
}
