import type {
  Chapter,
  DocMeta,
  StartupMode,
  TextChunk,
  VoiceEngineId,
  VoicePreset,
} from '../../types';
import {
  audioKey,
  cacheBudgetBytes,
  enforceCacheBudget,
  getAudio,
  hasAudioKeys,
  isQuotaError,
  putAudio,
} from '../db';
import { hashText } from '../hash';
import { kokoroClient } from '../tts/kokoro/client';
import { MODEL_VERSION } from '../tts/kokoro/protocol';
import { matchSystemVoice } from '../tts/voices';
import { generatePremium } from '../tts/premium';
import {
  clearMediaHandlers,
  setMediaHandlers,
  setMediaMetadata,
  setPlaybackState,
  setPositionState,
} from './mediaSession';

/**
 * The audiobook playback engine.
 *
 * Design notes, because the tricky parts are not obvious:
 *
 * 1. ONE persistent <audio> element. Playback is driven by swapping its `src`
 *    between generated chunks rather than creating an element per chunk. Mobile
 *    browsers tie the media session (and therefore lock-screen controls and
 *    background audio permission) to a specific element that the user gestured
 *    on; recreating it mid-book is the fastest way to lose the notification and
 *    have audio die when the screen locks.
 *
 * 2. Generation is always *ahead* of playback, never in reaction to it. The
 *    pump keeps a rolling target of buffered seconds, scaled by playback rate,
 *    so 2x listening builds twice the buffer.
 *
 * 3. Everything generated is written to IndexedDB immediately, keyed by voice
 *    and text hash. Re-listening or changing voice never destroys prior work.
 */

export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

export interface PlayerSnapshot {
  status: PlayerStatus;
  docId: string | null;
  chunkIndex: number;
  chapterIndex: number;
  /** Seconds into the current chunk. */
  chunkTime: number;
  chunkDuration: number;
  /** Estimated seconds elapsed across the whole document. */
  elapsedSec: number;
  totalSec: number;
  bufferedSec: number;
  bufferTargetSec: number;
  generatingIndex: number | null;
  readyCount: number;
  error: string | null;
  /** Character offset inside the current chunk, for word-level highlighting. */
  charOffset: number;
  sleepTimerEndsAt: number | null;
  /** True when generated audio can no longer be saved for offline use. */
  storageFull: boolean;
}

interface ReadyChunk {
  url: string;
  duration: number;
  bytes: number;
}

const STARTUP_PREBUFFER: Record<StartupMode, number> = {
  fast: 15,
  balanced: 32,
  smooth: 60,
};

const STARTUP_TARGET: Record<StartupMode, number> = {
  fast: 25,
  balanced: 50,
  smooth: 85,
};

/** Keep this many generated chunks in RAM around the playhead. */
const MEM_AHEAD = 8;
const MEM_BEHIND = 1;

/** Stop generating once this multiple of the target is banked. */
const OVERSHOOT = 1.6;


/**
 * A fraction of a second of silence, used to unlock the audio element.
 *
 * Mobile browsers only allow programmatic playback on an element that has
 * already played during a real user gesture. Our first real chunk may take
 * several seconds to generate - long after the gesture has expired - so we
 * play this silent clip synchronously inside the tap instead.
 */
