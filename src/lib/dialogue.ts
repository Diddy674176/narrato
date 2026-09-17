import type { Chapter } from '../types';

/**
 * Dialogue segmentation and speaker attribution.
 *
 * This is deliberately conservative. The brief is explicit: if we are not sure
 * who is speaking, fall back to the narrator rather than guessing. A wrong
 * voice mid-scene is far more jarring than a narrator voice throughout, so
 * every rule here only fires on an explicit attribution cue.
 */

export interface DialogueSpan {
  start: number;
  end: number;
  text: string;
  /** null = narration. */
  speaker: string | null;
}

/** Verbs that mark a speech attribution. */
const SAY_VERBS =
  '(?:said|says|asked|asks|replied|replies|answered|answers|whispered|whispers|shouted|shouts|muttered|mutters|murmured|murmurs|cried|cries|yelled|yells|added|adds|continued|continues|began|begins|called|calls|breathed|snapped|snaps|growled|growls|laughed|laughs|sighed|sighs|offered|insisted|admitted|declared|demanded|observed|remarked|repeated|responded|screamed|stammered|hissed|barked|whimpered|roared|teased|warned)';

/** A capitalised name, optionally with a title or a second capitalised word. */
const NAME = '(?:(?:Mr|Mrs|Ms|Dr|Sir|Lady|Lord|Captain|Professor|Father|Mother|Aunt|Uncle|King|Queen|Prince|Princess)\\.?\\s+)?[A-Z][a-z\'\\u2019-]{1,20}(?:\\s+[A-Z][a-z\'\\u2019-]{1,20})?';

/** "said Marcus" / "Marcus said" immediately after a quote. */
const AFTER_QUOTE = new RegExp(
  `^[,.!?\\s\\u2014-]*(?:${SAY_VERBS}\\s+(${NAME})|(${NAME})\\s+${SAY_VERBS})\\b`
);

/** "Marcus said," directly before an opening quote. */
const BEFORE_QUOTE = new RegExp(`(${NAME})\\s+${SAY_VERBS}[,:]?\\s*$`);

/**
 * Words that look like names but are almost always sentence-initial words or
 * pronouns picked up by the capitalised-word pattern.
 */
const NOT_NAMES = new Set([
  'he', 'she', 'they', 'it', 'i', 'we', 'you', 'him', 'her', 'them', 'his', 'hers',
  'the', 'a', 'an', 'and', 'but', 'so', 'then', 'there', 'here', 'that', 'this',
  'what', 'who', 'why', 'how', 'when', 'where', 'if', 'as', 'at', 'in', 'on',
  'one', 'two', 'no', 'yes', 'oh', 'well', 'now', 'just', 'still', 'again',
  'someone', 'anyone', 'everyone', 'nobody', 'somebody', 'the man', 'the woman',
  'god', 'lord', 'chapter', 'part',
]);

function normaliseName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) return null;
  if (NOT_NAMES.has(name.toLowerCase())) return null;
  // Reject a bare title with no name attached.
  if (/^(mr|mrs|ms|dr|sir|lady|lord)\.?$/i.test(name)) return null;
  return name;
}

/**
 * Find quoted spans in a chapter and attribute each one to a speaker when the
 * text says so explicitly.
 *
 * Handles straight quotes and typographic quotes. Em-dash dialogue (used in
 * some translated fiction) is not attempted - it is ambiguous without deeper
 * parsing, and narration is the safe fallback.
 */
export function segmentDialogue(text: string): DialogueSpan[] {
  const spans: DialogueSpan[] = [];
  // Quote pairs: "..." and typographic open/close. Non-greedy, must be
  // non-empty, and may not span a blank line (that means the quote never closed).
  const quoteRe = /(["“])((?:(?!\n\s*\n)[\s\S]){1,2000}?)(["”])/g;

  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = quoteRe.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const inner = match[2] ?? '';

    const before = text.slice(Math.max(0, start - 120), start);
    const after = text.slice(end, end + 120);

    let speaker: string | null = null;
    const m1 = AFTER_QUOTE.exec(after);
    if (m1) speaker = normaliseName(m1[1] ?? m1[2] ?? '');
    if (!speaker) {
      const m2 = BEFORE_QUOTE.exec(before);
      if (m2) speaker = normaliseName(m2[1] ?? '');
    }

    // A one-word quotation is usually a quoted *term* ("the Gate"), not speech
    // - unless something explicitly attributes it, as in: "Fine," said Marcus.
    if (inner.trim().split(/\s+/).length < 2 && !speaker) continue;

    if (start > cursor) {
      spans.push({
        start: cursor,
        end: start,
        text: text.slice(cursor, start),
        speaker: null,
      });
    }

    spans.push({ start, end, text: match[0], speaker });
    cursor = end;
  }

  if (cursor < text.length) {
    spans.push({ start: cursor, end: text.length, text: text.slice(cursor), speaker: null });
  }

  return spans.filter((s) => s.text.trim() !== '');
}

export interface DetectedCharacter {
  name: string;
  lineCount: number;
}

/**
 * Scan a whole document for recurring speakers.
 *
 * Characters attributed only once are dropped: a single attribution is usually
 * a misfire, and a one-line character does not need its own voice.
 */
export function detectCharacters(chapters: Chapter[]): DetectedCharacter[] {
  const counts = new Map<string, number>();

  for (const chapter of chapters) {
    for (const span of segmentDialogue(chapter.text)) {
      if (!span.speaker) continue;
      counts.set(span.speaker, (counts.get(span.speaker) ?? 0) + 1);
    }
  }

  // Merge "Marcus Vane" into "Marcus" when both appear, keeping the longer,
  // more specific label.
  const names = [...counts.keys()].sort((a, b) => b.length - a.length);
  const merged = new Map<string, number>();
  const claimed = new Set<string>();

  for (const name of names) {
    if (claimed.has(name)) continue;
    let total = counts.get(name) ?? 0;
    const firstWord = name.split(' ')[0]!;
    for (const other of names) {
      if (other === name || claimed.has(other)) continue;
      if (other === firstWord || name.startsWith(`${other} `)) {
        total += counts.get(other) ?? 0;
        claimed.add(other);
      }
    }
    merged.set(name, total);
    claimed.add(name);
  }

  return [...merged.entries()]
    .filter(([, count]) => count >= 2)
    .map(([name, lineCount]) => ({ name, lineCount }))
    .sort((a, b) => b.lineCount - a.lineCount)
    .slice(0, 40);
}
