/**
 * Engine behaviour tests.
 *
 * The db and Kokoro client are stubbed (see stubs/), and a fake <audio>
 * element lets us drive playback deterministically.
 */

// ---- DOM stubs, installed before the engine module is imported ----
let objectUrlSeq = 0;
const revoked: string[] = [];
(globalThis as Record<string, unknown>).URL = Object.assign(URL, {
  createObjectURL: () => `blob:fake/${++objectUrlSeq}`,
  revokeObjectURL: (u: string) => revoked.push(u),
});

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = '';
  currentTime = 0;
  duration = 0;
  paused = true;
  volume = 1;
  muted = false;
  playbackRate = 1;
  preservesPitch = true;
  preload = '';
  private listeners: Record<string, Array<() => void>> = {};

  constructor() {
    FakeAudio.instances.push(this);
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(): void {}
  setAttribute(): void {}
  removeAttribute(): void {
    this.src = '';
  }
  load(): void {}
  emit(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  async play(): Promise<void> {
    this.paused = false;
    this.emit('playing');
  }
  pause(): void {
    this.paused = true;
  }
}
(globalThis as Record<string, unknown>).Audio = FakeAudio;
(globalThis as Record<string, unknown>).window = { speechSynthesis: undefined };

import type { Chapter, DocMeta, TextChunk, VoicePreset } from '../src/types';
import { AudiobookEngine } from '../src/lib/player/engine';
import { calls, requested, setFailNext } from './stubs/kokoro-client';
import { store as audioStore, stats as dbStats } from './stubs/db';

let failures = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    failures++;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRESET: VoicePreset = {
  id: 'k_test', label: 'Test', engine: 'kokoro', kokoroVoice: 'af_heart',
  gender: 'female', accent: 'american', description: '', rateBias: 1, pitch: 1, tags: [],
};

const CHUNK_COUNT = 24;
/** Each chunk is ~450 chars => ~30s of audio under the stub's 15 chars/sec. */
function makeChunks(): TextChunk[] {
  return Array.from({ length: CHUNK_COUNT }, (_, i) => {
    const text = `__IDX${i}__ ` + 'word '.repeat(88);
    return {
      id: `c${i}`, index: i, chapterIndex: i < 12 ? 0 : 1,
      text, displayText: text, charStart: 0, charEnd: text.length,
      speaker: null, estSeconds: text.length / 15,
    };
  });
}

const DOC: DocMeta = {
  id: 'doc1', title: 'Test Book', author: null, source: 'paste', sourceRef: null,
  createdAt: 0, updatedAt: 0, wordCount: 100, charCount: 1000, chapterCount: 2,
  estSeconds: 700, favorite: false, finished: false, coverEmoji: 'B',
  description: null, language: 'en',
};
const CHAPTERS: Chapter[] = [
  { index: 0, title: 'One', text: 'x' },
  { index: 1, title: 'Two', text: 'y' },
];

async function boot(rate = 1) {
  const engine = new AudiobookEngine();
  engine.configure({
    preset: PRESET, mode: 'kokoro', rate, volume: 1,
    startupMode: 'balanced', skipSeconds: 15, deviceVoiceURI: null,
  });
  const chunks = makeChunks();
  await engine.load({
    doc: DOC, chapters: CHAPTERS, chunks,
    chapterStarts: [0, 12], startChunk: 0, startOffset: 0,
  });
  return { engine, chunks };
}

/** Current audio element is the most recently created non-preloader one. */
function currentEl(): FakeAudio {
  return FakeAudio.instances[FakeAudio.instances.length - 2]!;
}

// ------------------------------------------------------------------
console.log('--- prebuffer before first play ---');
{
  requested.length = 0;
  const { engine } = await boot();
  const playPromise = engine.play();
  await sleep(600);
  await playPromise;

  const snap = engine.snapshot();
  check('playing after prebuffer', snap.status === 'playing', `status=${snap.status}`);
  check(
    'buffered at least the balanced prebuffer target (32s)',
    snap.bufferedSec >= 32,
    `buffered=${snap.bufferedSec.toFixed(1)}s`,
  );
  check(
    'generated several chunks before starting, not just one',
    requested.length >= 2,
    `generated=${requested.length}`,
  );
  check(
    'generation is sequential from the playhead',
    requested.every((v, i) => v === i),
    `order=${requested.join(',')}`,
  );
  engine.destroy();
}

// ------------------------------------------------------------------
console.log('\n--- advancing and buffer maintenance ---');
{
  requested.length = 0;
  const { engine } = await boot();
  await engine.play();
  await sleep(600);

  const el = currentEl();
  const before = engine.snapshot().chunkIndex;
  el.emit('ended');
  await sleep(300);
  check('advances on ended', engine.snapshot().chunkIndex === before + 1);

  el.emit('ended');
  await sleep(400);
  check('advances again', engine.snapshot().chunkIndex === before + 2);

  const snap = engine.snapshot();
  check(
    'buffer stays ahead while playing',
    snap.bufferedSec >= 30,
    `buffered=${snap.bufferedSec.toFixed(1)}s`,
  );
  check(
    'stops running far ahead once satisfied',
    requested.length <= 9,
    `generated=${requested.length}`,
  );
  engine.destroy();
}

// ------------------------------------------------------------------
console.log('\n--- rate scales the buffer target ---');
{
  const { engine: slow } = await boot(1);
  const slowTarget = slow.snapshot().bufferTargetSec;
  slow.destroy();

  const { engine: fast } = await boot(2);
  const fastTarget = fast.snapshot().bufferTargetSec;
  fast.destroy();

  check(
    '2x playback doubles the buffer target',
    Math.abs(fastTarget - slowTarget * 2) < 0.01,
    `1x=${slowTarget} 2x=${fastTarget}`,
  );
}

// ------------------------------------------------------------------
console.log('\n--- cache reuse ---');
{
  const { engine } = await boot();
  await engine.play();
  await sleep(700);
  const generatedFirstPass = calls.length;
  check('audio written to cache', audioStore.size > 0, `entries=${audioStore.size}`);
  engine.destroy();

  // Fresh engine, same document and voice: nothing should be regenerated.
  calls.length = 0;
  dbStats.reads = 0;
  const { engine: second } = await boot();
  await second.play();
  await sleep(700);
  check(
    'cached chunks are not regenerated',
    calls.length === 0,
    `regenerated=${calls.length} (first pass generated ${generatedFirstPass})`,
  );
  check('cache was actually read', dbStats.reads > 0);
  second.destroy();
}

// ------------------------------------------------------------------
console.log('\n--- memory is bounded over a long listen ---');
{
  const { engine } = await boot();
  await engine.play();
  await sleep(500);
  const el = currentEl();
  for (let i = 0; i < 15; i++) {
    el.emit('ended');
    await sleep(60);
  }
  const snap = engine.snapshot();
  check(
    'ready set stays bounded',
    snap.readyCount <= 12,
    `readyCount=${snap.readyCount}`,
  );
  check('object URLs were revoked', revoked.length > 0, `revoked=${revoked.length}`);
  engine.destroy();
}

// ------------------------------------------------------------------
console.log('\n--- failure handling ---');
{
  calls.length = 0;
  audioStore.clear();
  const { engine } = await boot();
  setFailNext(1); // first attempt fails, retry should succeed
  await engine.play();
  await sleep(700);
  const snap = engine.snapshot();
  check(
    'one retry recovers from a transient failure',
    snap.status === 'playing',
    `status=${snap.status} error=${snap.error}`,
  );
  engine.destroy();
}

// ------------------------------------------------------------------
console.log('\n--- seeking ---');
{
  audioStore.clear();
  const { engine } = await boot();
  await engine.goToChapter(1);
  await sleep(400);
  check('chapter jump lands on chapter start', engine.snapshot().chunkIndex === 12);
  check('chapter index updated', engine.snapshot().chapterIndex === 1);

  await engine.goToChunk(3);
  await sleep(300);
  check('goToChunk moves the playhead', engine.snapshot().chunkIndex === 3);
  engine.destroy();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