function silentWavUrl(): string {
  const sampleRate = 8000;
  const samples = 400;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

let SILENT_URL: string | null = null;

export class AudiobookEngine {
  private audio: HTMLAudioElement | null = null;
  private preloader: HTMLAudioElement | null = null;

  private doc: DocMeta | null = null;
  private chapters: Chapter[] = [];
  private chunks: TextChunk[] = [];
  private chapterStarts: number[] = [];

  private preset: VoicePreset | null = null;
  private mode: VoiceEngineId = 'kokoro';
  private rate = 1;
  private volume = 1;
  private startupMode: StartupMode = 'balanced';
  private skipSeconds = 15;
  private deviceVoiceURI: string | null = null;
  private cacheBudgetGb = 10;
  /** Documents the user asked to keep offline; never evicted. */
  private keepOffline: ReadonlySet<string> = new Set();
  /** Per-character voice overrides, by speaker name. */
  private characterPresets = new Map<string, VoicePreset>();

  private ready = new Map<number, ReadyChunk>();
  private durations = new Map<number, number>();
  private inflight: number | null = null;
  private pumpScheduled = false;
  private destroyed = false;
  private unlocked = false;
  /** Set when the browser refused to store generated audio. */
  private storageFull = false;

  private chunkIndex = 0;
  private charOffset = 0;
  private status: PlayerStatus = 'idle';
  private error: string | null = null;
  /** True when the user has asked for playback, even while buffering. */
  private wantPlaying = false;

  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepFade: ReturnType<typeof setInterval> | null = null;
  private sleepEndsAt: number | null = null;
  private sleepAtChapterEnd = false;

  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private onPositionSave: ((chunkIndex: number, offsetSec: number) => void) | null = null;
  private lastSavedAt = 0;

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Create the audio element. Must be called from a user gesture the first
   * time so that mobile autoplay policy unlocks this element for the session.
   */
  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;

    const el = new Audio();
    el.preload = 'auto';
    el.volume = this.volume;
    // Keep pitch natural at high speeds; the property is prefixed on Safari.
    el.preservesPitch = true;
    el.setAttribute('x-webkit-airplay', 'allow');

    el.addEventListener('ended', () => this.handleEnded());
    el.addEventListener('timeupdate', () => this.handleTimeUpdate());
    el.addEventListener('error', () => {
      // A decode failure on one chunk should not end the book: drop it and
      // regenerate rather than stalling.
      this.dropChunk(this.chunkIndex);
      this.emit();
      void this.startChunk(this.chunkIndex, 0, this.wantPlaying);
    });
    el.addEventListener('playing', () => {
      if (this.status !== 'playing') {
        this.status = 'playing';
        setPlaybackState('playing');
        this.emit();
      }
    });

    this.audio = el;

    const pre = new Audio();
    pre.preload = 'auto';
    pre.muted = true;
    this.preloader = pre;

    return el;
  }

  subscribe(fn: (s: PlayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  snapshot(): PlayerSnapshot {
    const chunk = this.chunks[this.chunkIndex];
    return {
      status: this.status,
      docId: this.doc?.id ?? null,
      chunkIndex: this.chunkIndex,
      chapterIndex: chunk?.chapterIndex ?? 0,
      chunkTime: this.audio?.currentTime ?? 0,
      chunkDuration: this.currentDuration(),
      elapsedSec: this.elapsedSec(),
      totalSec: this.totalSec(),
      bufferedSec: this.bufferedSec(),
      bufferTargetSec: this.bufferTarget(),
      generatingIndex: this.inflight,
      readyCount: this.ready.size,
      error: this.error,
      charOffset: this.charOffset,
      sleepTimerEndsAt: this.sleepEndsAt,
      storageFull: this.storageFull,
    };
  }

  /* ---------------------------------------------------------------- *
   * Configuration
   * ---------------------------------------------------------------- */

  configure(opts: {
    preset: VoicePreset;
    mode: VoiceEngineId;
    rate: number;
    volume: number;
    startupMode: StartupMode;
    skipSeconds: number;
    deviceVoiceURI: string | null;
    characterPresets?: Map<string, VoicePreset>;
    cacheBudgetGb?: number;
    keepOffline?: ReadonlySet<string>;
  }): void {
    const voiceChanged =
      this.preset?.id !== opts.preset.id || this.mode !== opts.mode;

    this.preset = opts.preset;
    this.mode = opts.mode;
    this.startupMode = opts.startupMode;
    this.skipSeconds = opts.skipSeconds;
    this.deviceVoiceURI = opts.deviceVoiceURI;
    if (opts.characterPresets) this.characterPresets = opts.characterPresets;
    if (opts.cacheBudgetGb !== undefined) this.cacheBudgetGb = opts.cacheBudgetGb;
    if (opts.keepOffline) this.keepOffline = opts.keepOffline;

    this.setRate(opts.rate);
    this.setVolume(opts.volume);

    if (voiceChanged && this.doc) {
      // Cached audio for the old voice is kept; we simply stop using it.
      const wasPlaying = this.wantPlaying;
      this.flushMemory();
      void this.startChunk(this.chunkIndex, 0, wasPlaying);
    }
    this.emit();
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(3, rate));
    if (this.audio) {
      // rateBias is baked into the generated audio (it is Kokoro's own `speed`
      // argument), so applying it again here would resample a second time -
      // audibly warbly at the slower presets.
      this.audio.playbackRate = this.rate;
      this.audio.preservesPitch = true;
    }
    this.schedulePump();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio) this.audio.volume = this.volume;
  }

  setCharacterPresets(map: Map<string, VoicePreset>): void {
    this.characterPresets = map;
  }

  onSavePosition(fn: (chunkIndex: number, offsetSec: number) => void): void {
    this.onPositionSave = fn;
  }

  /* ---------------------------------------------------------------- *
   * Loading a document
   * ---------------------------------------------------------------- */

  async load(opts: {
    doc: DocMeta;
    chapters: Chapter[];
    chunks: TextChunk[];
    chapterStarts: number[];
    startChunk: number;
    startOffset: number;
  }): Promise<void> {
    this.stopInternal();
    this.flushMemory();

    this.doc = opts.doc;
    this.chapters = opts.chapters;
    this.chunks = opts.chunks;
    this.chapterStarts = opts.chapterStarts;
    this.chunkIndex = Math.max(0, Math.min(opts.startChunk, opts.chunks.length - 1));
    this.charOffset = 0;
    this.error = null;
    this.status = 'idle';

    for (const chunk of this.chunks) this.durations.set(chunk.index, chunk.estSeconds);

    this.updateMetadata();
    this.emit();

    // Warm the buffer so pressing Play is instant even before the first tap.
    this.schedulePump();

    if (opts.startOffset > 0) {
      // Restore mid-chunk position without starting playback.
      await this.startChunk(this.chunkIndex, opts.startOffset, false);
    }
  }

  private updateMetadata(): void {
    if (!this.doc) return;
    const chapter = this.chapters[this.currentChapterIndex()];
    setMediaMetadata({
      title: this.doc.title,
      chapter: chapter?.title ?? this.doc.title,
      author: this.doc.author,
    });
    setMediaHandlers({
      play: () => void this.play(),
      pause: () => this.pause(),
      stop: () => this.stop(),
      seekBackward: () => void this.skip(-this.skipSeconds),
      seekForward: () => void this.skip(this.skipSeconds),
      previousTrack: () => void this.previousChapter(),
      nextTrack: () => void this.nextChapter(),
    });
  }

  /* ---------------------------------------------------------------- *
   * Transport
   * ---------------------------------------------------------------- */

  async play(): Promise<void> {
    if (!this.doc || this.chunks.length === 0) return;
    this.wantPlaying = true;
    this.error = null;

    if (this.mode === 'device') {
      this.status = 'playing';
      setPlaybackState('playing');
      this.emit();
      this.speakDevice(this.chunkIndex);
      return;
    }

    const el = this.ensureAudio();
    const resumeAt = el.src && el.src !== SILENT_URL ? el.currentTime : 0;

    // Must happen inside the tap, before any await that could outlive it.
    await this.unlock();

    // Build a real buffer before the first note rather than starting on a
    // single chunk and stalling three sentences later.
    if (!this.ready.has(this.chunkIndex) || this.bufferedSec() < this.prebufferTarget()) {
      this.status = 'buffering';
      setPlaybackState('playing');
      this.emit();
      this.schedulePump();
      try {
        await this.ensureChunk(this.chunkIndex);
      } catch {
        // startChunk reports the failure; stop here so we do not play silence.
        return;
      }
      await this.waitForPrebuffer();
    }

    if (!this.wantPlaying) return;
    await this.startChunk(this.chunkIndex, resumeAt, true);
  }

  /**
   * Play a silent clip so this element is permanently unlocked for
   * programmatic playback on iOS and Android.
   */
  private async unlock(): Promise<void> {
    if (this.unlocked) return;
    const el = this.ensureAudio();
    if (!SILENT_URL) SILENT_URL = silentWavUrl();
    try {
      el.src = SILENT_URL;
      el.muted = true;
      await el.play();
      el.pause();
      this.unlocked = true;
    } catch {
      /* Blocked; the real play() below will surface it to the user. */
    } finally {
      el.muted = false;
    }
  }

  /**
   * Wait until enough audio is banked to start comfortably.
   *
   * Capped in wall-clock time: on a slow device, insisting on a full buffer
   * could mean a minute of silence, which is worse than an occasional stall.
   */
  private async waitForPrebuffer(): Promise<void> {
    const target = this.prebufferTarget();
    const deadline = Date.now() + this.prebufferWaitMs();

    while (!this.destroyed && this.wantPlaying) {
      if (this.bufferedSec() >= target) return;
      // Nothing left to generate: the rest of the book is already banked.
      const remaining = this.chunks.length - this.chunkIndex;
      if (remaining <= 1 && this.ready.has(this.chunkIndex)) return;
      if (Date.now() > deadline) return;
      this.schedulePump();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  pause(): void {
    this.wantPlaying = false;
    if (this.mode === 'device') {
      window.speechSynthesis?.pause();
    } else {
      this.audio?.pause();
    }
    this.status = 'paused';
    setPlaybackState('paused');
    this.savePosition(true);
    this.emit();
  }

  toggle(): void {
    if (this.status === 'playing' || this.status === 'buffering') this.pause();
    else void this.play();
  }

  stop(): void {
    this.stopInternal();
    this.status = 'idle';
    setPlaybackState('none');
    this.emit();
  }

  private stopInternal(): void {
    this.wantPlaying = false;
    this.clearSleepTimer();
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    window.speechSynthesis?.cancel();
  }

  /** Jump by seconds, crossing chunk boundaries as needed. */
  async skip(seconds: number): Promise<void> {
    if (this.mode === 'device') {
      // Web Speech gives no seek primitive, so we move whole chunks instead.
      await this.goToChunk(this.chunkIndex + (seconds > 0 ? 1 : -1));
      return;
    }

    const el = this.ensureAudio();
    let remaining = seconds;
    let index = this.chunkIndex;
    let time = el.currentTime + remaining;

    while (time < 0 && index > 0) {
      index -= 1;
      const dur = this.durations.get(index) ?? 0;
      time += dur;
    }
    while (index < this.chunks.length - 1) {
      const dur = this.durations.get(index) ?? 0;
      if (time <= dur) break;
      time -= dur;
      index += 1;
    }

    remaining = Math.max(0, time);
    if (index === this.chunkIndex) {
      el.currentTime = Math.min(remaining, this.currentDuration());
      this.emit();
      return;
    }
    await this.goToChunk(index, remaining);
  }

  /**
   * Seek to an absolute position in the whole document.
   *
   * Durations are exact for chunks already generated and estimated for the
   * rest, so scrubbing far into an ungenerated book lands approximately and
   * then settles as real durations replace estimates.
   */
  async seekToAbsolute(seconds: number): Promise<void> {
    let remaining = Math.max(0, seconds);
    for (let i = 0; i < this.chunks.length; i++) {
      const dur = this.durations.get(i) ?? this.chunks[i]!.estSeconds;
      if (remaining <= dur || i === this.chunks.length - 1) {
        await this.goToChunk(i, Math.min(remaining, dur));
        return;
      }
      remaining -= dur;
    }
  }

  async goToChunk(index: number, offset = 0): Promise<void> {
    const target = Math.max(0, Math.min(index, this.chunks.length - 1));
    if (this.mode === 'device') {
      window.speechSynthesis?.cancel();
      this.chunkIndex = target;
      this.charOffset = 0;
      this.updateMetadata();
      this.emit();
      if (this.wantPlaying) this.speakDevice(target);
      return;
    }

    this.chunkIndex = target;
    this.charOffset = 0;
    this.trimMemory();
    this.updateMetadata();
    await this.startChunk(target, offset, this.wantPlaying);
  }

  async nextChapter(): Promise<void> {
    const next = this.currentChapterIndex() + 1;
    if (next < this.chapterStarts.length) await this.goToChunk(this.chapterStarts[next]!);
  }

  async previousChapter(): Promise<void> {
    const current = this.currentChapterIndex();
    const start = this.chapterStarts[current] ?? 0;
    // Mirror the familiar behaviour: restart the chapter unless we just started it.
    if (this.chunkIndex > start + 1 || current === 0) {
      await this.goToChunk(start);
      return;
    }
    await this.goToChunk(this.chapterStarts[current - 1] ?? 0);
  }

  async goToChapter(index: number): Promise<void> {
    const start = this.chapterStarts[index];
    if (start !== undefined) await this.goToChunk(start);
  }

  /* ---------------------------------------------------------------- *
   * Chunk playback
   * ---------------------------------------------------------------- */

  private async startChunk(index: number, offset: number, autoplay: boolean): Promise<void> {
    if (this.destroyed || !this.doc) return;
    if (index >= this.chunks.length) {
      this.handleFinished();
      return;
    }

    this.chunkIndex = index;
    this.updateMetadata();

    let entry = this.ready.get(index);
    if (!entry) {
      if (autoplay) {
        this.status = 'buffering';
        // Keep the OS notification alive while we generate, otherwise the
        // lock-screen controls disappear during a buffer stall.
        setPlaybackState('playing');
        this.emit();
      }
      this.schedulePump();
      try {
        entry = await this.ensureChunk(index);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.status = 'error';
        this.emit();
        return;
      }
      // The user may have moved on while we were generating.
      if (this.chunkIndex !== index) return;
    }

    const el = this.ensureAudio();
    // See setRate: the preset's rate bias is already in the samples.
    el.playbackRate = this.rate;
    el.preservesPitch = true;
    el.volume = this.volume;

    if (el.src !== entry.url) {
      el.src = entry.url;
      if (offset > 0) {
        await new Promise<void>((resolve) => {
          const onMeta = () => {
            el.removeEventListener('loadedmetadata', onMeta);
            resolve();
          };
          el.addEventListener('loadedmetadata', onMeta);
          // Never hang if metadata never arrives.
          setTimeout(onMeta, 2000);
        });
        try {
          el.currentTime = Math.min(offset, el.duration || offset);
        } catch {
          /* seek unsupported before load; harmless */
        }
      }
    } else if (offset > 0) {
      el.currentTime = offset;
    }

    this.preloadNext();

    if (autoplay) {
      try {
        await el.play();
        this.status = 'playing';
        setPlaybackState('playing');
      } catch (err) {
        // Autoplay blocked: surface it rather than silently doing nothing.
        this.status = 'paused';
        this.wantPlaying = false;
        this.error =
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Tap Play to start audio (your browser blocked automatic playback).'
            : null;
        setPlaybackState('paused');
      }
    }

    this.emit();
    this.schedulePump();
  }

  /** Warm the next chunk in a muted element so its decode is already done. */
  private preloadNext(): void {
    const next = this.ready.get(this.chunkIndex + 1);
    if (next && this.preloader && this.preloader.src !== next.url) {
      this.preloader.src = next.url;
    }
  }

  private handleEnded(): void {
    if (this.sleepAtChapterEnd) {
      const endingChapter = this.currentChapterIndex();
      const nextChunkChapter = this.chunks[this.chunkIndex + 1]?.chapterIndex;
      if (nextChunkChapter !== undefined && nextChunkChapter !== endingChapter) {
        this.sleepAtChapterEnd = false;
        this.beginSleepFade();
        return;
      }
    }

    const next = this.chunkIndex + 1;
    if (next >= this.chunks.length) {
      this.handleFinished();
      return;
    }
    this.trimMemory();
    void this.startChunk(next, 0, this.wantPlaying);
  }

  private handleFinished(): void {
    this.status = 'ended';
    this.wantPlaying = false;
    setPlaybackState('none');
    this.savePosition(true);
    this.emit();
  }

  private handleTimeUpdate(): void {
    const el = this.audio;
    if (!el) return;

    const duration = this.currentDuration();
    if (duration > 0) {
      // Map elapsed time onto a character offset so the reader can highlight
      // the sentence being spoken. Kokoro does not emit word timings, so this
      // is a proportional estimate - accurate enough at sentence granularity.
      const chunk = this.chunks[this.chunkIndex];
      if (chunk) {
        const ratio = Math.max(0, Math.min(1, el.currentTime / duration));
        this.charOffset = Math.floor(ratio * chunk.displayText.length);
      }
      setPositionState(duration, el.currentTime, el.playbackRate);
    }

    this.savePosition(false);
    this.schedulePump();
    this.emit();
  }

  /* ---------------------------------------------------------------- *
   * Generation pump
   * ---------------------------------------------------------------- */

  /**
   * How much extra to bank when the device is slow.
   *
   * Real-time factor is audio-seconds produced per second of compute. Below
   * 1.0 the device cannot generate as fast as it plays, so the buffer can only
   * ever shrink once playback starts - the only defence is to bank more before
   * starting. Measured on a 2-core CI runner, Kokoro q8 sits right at 0.99x,
   * so this is not a hypothetical case.
   */
  private performanceMultiplier(): number {
    if (this.mode === 'device') return 1;
    const rtf = kokoroClient.getStatus().rtf;
    if (rtf === null) return 1;
    if (rtf < 1.2) return 1.8;
    if (rtf < 2) return 1.3;
    return 1;
  }

  private bufferTarget(): number {
    const base = STARTUP_TARGET[this.startupMode];
    // Faster playback drains the buffer proportionally faster.
    return base * this.rate * this.performanceMultiplier();
  }

  private prebufferTarget(): number {
    return STARTUP_PREBUFFER[this.startupMode] * this.rate * this.performanceMultiplier();
  }

  /**
   * How long we are willing to make the user wait before playback starts.
   *
   * This is the user's lever on a slow device: "Smooth" trades a longer wait
   * for a buffer big enough to survive the whole session, "Fast" starts almost
   * immediately and accepts pauses.
   */
  private prebufferWaitMs(): number {
    if (this.startupMode === 'fast') return 12_000;
    if (this.startupMode === 'smooth') return 45_000;
    return 20_000;
  }

  /** True when this device cannot generate as fast as it plays. */
  isUnderpowered(): boolean {
    if (this.mode === 'device') return false;
    const rtf = kokoroClient.getStatus().rtf;
    return rtf !== null && rtf < 1.2;
  }

  /** Contiguous generated audio ahead of the playhead, in real seconds. */
  private bufferedSec(): number {
    // Device TTS speaks utterances directly and has nothing to buffer.
    if (this.mode === 'device') return 0;
    let total = 0;
    const current = this.ready.get(this.chunkIndex);
    if (!current) return 0;
    total += Math.max(0, current.duration - (this.audio?.currentTime ?? 0));

    for (let i = this.chunkIndex + 1; i < this.chunks.length; i++) {
      const entry = this.ready.get(i);
      if (!entry) break;
      total += entry.duration;
    }
    return total;
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.destroyed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  /**
   * Decide whether to generate, and what.
   *
   * Priority is strictly sequential from the playhead: the chunk we are about
   * to need always outranks anything further ahead. Only one generation is in
   * flight at a time - the model is the bottleneck, and queueing several would
   * just delay the one that matters after a seek.
   */
  private async pump(): Promise<void> {
    if (this.destroyed || this.mode === 'device') return;
    if (this.inflight !== null) return;
    if (!this.doc || this.chunks.length === 0) return;

    const buffered = this.bufferedSec();
    const target = this.bufferTarget();

    // Find the first chunk we still need.
    let wanted: number | null = null;
    const limit = Math.min(this.chunks.length, this.chunkIndex + MEM_AHEAD + 1);
    for (let i = this.chunkIndex; i < limit; i++) {
      if (!this.ready.has(i)) {
        wanted = i;
        break;
      }
    }
    if (wanted === null) return;

    // The current chunk is always generated. Beyond that, back off once we are
    // comfortably ahead so we stop burning battery and heating the phone.
    if (wanted > this.chunkIndex && buffered >= target * OVERSHOOT) return;

    try {
      await this.ensureChunk(wanted);
    } catch {
      /* ensureChunk already recorded the error */
    }
    this.schedulePump();
  }

  /** Cache key for a chunk under the currently selected voice. */
  private keyFor(chunk: TextChunk): { key: string; voiceId: string; preset: VoicePreset } {
    const preset = this.presetFor(chunk);
    // The engine is part of the voice identity: the same preset sounds
    // completely different through Kokoro and through a cloud relay, so their
    // cached audio must not collide.
    const voiceId = `${this.mode}:${preset.id}`;
    return {
      key: audioKey({
        docId: this.doc!.id,
        chunkIndex: chunk.index,
        voiceId,
        textHash: hashText(chunk.text),
        modelVersion: `${MODEL_VERSION}:${kokoroClient.getStatus().dtype ?? 'auto'}`,
      }),
      voiceId,
      preset,
    };
  }

  /** Character voices: a chunk spoken by a known character uses their preset. */
  private presetFor(chunk: TextChunk): VoicePreset {
    if (chunk.speaker) {
      const override = this.characterPresets.get(chunk.speaker);
      if (override) return override;
    }
    return this.preset!;
  }

  /**
   * Resolve a chunk to playable audio: memory, then IndexedDB, then generate.
   * Concurrent callers for the same index share one operation.
   */
  private pendingEnsure = new Map<number, Promise<ReadyChunk>>();

  private ensureChunk(index: number): Promise<ReadyChunk> {
    const existing = this.ready.get(index);
    if (existing) return Promise.resolve(existing);

    const inProgress = this.pendingEnsure.get(index);
    if (inProgress) return inProgress;

    const task = this.doEnsureChunk(index).finally(() => {
      this.pendingEnsure.delete(index);
    });
    this.pendingEnsure.set(index, task);
    return task;
  }

  private async doEnsureChunk(index: number): Promise<ReadyChunk> {
    const chunk = this.chunks[index];
    if (!chunk || !this.doc) throw new Error('No such chunk');

    const { key, voiceId, preset } = this.keyFor(chunk);

    // 1. Already on disk from a previous session or an earlier listen.
    const cached = await getAudio(key);
    if (cached) {
      const entry = this.adopt(index, cached.blob, cached.durationSec);
      this.emit();
      return entry;
    }

    // 2. Generate.
    this.inflight = index;
    this.emit();

    try {
      const result = await this.generateWithRetry(chunk.text, preset);
      const entry = this.adopt(index, result.blob, result.durationSec);

      // Persisting must never interrupt listening, but a failure here means
      // this chunk will be regenerated later and, worse, that "prepare whole
      // book" is quietly not producing an offline copy - so it is recorded.
      void this.persist(key, voiceId, index, chunk.text, result);

      this.error = null;
      return entry;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error = this.friendlyError(message);
      this.emit();
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.inflight = null;
      this.emit();
    }
  }

  /** Write a generated chunk to disk and keep the cache within budget. */
  private async persist(
    key: string,
    voiceId: string,
    index: number,
    text: string,
    result: { blob: Blob; durationSec: number }
  ): Promise<void> {
    if (!this.doc) return;
    try {
      await putAudio({
        key,
        docId: this.doc.id,
        chunkIndex: index,
        voiceId,
        textHash: hashText(text),
        blob: result.blob,
        durationSec: result.durationSec,
        bytes: result.blob.size,
        createdAt: Date.now(),
      });
      this.storageFull = false;

      const budget = await cacheBudgetBytes(this.cacheBudgetGb);
      const { stillOver } = await enforceCacheBudget(budget, this.doc.id, this.keepOffline);
      // One book can legitimately exceed the budget on its own; that is worth
      // telling the user, because it is the point at which older books start
      // disappearing.
      if (stillOver) this.storageFull = true;
    } catch (err) {
      if (isQuotaError(err)) this.storageFull = true;
    }
    this.emit();
  }

  /**
   * Turn a raw failure into something the listener can act on.
   *
   * "Voice engine is not loaded" is true but useless; what the user needs to
   * know is whether to wait or to switch engines.
   */
  private friendlyError(raw: string): string {
    if (this.mode === 'kokoro') {
      const status = kokoroClient.getStatus();
      if (status.state === 'loading') {
        return 'Still downloading the AI voice model. Playback will start on its own once it is ready.';
      }
      if (status.state !== 'ready') {
        return 'The AI voice model could not load on this device. Switch to Device voices to keep listening.';
      }
      return `This section could not be generated (${raw}). Retry, or switch to Device voices.`;
    }
    if (this.mode === 'premium') {
      return `The premium voice relay failed (${raw}). Check the relay, or switch to Kokoro.`;
    }
    return `Voice generation failed: ${raw}`;
  }

  /**
   * Synthesise one chunk, with a single retry.
   *
   * A transient worker hiccup or a dropped relay request should cost a moment,
   * not the rest of the book.
   */
  private async generateWithRetry(
    text: string,
    preset: VoicePreset
  ): Promise<{ blob: Blob; durationSec: number }> {
    const once = (): Promise<{ blob: Blob; durationSec: number }> => {
      if (this.mode === 'premium') return generatePremium(text, preset);
      return kokoroClient.generate(text, preset.kokoroVoice ?? 'af_heart', preset.rateBias);
    };
    try {
      return await once();
    } catch {
      return await once();
    }
  }

  private adopt(index: number, blob: Blob, duration: number): ReadyChunk {
    const prior = this.ready.get(index);
    if (prior) URL.revokeObjectURL(prior.url);

    const entry: ReadyChunk = {
      url: URL.createObjectURL(blob),
      duration,
      bytes: blob.size,
    };
    this.ready.set(index, entry);
    this.durations.set(index, duration);
    this.trimMemory();
    this.preloadNext();
    return entry;
  }

  private dropChunk(index: number): void {
    const entry = this.ready.get(index);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    this.ready.delete(index);
  }

  /**
   * Release object URLs outside the working window.
   *
   * Without this a multi-hour book leaks every blob it ever decoded, which is
   * exactly how long listening sessions die on phones.
   */
  private trimMemory(): void {
    const low = this.chunkIndex - MEM_BEHIND;
    const high = this.chunkIndex + MEM_AHEAD;
    for (const [index, entry] of this.ready) {
      if (index < low || index > high) {
        // Never revoke what is currently loaded in the element.
        if (this.audio && this.audio.src === entry.url) continue;
        URL.revokeObjectURL(entry.url);
        this.ready.delete(index);
      }
    }
  }

  private flushMemory(): void {
    for (const [, entry] of this.ready) URL.revokeObjectURL(entry.url);
    this.ready.clear();
  }

  /* ---------------------------------------------------------------- *
   * Device (Web Speech) fallback
   * ---------------------------------------------------------------- */

  /**
   * Speak a chunk with the platform's own TTS.
   *
   * This exists as a guaranteed-available fallback. It cannot be buffered,
   * cached, or reliably continued with the screen locked - those limits are
   * inherent to the Web Speech API, not to this implementation.
   */
  private speakDevice(index: number): void {
    const synth = window.speechSynthesis;
    const chunk = this.chunks[index];
    if (!synth || !chunk) return;

    synth.cancel();

    const utter = new SpeechSynthesisUtterance(chunk.text);
    const preset = this.presetFor(chunk);
    utter.rate = Math.max(0.1, Math.min(10, this.rate * preset.rateBias));
    utter.pitch = preset.pitch;
    utter.volume = this.volume;

    const voice = matchSystemVoice(preset, synth.getVoices(), this.deviceVoiceURI);
    if (voice) utter.voice = voice;

    utter.onboundary = (e) => {
      this.charOffset = e.charIndex;
      this.emit();
    };

    utter.onend = () => {
      if (!this.wantPlaying) return;
      const next = index + 1;
      if (next >= this.chunks.length) {
        this.handleFinished();
        return;
      }
      this.chunkIndex = next;
      this.charOffset = 0;
      this.savePosition(false);
      this.updateMetadata();
      this.emit();
      this.speakDevice(next);
    };

    utter.onerror = (e) => {
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      this.error = `Device voice error: ${e.error}`;
      this.status = 'error';
      this.emit();
    };

    synth.speak(utter);
  }

  /* ---------------------------------------------------------------- *
   * Sleep timer
   * ---------------------------------------------------------------- */

  setSleepTimer(minutes: number | 'chapter' | null): void {
    this.clearSleepTimer();
    if (minutes === null) {
      this.emit();
      return;
    }
    if (minutes === 'chapter') {
      this.sleepAtChapterEnd = true;
      this.sleepEndsAt = null;
      this.emit();
      return;
    }
    this.sleepEndsAt = Date.now() + minutes * 60_000;
    this.sleepTimer = setTimeout(() => this.beginSleepFade(), minutes * 60_000);
    this.emit();
  }

  /** Fade out over several seconds rather than cutting off mid-word. */
  private beginSleepFade(): void {
    const el = this.audio;
    const startVolume = this.volume;
    const steps = 40;
    const stepMs = 200;
    let step = 0;

    this.sleepFade = setInterval(() => {
      step += 1;
      const factor = Math.max(0, 1 - step / steps);
      if (el) el.volume = startVolume * factor;
      if (step >= steps) {
        this.clearSleepTimer();
        this.pause();
        if (el) el.volume = startVolume;
      }
    }, stepMs);
  }

  private clearSleepTimer(): void {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    if (this.sleepFade) clearInterval(this.sleepFade);
    this.sleepTimer = null;
    this.sleepFade = null;
    this.sleepEndsAt = null;
    this.sleepAtChapterEnd = false;
  }

  /* ---------------------------------------------------------------- *
   * Derived values
   * ---------------------------------------------------------------- */

  private currentChapterIndex(): number {
    return this.chunks[this.chunkIndex]?.chapterIndex ?? 0;
  }

  private currentDuration(): number {
    return this.ready.get(this.chunkIndex)?.duration ?? this.durations.get(this.chunkIndex) ?? 0;
  }

  /** Real durations where known, estimates elsewhere. */
  private elapsedSec(): number {
    let total = 0;
    for (let i = 0; i < this.chunkIndex; i++) total += this.durations.get(i) ?? 0;
    return total + (this.audio?.currentTime ?? 0);
  }

  private totalSec(): number {
    let total = 0;
    for (const chunk of this.chunks) total += this.durations.get(chunk.index) ?? chunk.estSeconds;
    return total;
  }

  private savePosition(force: boolean): void {
    if (!this.onPositionSave) return;
    const now = Date.now();
    if (!force && now - this.lastSavedAt < 3000) return;
    this.lastSavedAt = now;
    this.onPositionSave(this.chunkIndex, this.audio?.currentTime ?? 0);
  }

  /* ---------------------------------------------------------------- *
   * Bulk preparation
   * ---------------------------------------------------------------- */

  /**
   * Generate and cache a range of chunks ahead of time.
   *
   * For listening somewhere with no signal, or on a phone that will be locked
   * for a long stretch. Playback always outranks this: before each bulk chunk
   * we top the live buffer back up, so preparing a whole book never starves the
   * audio that is actually playing.
   */
  async prepareRange(
    scope: 'chapter' | 'book',
    onProgress: (done: number, total: number) => void,
    shouldCancel: () => boolean
  ): Promise<{ done: number; total: number; failed: number }> {
    if (this.mode === 'device') {
      throw new Error('Device voices are generated as they play and cannot be prepared ahead.');
    }

    let from = 0;
    let to = this.chunks.length - 1;
    if (scope === 'chapter') {
      const chapter = this.currentChapterIndex();
      from = this.chapterStarts[chapter] ?? 0;
      const nextStart = this.chapterStarts[chapter + 1];
      to = nextStart === undefined ? this.chunks.length - 1 : nextStart - 1;
    }

    const total = Math.max(0, to - from + 1);
    let done = 0;
    let failed = 0;

    for (let i = from; i <= to; i++) {
      if (shouldCancel() || this.destroyed) break;

      // Keep live playback fed first.
      let guard = 0;
      while (
        this.wantPlaying &&
        this.bufferedSec() < this.bufferTarget() &&
        guard < 4 &&
        !shouldCancel()
      ) {
        guard++;
        await this.pump();
      }

      try {
        await this.ensureChunk(i);
      } catch {
        failed++;
      }
      done++;
      onProgress(done, total);
      // Yield so the UI can paint progress and stay responsive.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return { done, total, failed };
  }

  /** How much of a range is already cached, for showing readiness up front. */
  async cachedCount(scope: 'chapter' | 'book'): Promise<{ cached: number; total: number }> {
    let from = 0;
    let to = this.chunks.length - 1;
    if (scope === 'chapter') {
      const chapter = this.currentChapterIndex();
      from = this.chapterStarts[chapter] ?? 0;
      const nextStart = this.chapterStarts[chapter + 1];
      to = nextStart === undefined ? this.chunks.length - 1 : nextStart - 1;
    }
    if (!this.doc) return { cached: 0, total: 0 };

    const keys: string[] = [];
    for (let i = from; i <= to; i++) {
      const chunk = this.chunks[i];
      if (chunk) keys.push(this.keyFor(chunk).key);
    }
    const present = await hasAudioKeys(keys);
    return { cached: present.size, total: keys.length };
  }

  /** Force an immediate position write, e.g. when the app is backgrounded. */
  savePositionNow(): void {
    this.savePosition(true);
  }

  destroy(): void {
    this.destroyed = true;
    this.stopInternal();
    this.flushMemory();
    clearMediaHandlers();
    this.listeners.clear();
    this.audio = null;
    this.preloader = null;
  }
}

export const engine = new AudiobookEngine();
