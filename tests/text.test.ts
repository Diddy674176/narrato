import { cleanText, cleanPages, splitSentences, countWords } from '../src/lib/textProcess';
import { detectChapters } from '../src/lib/chapters';
import { planChunks, DEFAULT_CHUNK_OPTIONS } from '../src/lib/chunker';
import { segmentDialogue, detectCharacters } from '../src/lib/dialogue';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); fails++; }
  else console.log(`ok   ${name}`);
};

// --- dehyphenation + wrap joining (the PDF case) ---
eq('dehyphenate', cleanText('He walked care-\nfully across.'), 'He walked carefully across.');
eq('keep compound', cleanText('An Anglo-\nSaxon word.'), 'An Anglo-Saxon word.');
eq('join wrapped', cleanText('The ship sailed\nquietly out to sea.'), 'The ship sailed quietly out to sea.');
eq('keep paragraphs', cleanText('One.\n\nTwo.'), 'One.\n\nTwo.');
eq('drop page num', cleanText('End of it.\n\n42\n\nNew para.'), 'End of it.\n\nNew para.');
eq('dupe lines', cleanText('Same\nSame\nOther'), 'Same\nOther');

// --- running headers across pages ---
const pages = Array.from({length:6},(_,i)=>`THE LONG WINTER\nBody text of page ${i+1} which is quite long indeed.\n${i+1}`);
const joined = cleanPages(pages);
eq('header removed', joined.includes('THE LONG WINTER'), false);
eq('body kept', joined.includes('Body text of page 3'), true);

// --- sentence splitting ---
eq('abbrev', splitSentences('Dr. Vance said hello. Then he left.'), ['Dr. Vance said hello.','Then he left.']);
eq('decimal', splitSentences('It cost 3.14 dollars. Cheap.'), ['It cost 3.14 dollars.','Cheap.']);
eq('initials', splitSentences('J. R. R. Tolkien wrote it. He did.'), ['J. R. R. Tolkien wrote it.','He did.']);
eq('quotes', splitSentences('"Run!" she cried. He ran.'), ['"Run!" she cried.','He ran.']);
eq('ellipsis', splitSentences('Well... I suppose so. Yes.'), ['Well... I suppose so.','Yes.']);

// --- chapters ---
const book = `Chapter One\n\n${'Body sentence here. '.repeat(20)}\n\nChapter Two\n\n${'More body text here. '.repeat(20)}`;
const chs = detectChapters(cleanText(book), 'Book');
eq('chapter count', chs.length, 2);
eq('chapter titles', chs.map(c=>c.title), ['Chapter One','Chapter Two']);

// no headings, short -> single chapter
eq('single chapter', detectChapters('Just a short note about things.', 'T').length, 1);

// --- chunking ---
const chapters = detectChapters(cleanText(`Chapter One\n\n${'The quick brown fox jumped over the lazy dog. '.repeat(120)}`), 'B');
const chunks = planChunks(chapters, DEFAULT_CHUNK_OPTIONS);
eq('chunks produced', chunks.length > 3, true);
eq('chunk sizes sane', chunks.every(c=>c.text.length<=DEFAULT_CHUNK_OPTIONS.maxChars+200), true);
eq('offsets valid', chunks.every(c=>{
  const src = chapters[c.chapterIndex]!.text.slice(c.charStart,c.charEnd);
  return src === c.displayText;
}), true);
eq('indices contiguous', chunks.every((c,i)=>c.index===i), true);

// --- dialogue ---
const prose = `"We should go now," said Marcus. Elena shook her head.\n\n"Not yet," Elena replied. "The tide is wrong."\n\n"Fine," said Marcus. Elena smiled at that.\n\n"We wait for dawn," Elena said.`;
const spans = segmentDialogue(prose);
const speakers = spans.filter(s=>s.speaker).map(s=>s.speaker);
eq('speakers found', speakers.includes('Marcus') && speakers.includes('Elena'), true);
const chars = detectCharacters([{index:0,title:'t',text:prose}]);
eq('characters recurring', chars.map(c=>c.name).sort(), ['Elena','Marcus']);
eq('unattributed is narration', segmentDialogue('"Hello there," someone whispered.').every(s=>s.speaker===null), true);

console.log(fails===0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails===0?0:1);
