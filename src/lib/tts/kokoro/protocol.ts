import type { KokoroDevice } from '../../../types';

/**
 * Message protocol between the main thread and the Kokoro worker.
 *
 * Kept in its own module so both sides import the same definitions and a
 * mismatch becomes a type error rather than a silent runtime hang.
 */

export type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

export interface EnginePreference {
  device: 'auto' | KokoroDevice;
  dtype: KokoroDtype | 'auto';
}

export type ToWorker =
  | { type: 'init'; pref: EnginePreference }
  | { type: 'generate'; id: number; text: string; voice: string; speed: number }
  | { type: 'benchmark'; id: number }
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'progress'; progress: number; message: string }
  | { type: 'ready'; device: KokoroDevice; dtype: KokoroDtype }
  | { type: 'initError'; message: string }
  | {
      type: 'result';
      id: number;
      wav: ArrayBuffer;
      durationSec: number;
      genMs: number;
    }
  | { type: 'genError'; id: number; message: string };

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/**
 * Bumped whenever a change would alter generated waveforms, so stale cached
 * audio is never mixed with newly generated audio.
 */
export const MODEL_VERSION = 'kokoro-1.0';

/** Approximate download size per dtype, shown before the first download. */
export const DTYPE_SIZE_MB: Record<KokoroDtype, number> = {
  fp32: 326,
  fp16: 163,
  q8: 92,
  q4: 55,
  q4f16: 50,
};
