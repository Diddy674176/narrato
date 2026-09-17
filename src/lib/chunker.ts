import type { Chapter, TextChunk } from '../types';
import { splitSentences, estimateSeconds } from './textProcess';
import { segmentDialogue } from './dialogue';

/**
 * Chunk planning.
 *
 * A chunk is one call to the voice model. Size is the central tuning knob for
 * perceived quality:
 *
 *  - Too small (one sentence) and we pay model overhead constantly, playback
 *    stutters between clips, and prosody resets every few words.
 *  - Too large and the first audio takes far too long to arrive, and a single
 *    failure costs a lot of work.
 *
 * ~700 characters lands around 25-45 seconds of speech, which keeps transitions
 * infrequent while still letting playback start quickly.
 */
export interface ChunkOptions {
  targetChars: number;
  maxChars: number;
  minChars: number;
  /**
   * When true, chunks are cut at dialogue boundaries so a chunk is either
   * narration or a single character's speech - required for character voices.
   */
  splitDialogue: boolean;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 700,
  maxChars: 1100,
  minChars: 180,
  splitDialogue: false,
};

/** Chunk sizing adapted to measured device speed (see the benchmark in the worker). */
export function chunkOptionsForSpeed(rtf: number | null, splitDialogue: boolean): ChunkOptions {
  // rtf = seconds of audio produced per second of compute.
  if (rtf === null) return { ...DEFAULT_CHUNK_OPTIONS, splitDialogue };
  if (rtf >= 6) return { targetChars: 950, maxChars: 1400, minChars: 220, splitDialogue };
  if (rtf >= 2.5) return { targetChars: 700, maxChars: 1100, minChars: 180, splitDialogue };
  // Slow device: smaller chunks so the first audio arrives sooner and the
  // buffer refills in finer increments.
  return { targetChars: 420, maxChars: 700, minChars: 120, splitDialogue };
}

interface Piece {
  text: string;
  start: number;
  end: number;
}

/**
 * Locate each sentence inside its source text so the reader can highlight the
 * exact range being spoken. Sentences come back trimmed, so we search forward
 * from a cursor rather than assuming contiguous offsets.
 */
function sentencesWithOffsets(text: string, base: number): Piece[] {
  const out: Piece[] = [];
  let cursor = 0;
  for (const sentence of splitSentences(text)) {
    const idx = text.indexOf(sentence, cursor);
    if (idx === -1) continue;
    out.push({ text: sentence, start: base + idx, end: base + idx + sentence.length });
    cursor = idx + sentence.length;
  }
  return out;
}

/**
 * Break a sentence that is longer than maxChars. We cut at clause punctuation
 * first and only fall back to a hard word-boundary cut if a single clause is
 * still enormous (tables and OCR runs can produce these).
 */
function splitOversized(piece: Piece, maxChars: number): Piece[] {
  if (piece.text.length <= maxChars) return [piece];

  const out: Piece[] = [];
  let buffer = '';
  let bufferStart = piece.start;

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed !== '') {
      const lead = buffer.length - buffer.trimStart().length;
      out.push({
        text: trimmed,
        start: bufferStart + lead,
        end: bufferStart + lead + trimmed.length,
      });
    }
    bufferStart += buffer.length;
    buffer = '';
  };

  // Split on clause punctuation, keeping the delimiter attached.
  const parts = piece.text.split(/(?<=[,;:—])\s+/);
  for (const part of parts) {
    if (buffer !== '' && buffer.length + part.length + 1 > maxChars) flush();

    if (part.length > maxChars) {
      // Still too long: cut on word boundaries.
      const words = part.split(/(\s+)/);
      for (const w of words) {
        if (buffer.length + w.length > maxChars && buffer.trim() !== '') flush();
        buffer += w;
      }
      continue;
    }
    buffer += (buffer === '' ? '' : ' ') + part;
  }
  flush();

  return out.length > 0 ? out : [piece];
}

/**
 * Turn chapters into the flat, globally indexed chunk list the player works on.
 */
export function planChunks(chapters: Chapter[], opts: ChunkOptions): TextChunk[] {
  const chunks: TextChunk[] = [];

  for (const chapter of chapters) {
    const segments = opts.splitDialogue
      ? segmentDialogue(chapter.text).map((s) => ({
          text: s.text,
          base: s.start,
          speaker: s.speaker,
        }))
      : [{ text: chapter.text, base: 0, speaker: null as string | null }];

    for (const segment of segments) {
      const pieces = sentencesWithOffsets(segment.text, segment.base).flatMap((p) =>
        splitOversized(p, opts.maxChars)
      );

      let buffer: Piece[] = [];
      let size = 0;

      const flush = () => {
        if (buffer.length === 0) return;
        const first = buffer[0]!;
        const last = buffer[buffer.length - 1]!;
        const display = chapter.text.slice(first.start, last.end);
        chunks.push({
          id: `c${chunks.length}`,
          index: chunks.length,
          chapterIndex: chapter.index,
          text: display,
          displayText: display,
          charStart: first.start,
          charEnd: last.end,
          speaker: segment.speaker,
          estSeconds: estimateSeconds(display),
        });
        buffer = [];
        size = 0;
      };

      for (const piece of pieces) {
        buffer.push(piece);
        size += piece.text.length + 1;

        if (size >= opts.targetChars) {
          flush();
          continue;
        }

        // Prefer ending a chunk at a paragraph break once we have enough text:
        // it gives the listener a natural pause exactly where the author put one.
        const nextChar = chapter.text.slice(piece.end, piece.end + 2);
        if (size >= opts.minChars && nextChar.includes('\n')) flush();
      }

      flush();
    }
  }

  return chunks;
}

/** Index of the first chunk of each chapter, for chapter navigation. */
export function chapterStartChunks(chunks: TextChunk[], chapterCount: number): number[] {
  const starts: number[] = Array.from({ length: chapterCount }, () => 0);
  const seen = new Set<number>();
  for (const chunk of chunks) {
    if (!seen.has(chunk.chapterIndex)) {
      seen.add(chunk.chapterIndex);
      starts[chunk.chapterIndex] = chunk.index;
    }
  }
  // Chapters that produced no chunks inherit the next chapter's start.
  for (let i = chapterCount - 2; i >= 0; i--) {
    if (!seen.has(i)) starts[i] = starts[i + 1]!;
  }
  return starts;
}
