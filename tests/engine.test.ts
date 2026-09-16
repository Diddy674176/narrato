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
import { calls, requested, setFailNext, setDelayMs, setRtf } from './stubs/kokoro-client';
import {
  store as audioStore,
  stats as dbStats,
  setQuotaFull,
  setOverBudget,
} from './stubs/db';

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

// ------------------------------------------------------------------
console.log('\n--- bulk preparation ---');
{
  audioStore.clear();
  calls.length = 0;
  const { engine } = await boot();

  const before = await engine.cachedCount('chapter');
  check('nothing cached to begin with', before.cached === 0 && before.total === 12,
    JSON.stringify(before));

  const seen: number[] = [];
  const result = await engine.prepareRange('chapter', (done) => seen.push(done), () => false);
  check('prepared the whole chapter', result.done === 12 && result.total === 12,
    JSON.stringify(result));
  check('no failures', result.failed === 0);
  check('progress reported for each section', seen.length === 12, `ticks=${seen.length}`);

  const after = await engine.cachedCount('chapter');
  check('chapter now fully cached', after.cached === 12, JSON.stringify(after));

  // A second run must be a no-op against the cache, not a regeneration.
  calls.length = 0;
  await engine.prepareRange('chapter', () => {}, () => false);
  check('re-preparing regenerates nothing', calls.length === 0, `regenerated=${calls.length}`);

  // Whole-document scope covers both chapters.
  const book = await engine.cachedCount('book');
  check('book scope spans every chunk', book.total === CHUNK_COUNT, JSON.stringify(book));

  engine.destroy();
}

console.log('\n--- preparation can be cancelled ---');
{
  audioStore.clear();
  const { engine } = await boot();
  let ticks = 0;
  const res = await engine.prepareRange('book', () => { ticks++; }, () => ticks >= 3);
  check('stops promptly when cancelled', res.done <= 4, `done=${res.done}`);
  check('work done before cancelling is kept', audioStore.size > 0, `cached=${audioStore.size}`);
  engine.destroy();
}

// ------------------------------------------------------------------
// The headline requirement: it must not stop mid-book. We simulate playback
// in accelerated time - each chunk is ~30s of audio "played" in PLAY_MS of
// wall clock - and count how often the player is forced to wait for audio.
console.log('\n--- continuous playback, no stalls ---');
{
  const PLAY_MS = 220;

  const runPlayback = async (genMs: number, transitions: number) => {
    audioStore.clear();
    setDelayMs(genMs);
    const { engine } = await boot();

    let stalls = 0;
    let prev = '';
    const stop = engine.subscribe((s) => {
      if (s.status === 'buffering' && prev !== 'buffering') stalls++;
      prev = s.status;
    });

    await engine.play();
    const el = currentEl();
    const startStalls = stalls; // ignore the deliberate pre-play buffering

    for (let i = 0; i < transitions; i++) {
      await sleep(PLAY_MS);
      el.emit('ended');
      await sleep(20);
    }

    const snap = engine.snapshot();
    stop();
    engine.destroy();
    setDelayMs(1);
    return { stalls: stalls - startStalls, snap };
  };

  // A device that generates faster than it plays: zero interruptions.
  const fast = await runPlayback(25, 10);
  check('fast device: never stops during playback', fast.stalls === 0, `stalls=${fast.stalls}`);
  check('fast device: advanced through the chunks', fast.snap.chunkIndex >= 10,
    `index=${fast.snap.chunkIndex}`);
  check('fast device: still playing at the end', fast.snap.status === 'playing',
    `status=${fast.snap.status}`);

  // A device slower than real time. Stalls are unavoidable eventually, but the
  // prebuffer must absorb the first stretch and recovery must be automatic.
  const slow = await runPlayback(700, 6);
  check('slow device: prebuffer absorbs the opening chunks', slow.stalls <= 3,
    `stalls=${slow.stalls}`);
  check('slow device: recovers on its own, no user action', slow.snap.status !== 'error',
    `status=${slow.snap.status}`);
  check('slow device: still advancing through the book', slow.snap.chunkIndex >= 4,
    `index=${slow.snap.chunkIndex}`);
}

