import { renderToStaticMarkup } from 'react-dom/server';
import { ReaderView } from '../src/ui/components/ReaderView';
import { planChunks, DEFAULT_CHUNK_OPTIONS } from '../src/lib/chunker';
import { detectChapters } from '../src/lib/chapters';
import { cleanText } from '../src/lib/textProcess';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else { console.log(`FAIL ${name} ${extra}`); failures++; }
};

const SAMPLE = `Chapter One

The harbour bell rang twice before the fog lifted. Marcus stood at the rail.

"We should go now," said Marcus. Elena shook her head.

"Not yet," Elena replied. "The tide is wrong."

He did know it. He had known it since morning.`;

const chapters = detectChapters(cleanText(SAMPLE), 'Book');
const chunks = planChunks(chapters, DEFAULT_CHUNK_OPTIONS);
const chapter = chapters[0]!;
const chunk = chunks[0]!;

const render = (offset: number, mode: 'sentence' | 'word' | 'paragraph' | 'none') =>
  renderToStaticMarkup(
    <ReaderView
      chapter={chapter}
      chunks={chunks}
      activeChunk={chunk}
      charOffset={offset}
      mode={mode}
      autoScroll={false}
      onSeekToChunk={() => {}}
    />
  );

const countMarks = (html: string) => (html.match(/<mark>/g) ?? []).length;
const countActive = (html: string) => (html.match(/chunk-active/g) ?? []).length;

// The chunk spans the whole chapter here, so this is exactly the regression case.
check('chunk spans multiple blocks (precondition)', chunk.charEnd - chunk.charStart > 100);

for (const offset of [0, 40, 90, 140, 200]) {
  const html = render(offset, 'sentence');
  check(`offset ${offset}: exactly one sentence marked`, countMarks(html) === 1, `marks=${countMarks(html)}`);
  check(`offset ${offset}: exactly one block active`, countActive(html) === 1, `active=${countActive(html)}`);
}

// The marked sentence should move forward as playback progresses.
const first = render(0, 'sentence');
const later = render(200, 'sentence');
const markText = (h: string) => /<mark>(.*?)<\/mark>/s.exec(h)?.[1] ?? '';
check('highlight advances with playback', markText(first) !== markText(later),
  `${markText(first).slice(0,30)} vs ${markText(later).slice(0,30)}`);
check('first highlight is the opening sentence', markText(first).includes('harbour bell'), markText(first));

// Word mode marks a single word.
const wordHtml = render(40, 'word');
check('word mode marks one word', countMarks(wordHtml) === 1);
check('word mark has no spaces', !markText(wordHtml).trim().includes(' '), markText(wordHtml));

// Paragraph mode highlights a block but adds no <mark>.
const paraHtml = render(40, 'paragraph');
check('paragraph mode: one active block, no marks',
  countActive(paraHtml) === 1 && countMarks(paraHtml) === 0);

// Off means off.
const offHtml = render(40, 'none');
check('none mode: nothing highlighted', countActive(offHtml) === 0 && countMarks(offHtml) === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
