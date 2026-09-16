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

export async function cacheBudgetBytes(preferredGb: number): Promise<number> {
  return Math.min(preferredGb, MAX_CACHE_BUDGET_GB) * 1024 * 1024 * 1024;
}

export const MAX_CACHE_BUDGET_GB = 10;

/** Records what the engine asked to protect, so tests can assert on it. */
export const lastEviction = {
  budget: 0,
  protectDocId: null as string | null,
  keepDocIds: new Set<string>(),
  calls: 0,
};

export async function enforceCacheBudget(
  budgetBytes: number,
  protectDocId: string | null,
  keepDocIds: ReadonlySet<string> = new Set()
): Promise<{ freed: number; stillOver: boolean }> {
  lastEviction.budget = budgetBytes;
  lastEviction.protectDocId = protectDocId;
  lastEviction.keepDocIds = new Set(keepDocIds);
  lastEviction.calls++;
  return { freed: 0, stillOver: overBudget };
}

export async function audioStatsByDoc(): Promise<Map<string, { count: number; bytes: number }>> {
  const out = new Map<string, { count: number; bytes: number }>();
  for (const v of store.values()) {
    const prev = out.get(v.docId) ?? { count: 0, bytes: 0 };
    prev.count += 1;
    prev.bytes += v.bytes;
    out.set(v.docId, prev);
  }
  return out;
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
