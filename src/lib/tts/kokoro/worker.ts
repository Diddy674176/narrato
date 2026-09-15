/// <reference lib="webworker" />
import { KokoroTTS } from 'kokoro-js';
import type { KokoroDevice, KokoroVoiceId } from '../../../types';
import type { EnginePreference, FromWorker, KokoroDtype, ToWorker } from './protocol';
import { KOKORO_MODEL_ID } from './protocol';

/**
 * Kokoro inference worker.
 *
 * Speech generation runs here, never on the UI thread: a single chunk can take
 * several seconds of solid compute, and doing that on the main thread would
 * freeze scrolling and - worse - stall the audio element's own event handling,
 * which is exactly what causes the "generate, wait, stutter" feel.
 */

// Declaring the handful of worker globals we use avoids pulling in the
// WebWorker lib alongside DOM, which would produce duplicate declarations.
declare const self: {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: { data: ToWorker }) => void) | null;
  navigator: { gpu?: unknown; hardwareConcurrency?: number; userAgent?: string };
};

let tts: KokoroTTS | null = null;
let initPromise: Promise<void> | null = null;
let activeDevice: KokoroDevice = 'wasm';
let activeDtype: KokoroDtype = 'q8';

/** Generations the main thread gave up on; results are dropped. */
const cancelled = new Set<number>();

function post(msg: FromWorker, transfer?: Transferable[]): void {
  self.postMessage(msg, transfer);
}

function hasWebGpu(): boolean {
  return typeof self.navigator !== 'undefined' && 'gpu' in self.navigator && !!self.navigator.gpu;
}

function looksMobile(): boolean {
  const ua = self.navigator?.userAgent ?? '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

/**
 * Resolve 'auto' into a concrete device/dtype pair.
 *
 * WebGPU is much faster, but the fp32 weights it works best with are a 326 MB
 * download - unacceptable over mobile data. So phones default to WASM + q8
 * (92 MB) even when WebGPU exists, and desktops take the fast path. The user
 * can override both in Settings.
 */
function resolvePreference(pref: EnginePreference): { device: KokoroDevice; dtype: KokoroDtype } {
  let device: KokoroDevice;
  if (pref.device === 'auto') {
    device = hasWebGpu() && !looksMobile() ? 'webgpu' : 'wasm';
  } else {
    device = pref.device;
  }
  if (device === 'webgpu' && !hasWebGpu()) device = 'wasm';

  let dtype: KokoroDtype;
  if (pref.dtype === 'auto') {
    dtype = device === 'webgpu' ? 'fp32' : 'q8';
  } else {
    dtype = pref.dtype;
  }

  return { device, dtype };
}

async function loadWith(device: KokoroDevice, dtype: KokoroDtype): Promise<KokoroTTS> {
  const fileProgress = new Map<string, number>();

  return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    dtype,
    device,
    progress_callback: (item: unknown) => {
      const p = item as { status?: string; file?: string; progress?: number };
      if (p.status === 'progress' && typeof p.progress === 'number' && p.file) {
        fileProgress.set(p.file, p.progress);
      } else if (p.status === 'done' && p.file) {
        fileProgress.set(p.file, 100);
      }
      if (fileProgress.size > 0) {
        let total = 0;
        for (const v of fileProgress.values()) total += v;
        post({
          type: 'progress',
          progress: Math.min(1, total / (fileProgress.size * 100)),
          message: 'Downloading free AI voice model',
        });
      }
    },
  });
}

async function init(pref: EnginePreference): Promise<void> {
  const primary = resolvePreference(pref);

  post({ type: 'progress', progress: 0, message: 'Starting voice engine' });

  try {
    tts = await loadWith(primary.device, primary.dtype);
    activeDevice = primary.device;
    activeDtype = primary.dtype;
  } catch (err) {
    // WebGPU initialisation fails on plenty of real devices (driver blocklists,
    // missing shader features). Fall back to the universally supported path
    // rather than leaving the user with no voice at all.
    const fallbackNeeded = primary.device !== 'wasm' || primary.dtype !== 'q8';
    if (!fallbackNeeded) throw err;

    post({
      type: 'progress',
      progress: 0,
      message: 'Hardware acceleration unavailable, switching to compatibility mode',
    });
    tts = await loadWith('wasm', 'q8');
    activeDevice = 'wasm';
    activeDtype = 'q8';
  }

  post({ type: 'ready', device: activeDevice, dtype: activeDtype });
}

async function ensureReady(): Promise<KokoroTTS> {
  if (tts) return tts;
  if (initPromise) {
    await initPromise;
    if (tts) return tts;
  }
  throw new Error('Voice engine is not loaded');
}

async function generate(msg: Extract<ToWorker, { type: 'generate' }>): Promise<void> {
  try {
    const engine = await ensureReady();
    if (cancelled.has(msg.id)) {
      cancelled.delete(msg.id);
      return;
    }

    const started = Date.now();
    const audio = await engine.generate(msg.text, {
      voice: msg.voice as KokoroVoiceId,
      speed: msg.speed,
    });
    const genMs = Date.now() - started;

    if (cancelled.has(msg.id)) {
      cancelled.delete(msg.id);
      return;
    }

    const durationSec = audio.audio.length / audio.sampling_rate;
    const wav = audio.toWav();

    // Transfer rather than copy: a minute of 24 kHz 16-bit WAV is ~2.8 MB and
    // copying it per chunk adds avoidable GC pressure on phones.
    post({ type: 'result', id: msg.id, wav, durationSec, genMs }, [wav]);
  } catch (err) {
    cancelled.delete(msg.id);
    post({
      type: 'genError',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Short benchmark used to size chunks and buffer targets for this device.
 * Deliberately tiny - it runs once and its result is cached.
 */
const BENCHMARK_TEXT =
  'The harbour bell rang twice before the fog lifted, and the ship slipped quietly out to sea.';

async function benchmark(id: number): Promise<void> {
  try {
    const engine = await ensureReady();
    const started = Date.now();
    const audio = await engine.generate(BENCHMARK_TEXT, {
      voice: 'af_heart' as KokoroVoiceId,
      speed: 1,
    });
    const genMs = Date.now() - started;
    const durationSec = audio.audio.length / audio.sampling_rate;
    post({ type: 'result', id, wav: new ArrayBuffer(0), durationSec, genMs });
  } catch (err) {
    post({
      type: 'genError',
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

self.onmessage = (e: { data: ToWorker }) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      if (!initPromise) {
        initPromise = init(msg.pref).catch((err: unknown) => {
          post({
            type: 'initError',
            message: err instanceof Error ? err.message : String(err),
          });
          // Allow a later retry (e.g. after the user picks a different engine).
          initPromise = null;
        });
      }
      break;
    case 'generate':
      void generate(msg);
      break;
    case 'benchmark':
      void benchmark(msg.id);
      break;
    case 'cancel':
      cancelled.add(msg.id);
      break;
  }
};
