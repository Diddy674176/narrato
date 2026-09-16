// In-memory stand-in for the IndexedDB layer.
export interface CachedAudio {
  key: string; docId: string; chunkIndex: number; voiceId: string;
  textHash: string; blob: Blob; durationSec: number; bytes: number; createdAt: number;
}
export const store = new Map<string, CachedAudio>();
export const stats = { reads: 0, writes: 0 };

export function audioKey(p: { docId: string; chunkIndex: number; voiceId: string; textHash: string; modelVersion: string }): string {
  return [p.docId, p.chunkIndex, p.voiceId, p.textHash, p.modelVersion].join('|');
}
export async function getAudio(key: string): Promise<CachedAudio | undefined> {
  stats.reads++;
  return store.get(key);
}
/** When set, putAudio rejects as the browser does when storage is full. */
export let quotaFull = false;
export function setQuotaFull(v: boolean): void { quotaFull = v; }

/** When set, enforceCacheBudget reports it could not get under budget. */
export let overBudget = false;
export function setOverBudget(v: boolean): void { overBudget = v; }

export async function putAudio(entry: CachedAudio): Promise<void> {
  if (quotaFull) {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';
    throw err;
  }
  stats.writes++;
  store.set(entry.key, entry);
}

export const AUDIO_BYTES_PER_SEC = 24_000 * 2;

export async function cacheBudgetBytes(): Promise<number> {
  return 512 * 1024 * 1024;
}

export async function enforceCacheBudget(): Promise<{ freed: number; stillOver: boolean }> {
  return { freed: 0, stillOver: overBudget };
}

export function isQuotaError(err: unknown): boolean {
  return err instanceof Error && /quota/i.test(err.name + err.message);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  return { usage: 0, quota: 4 * 1024 * 1024 * 1024 };
}

export async function hasAudioKeys(keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const k of keys) if (store.has(k)) found.add(k);
  return found;
}
