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

/** What the runtime can tell us about the machine, for engine selection. */
export interface DeviceCapabilities {
  hasWebGpu: boolean;
  isMobile: boolean;
  /** navigator.hardwareConcurrency, or 0 when unknown. */
  cores: number;
}

/**
 * Resolve 'auto' into a concrete device/dtype pair.
 *
 * Auto deliberately picks the *verified* path - WASM + q8 - on every device,
 * including flagships whose GPU would be faster. Kokoro's WebGPU output is
 * only as good as the browser's WebGPU fp16 support, and a reader reported
 * badly distorted speech on a current flagship phone that auto had put on
 * WebGPU. Speech that is fast and unlistenable is worth nothing, and nothing
 * available here can verify browser WebGPU output: CI checks the weights on
 * CPU, which is a different backend entirely.
 *
 * WebGPU therefore stays a deliberate choice in Settings rather than a default
 * inflicted on people, and an initialisation failure still falls back to
 * WASM + q8.
 */
export function resolveEnginePreference(
  pref: EnginePreference,
  caps: DeviceCapabilities
): { device: KokoroDevice; dtype: KokoroDtype } {
  const device: KokoroDevice =
    pref.device === 'auto' || (pref.device === 'webgpu' && !caps.hasWebGpu)
      ? 'wasm'
      : pref.device;

  let dtype: KokoroDtype;
  if (pref.dtype === 'auto') {
    // A GPU computes in fp16 natively, and on a phone it also halves a
    // one-time download; WASM takes the small quantised weights.
    if (device === 'webgpu') dtype = caps.isMobile ? 'fp16' : 'fp32';
    else dtype = 'q8';
  } else {
    dtype = pref.dtype;
  }

  return { device, dtype };
}
