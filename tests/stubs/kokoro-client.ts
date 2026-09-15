// Fake Kokoro client: records the order chunks were requested in.
export const calls: string[] = [];
export const requested: number[] = [];
export let failNext = 0;
export function setFailNext(n: number): void { failNext = n; }

/** Text length maps to a plausible audio duration (~15 chars/second). */
function durationFor(text: string): number { return Math.max(1, text.length / 15); }

export const kokoroClient = {
  getStatus() { return { state: 'ready', device: 'wasm', progress: 1, message: '', rtf: 4 }; },
  subscribe(fn: (s: unknown) => void) { fn(this.getStatus()); return () => {}; },
  init() {},
  reinit() {},
  async generate(text: string, voice: string) {
    calls.push(`${voice}:${text.slice(0, 12)}`);
    const m = /__IDX(\d+)__/.exec(text);
    if (m) requested.push(Number(m[1]));
    if (failNext > 0) { failNext--; throw new Error('simulated failure'); }
    await new Promise((r) => setTimeout(r, 1));
    return { blob: new Blob([new Uint8Array(1024)], { type: 'audio/wav' }), durationSec: durationFor(text), genMs: 10 };
  },
  cancel() {},
  benchmark() { return this.generate('bench', 'af_heart'); },
  dispose() {},
};
