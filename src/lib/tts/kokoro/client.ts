import type { EngineStatus, KokoroDevice } from '../../../types';
import { abandonIsolation } from '../isolation';
import type { EnginePreference, FromWorker, KokoroDtype, ToWorker } from './protocol';

/**
 * Main-thread handle on the Kokoro worker.
 *
 * A single shared instance: the model is ~92 MB in memory, so a second copy
 * would be a fast route to an out-of-memory crash on a phone.
 */

export interface GenerateResult {
  blob: Blob;
  durationSec: number;
  genMs: number;
}

type StatusListener = (status: EngineStatus) => void;

/**
 * Turn a raw load failure into something a listener can act on.
 *
 * "Failed to fetch" is what the browser says when the model download is
 * blocked, offline, or filtered; on its own it tells the user nothing about
 * what to do next.
 */
function describeInitFailure(raw: string): string {
  if (/failed to fetch|networkerror|load failed|err_|fetch/i.test(raw)) {
    return 'The voice model could not be downloaded. Check your connection, then try again - or use Device voices in the meantime.';
  }
  if (/quota|storage/i.test(raw)) {
    return 'There is not enough free storage to install the voice model. Free some space, or use Device voices.';
  }
  if (/wasm|webassembly|gpu|shader/i.test(raw)) {
    return `This browser could not start the voice engine (${raw}). Device voices will still work.`;
  }
  return `The voice engine could not start: ${raw}`;
}

interface Pending {
  resolve: (r: GenerateResult) => void;
  reject: (e: Error) => void;
}

class KokoroClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<StatusListener>();
  private initCalled = false;

  private status: EngineStatus = {
    state: 'idle',
    device: null,
    dtype: null,
    threads: null,
    progress: 0,
    message: '',
    rtf: null,
  };

  getStatus(): EngineStatus {
    return this.status;
  }

  subscribe(fn: StatusListener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private setStatus(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  /**
   * Start loading the model *if it has already been downloaded once*.
   *
   * Waiting for the first Play to start a 92 MB download is the difference
   * between an app that speaks instantly on the second visit and one that
   * always makes you wait. Warming only what is already on the device keeps
   * that win without spending a stranger's mobile data on a maybe.
   */
  async warmIfCached(): Promise<void> {
    if (this.initCalled || typeof caches === 'undefined') return;
    try {
      for (const name of await caches.keys()) {
        if (!/transformers/i.test(name)) continue;
        const cache = await caches.open(name);
        const hit = (await cache.keys()).some((req) => req.url.includes('Kokoro-82M'));
        if (hit) {
          this.init();
          return;
        }
      }
    } catch {
      /* no Cache Storage: the model loads on demand, as before */
    }
  }

  /** Cross-origin isolation is not required, but WASM threads are faster with it. */
  static isSupported(): boolean {
    return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    // Vite rewrites this to a hashed module-worker URL at build time.
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'narrato-kokoro',
    });

    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    this.worker.onerror = (e) => {
      this.setStatus({
        state: 'error',
        message: e.message || 'Voice engine worker failed to start',
      });
      // Every in-flight generation is now unanswerable.
      for (const [, p] of this.pending) p.reject(new Error('Voice engine stopped'));
      this.pending.clear();
    };

    return this.worker;
  }

  private handle(msg: FromWorker): void {
    switch (msg.type) {
      case 'progress':
        this.setStatus({ state: 'loading', progress: msg.progress, message: msg.message });
        break;

      case 'ready':
        this.setStatus({
          state: 'ready',
          device: msg.device,
          dtype: msg.dtype,
          threads: msg.threads,
          progress: 1,
          message:
            `Ready (${msg.device.toUpperCase()} / ${msg.dtype}` +
            (msg.threads > 1 ? `, ${msg.threads} threads)` : ')'),
        });
        break;

      case 'initError': {
        // Isolation is what gives us threads, but it also changes how
        // cross-origin requests are made. If the model cannot be fetched on an
        // isolated page, isolation is the likeliest cause and speed is not
        // worth a silent app: drop it and reload once, unisolated.
        if (/failed to fetch|networkerror|load failed|blocked/i.test(msg.message)) {
          void abandonIsolation();
        }
        const friendly = describeInitFailure(msg.message);
        this.setStatus({ state: 'error', message: friendly });
        for (const [, p] of this.pending) p.reject(new Error(friendly));
        this.pending.clear();
        break;
      }

      case 'result': {
        const pending = this.pending.get(msg.id);
        if (!pending) break;
        this.pending.delete(msg.id);

        // Track a rolling real-time factor: audio seconds produced per second
        // of compute. The buffer planner uses it to decide how far ahead to run.
        if (msg.genMs > 0 && msg.durationSec > 0) {
          const sample = msg.durationSec / (msg.genMs / 1000);
          const prev = this.status.rtf;
          this.setStatus({ rtf: prev === null ? sample : prev * 0.7 + sample * 0.3 });
        }

        pending.resolve({
          blob: new Blob([msg.wav], { type: 'audio/wav' }),
          durationSec: msg.durationSec,
          genMs: msg.genMs,
        });
        break;
      }

      case 'genError': {
        const pending = this.pending.get(msg.id);
        if (!pending) break;
        this.pending.delete(msg.id);
        pending.reject(new Error(msg.message));
        break;
      }
    }
  }

  /** Start loading the model. Safe to call repeatedly; only the first call acts. */
  init(pref: EnginePreference = { device: 'auto', dtype: 'auto' }): void {
    if (!KokoroClient.isSupported()) {
      this.setStatus({
        state: 'unsupported',
        message: 'This browser cannot run the on-device voice engine.',
      });
      return;
    }
    if (this.initCalled) return;
    this.initCalled = true;
    this.setStatus({ state: 'loading', progress: 0, message: 'Starting voice engine' });
    this.send({ type: 'init', pref });
  }

  /** Reload with different settings (user changed device/dtype in Settings). */
  reinit(pref: EnginePreference): void {
    this.dispose();
    this.initCalled = false;
    this.status = {
      state: 'idle', device: null, dtype: null, threads: null,
      progress: 0, message: '', rtf: null,
    };
    this.init(pref);
  }

  private send(msg: ToWorker): void {
    this.ensureWorker().postMessage(msg);
  }

  generate(text: string, voice: string, speed: number): Promise<GenerateResult> {
    const id = this.nextId++;
    return new Promise<GenerateResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'generate', id, text, voice, speed });
    });
  }

  /** Abandon a generation. The worker drops the result if it lands late. */
  cancel(id: number): void {
    this.send({ type: 'cancel', id });
  }

  /** Measure this device once so chunk size and buffer targets can adapt to it. */
  benchmark(): Promise<GenerateResult> {
    const id = this.nextId++;
    return new Promise<GenerateResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'benchmark', id });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

export const kokoroClient = new KokoroClient();
export type { EnginePreference, KokoroDevice, KokoroDtype };
