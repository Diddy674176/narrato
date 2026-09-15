import { useEffect, useMemo, useRef } from 'react';
import type { Chapter, HighlightMode, TextChunk } from '../../types';
import { splitSentences } from '../../lib/textProcess';

/**
 * Reading view with live highlighting.
 *
 * Kokoro does not emit word timings, so the position within a chunk is
 * interpolated from elapsed time (see engine.handleTimeUpdate). That is
 * reliable at sentence granularity and approximate at word granularity, which
 * is why "Sentence" is the default highlight mode. Device TTS *does* report
 * real word boundaries, so word highlighting is exact there.
 */

interface Block {
  text: string;
  start: number;
  end: number;
  heading: boolean;
}

/** Split a chapter into renderable blocks, keeping offsets into the source. */
function blocksWithOffsets(text: string): Block[] {
  const blocks: Block[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      const lead = line.length - line.trimStart().length;
      const start = offset + lead;
      blocks.push({
        text: trimmed,
        start,
        end: start + trimmed.length,
        // Short, unpunctuated lines read as headings in the reader.
        heading: trimmed.length < 90 && !/[.!?,;:]$/.test(trimmed),
      });
    }
    offset += line.length + 1;
  }
  return blocks;
}

/** Render a block, marking the sentence or word currently being spoken. */
function ActiveBlock({
  block,
  localPos,
  mode,
}: {
  block: Block;
  localPos: number;
  mode: HighlightMode;
}): React.JSX.Element {
  if (mode === 'paragraph' || mode === 'none') return <>{block.text}</>;

  if (mode === 'word') {
    // Expand from the estimated position to the surrounding word.
    const clamped = Math.max(0, Math.min(localPos, block.text.length - 1));
    let start = clamped;
    let end = clamped;
    while (start > 0 && /\S/.test(block.text[start - 1] ?? '')) start--;
    while (end < block.text.length && /\S/.test(block.text[end] ?? '')) end++;
    if (start >= end) return <>{block.text}</>;
    return (
      <>
        {block.text.slice(0, start)}
        <mark>{block.text.slice(start, end)}</mark>
        {block.text.slice(end)}
      </>
    );
  }

  // Sentence mode: find the sentence containing the estimated position.
  let cursor = 0;
  for (const sentence of splitSentences(block.text)) {
    const idx = block.text.indexOf(sentence, cursor);
    if (idx === -1) continue;
    const end = idx + sentence.length;
    if (localPos < end) {
      return (
        <>
          {block.text.slice(0, idx)}
          <mark>{block.text.slice(idx, end)}</mark>
          {block.text.slice(end)}
        </>
      );
    }
    cursor = end;
  }
  return <>{block.text}</>;
}

export function ReaderView({
  chapter,
  chunks,
  activeChunk,
  charOffset,
  mode,
  autoScroll,
  onSeekToChunk,
}: {
  chapter: Chapter;
  chunks: TextChunk[];
  activeChunk: TextChunk | null;
  charOffset: number;
  mode: HighlightMode;
  autoScroll: boolean;
  onSeekToChunk: (index: number) => void;
}): React.JSX.Element {
  const blocks = useMemo(() => blocksWithOffsets(chapter.text), [chapter.text]);
  const activeRef = useRef<HTMLParagraphElement | null>(null);

  /**
   * Absolute position currently being spoken, within the chapter.
   *
   * A chunk usually spans several paragraphs, so "the active block" is the one
   * holding this position - not every block the chunk touches. Highlighting all
   * of them at once lights up half the screen and marks a sentence in each.
   */
  const spokenAt =
    activeChunk !== null && activeChunk.chapterIndex === chapter.index
      ? Math.min(activeChunk.charStart + charOffset, Math.max(activeChunk.charStart, activeChunk.charEnd - 1))
      : -1;

  const activeStart = useMemo(() => {
    if (activeChunk === null || activeChunk.chapterIndex !== chapter.index) return null;
    const overlapping = blocks.filter(
      (b) => b.start < activeChunk.charEnd && b.end > activeChunk.charStart
    );
    if (overlapping.length === 0) return null;
    const holding = overlapping.find((b) => spokenAt >= b.start && spokenAt < b.end);
    return (holding ?? overlapping[0]!).start;
  }, [blocks, activeChunk, spokenAt, chapter.index]);

  const isActive = (block: Block): boolean => activeStart === block.start;

  // Keep the spoken text on screen without fighting a user who is scrolling
  // elsewhere: we only scroll when the active block actually changes.
  useEffect(() => {
    if (!autoScroll || !activeRef.current) return;
    activeRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeChunk?.index, autoScroll]);

  /** Start playback from the tapped block. */
  const seekToBlock = (block: Block) => {
    const inChapter = chunks.filter((c) => c.chapterIndex === chapter.index);
    const hit =
      inChapter.find((c) => c.charStart <= block.start && c.charEnd > block.start) ??
      inChapter.find((c) => c.charStart >= block.start);
    if (hit) onSeekToChunk(hit.index);
  };

  return (
    <div className="reader">
      {blocks.map((block) => {
        const active = isActive(block);
        const localPos = active
          ? Math.max(0, Math.min(spokenAt - block.start, block.text.length))
          : 0;

        const content = active ? (
          <ActiveBlock block={block} localPos={localPos} mode={mode} />
        ) : (
          block.text
        );

        if (block.heading) {
          return (
            <h3
              key={block.start}
              onClick={() => seekToBlock(block)}
              style={{ cursor: 'pointer' }}
              className={active && mode !== 'none' ? 'chunk-active' : undefined}
            >
              {content}
            </h3>
          );
        }

        return (
          <p
            key={block.start}
            ref={active ? activeRef : undefined}
            className={active && mode !== 'none' ? 'chunk-active' : undefined}
            onClick={() => seekToBlock(block)}
            title="Start reading from here"
          >
            {content}
          </p>
        );
      })}
    </div>
  );
}