console.log('\n--- a stall resumes by itself ---');
{
  audioStore.clear();
  setDelayMs(400);
  const { engine } = await boot();

  await engine.play();
  const el = currentEl();

  // Burn through everything buffered so the next chunk cannot be ready.
  for (let i = 0; i < 12; i++) {
    el.emit('ended');
    await sleep(5);
  }
  const during = engine.snapshot().status;

  // No further input: the engine must pick itself up.
  await sleep(2500);
  const after = engine.snapshot().status;

  check('stalling is surfaced rather than silent', during === 'buffering' || during === 'playing',
    `during=${during}`);
  check('playback resumes without the user pressing play', after === 'playing',
    `after=${after}`);
  setDelayMs(1);
  engine.destroy();
}

// ------------------------------------------------------------------
// A 2-core CI runner measures Kokoro q8 at ~0.99x real time: it can never
// build a buffer while playing, so the only defence is banking more before
// playback starts.
console.log('\n--- adapts to an underpowered device ---');
{
  setRtf(4);
  const { engine: quick } = await boot();
  const fastTarget = quick.snapshot().bufferTargetSec;
  check('a fast device is not flagged as underpowered', !quick.isUnderpowered());
  quick.destroy();

  setRtf(0.99);
  const { engine: slow } = await boot();
  const slowTarget = slow.snapshot().bufferTargetSec;
  check('a sub-real-time device is flagged', slow.isUnderpowered());
  check(
    'an underpowered device banks a bigger buffer',
    slowTarget > fastTarget * 1.5,
    `fast=${fastTarget} slow=${slowTarget}`,
  );
  slow.destroy();

  setRtf(1.6);
  const { engine: mid } = await boot();
  const midTarget = mid.snapshot().bufferTargetSec;
  check('a merely modest device gets a smaller bump', midTarget > fastTarget && midTarget < slowTarget,
    `mid=${midTarget}`);
  check('a modest device is not flagged as underpowered', !mid.isUnderpowered());
  mid.destroy();

  // Device voices are spoken as they play, so none of this applies.
  setRtf(0.5);
  const { engine: dev } = await boot();
  dev.configure({
    preset: PRESET, mode: 'device', rate: 1, volume: 1,
    startupMode: 'balanced', skipSeconds: 15, deviceVoiceURI: null,
  });
  check('device voices are never flagged as underpowered', !dev.isUnderpowered());
  dev.destroy();

  setRtf(4);
}

// ------------------------------------------------------------------
// A six-hour book is roughly a gigabyte of audio, so running out of room is a
// realistic outcome - and silently failing to save would make "prepared for
// offline" a lie.
console.log('\n--- storage exhaustion is surfaced, not swallowed ---');
{
  audioStore.clear();
  const { engine } = await boot();
  check('storage is not flagged to begin with', engine.snapshot().storageFull === false);

  setQuotaFull(true);
  await engine.play();
  await sleep(700);

  check(
    'a full disk is reported to the user',
    engine.snapshot().storageFull === true,
    `storageFull=${engine.snapshot().storageFull}`,
  );
  check(
    'playback still works when audio cannot be saved',
    engine.snapshot().status === 'playing',
    `status=${engine.snapshot().status}`,
  );
  check('nothing was written', audioStore.size === 0, `entries=${audioStore.size}`);

  // Recovering space should clear the warning without a reload.
  setQuotaFull(false);
  await engine.goToChunk(2);
  await sleep(600);
  check('the warning clears once saving succeeds again',
    engine.snapshot().storageFull === false);
  engine.destroy();
}

console.log('\n--- a book too big for the budget is flagged ---');
{
  audioStore.clear();
  setOverBudget(true);
  const { engine } = await boot();
  await engine.play();
  await sleep(700);
  check(
    'exceeding the cache budget is reported',
    engine.snapshot().storageFull === true,
    'a single book can outgrow the budget; the user needs to know',
  );
  setOverBudget(false);
  engine.destroy();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
